package push

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/comamessenger/comamessenger/core/internal/config"
	"github.com/comamessenger/comamessenger/core/internal/identity"
	"github.com/comamessenger/comamessenger/core/internal/message"
	"github.com/comamessenger/comamessenger/core/internal/testdb"
	"github.com/google/uuid"
)

// "Without sound" still notifies: the job, the deliveries and the
// recipient's rules are those of an ordinary message, and every channel
// carries the quiet flag.
func TestSilentMessagesNotifyQuietly(t *testing.T) {
	pool := testdb.New(t)
	ctx := context.Background()
	orgID, senderID, recipientID := uuid.NewString(), uuid.NewString(), uuid.NewString()
	groupID, directID, sessionID := uuid.NewString(), uuid.NewString(), uuid.NewString()
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	for _, statement := range []struct {
		query string
		args  []any
	}{
		{`INSERT INTO organizations(id,name,slug) VALUES($1,'Silent','silent')`, []any{orgID}},
		{`INSERT INTO actors(id,org_id,type,org_role,display_name,handle) VALUES ($2,$1,'user','owner','Sender','sender'),($3,$1,'user','member','Recipient','recipient')`, []any{orgID, senderID, recipientID}},
		// The recipient only wants direct messages and mentions.
		{`INSERT INTO users(actor_id,org_id,email,password_hash,preferences) VALUES ($2,$1,'sender@example.test','hash','{}'),($3,$1,'recipient@example.test','hash','{"notify_messages":"direct_and_mentions"}')`, []any{orgID, senderID, recipientID}},
		{`INSERT INTO sessions(id,org_id,actor_id,family_id,refresh_hash,expires_at) VALUES($3,$1,$2,$3,decode(repeat('01',32),'hex'),now()+interval '1 day')`, []any{orgID, recipientID, sessionID}},
		{`INSERT INTO chats(id,org_id,kind,visibility,name,created_by) VALUES($3,$1,'group','private','Quiet',$2)`, []any{orgID, senderID, groupID}},
		{`INSERT INTO chats(id,org_id,kind,visibility,direct_pair_key,created_by) VALUES($3,$1,'direct','private','sender:recipient',$2)`, []any{orgID, senderID, directID}},
		{`INSERT INTO chat_members(chat_id,actor_id,org_id,role) VALUES ($3,$2,$1,'owner'),($3,$4,$1,'member'),($5,$2,$1,'member'),($5,$4,$1,'member')`, []any{orgID, senderID, groupID, recipientID, directID}},
		{`INSERT INTO web_push_subscriptions(id,org_id,actor_id,session_id,endpoint,p256dh,auth) VALUES($4,$1,$2,$3,'https://push.example.test/r','0123456789abcdef','0123456789abcdef')`, []any{orgID, recipientID, sessionID, uuid.NewString()}},
	} {
		if _, err := tx.Exec(ctx, statement.query, statement.args...); err != nil {
			_ = tx.Rollback(ctx)
			t.Fatal(err)
		}
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	cfg := config.PushConfig{RelayURL: "https://relay.example.test", PollInterval: time.Second}
	key := []byte(strings.Repeat("k", 32))
	if _, err := NewService(pool, cfg).RegisterMobileDevice(ctx, identity.User{OrgID: orgID, ActorID: recipientID}, sessionID, MobileDeviceInput{
		Platform: "ios", RelayHandle: strings.Repeat("q", 43), NotificationKey: base64.StdEncoding.EncodeToString(key), AppVersion: "0.1.0",
	}); err != nil {
		t.Fatal(err)
	}
	messages := message.NewService(pool, 1024, 100, nil)
	sender := identity.User{ActorID: senderID, OrgID: orgID, OrgRole: "owner", Status: "active"}
	relay := &recordingRelay{}
	worker := NewWorker(slog.New(slog.NewTextHandler(io.Discard, nil)), pool, cfg, nil).WithRelay(relay)
	count := func(query string) int {
		var value int
		if err := pool.QueryRow(ctx, query).Scan(&value); err != nil {
			t.Fatal(err)
		}
		return value
	}
	send := func(chatID string, input message.CreateInput) {
		t.Helper()
		input.ClientMsgID, input.Silent = uuid.NewString(), true
		if _, _, err := messages.Create(ctx, sender, chatID, input); err != nil {
			t.Fatal(err)
		}
		if err := worker.materialize(ctx); err != nil {
			t.Fatal(err)
		}
	}

	// A plain group message: the recipient's settings say no, quiet or not.
	send(groupID, message.CreateInput{Body: "fyi"})
	if got := count(`SELECT count(*) FROM mobile_push_deliveries`); got != 0 {
		t.Fatalf("settings ignored: deliveries = %d", got)
	}
	// A mention and a direct message notify, quietly, on web and mobile.
	send(groupID, message.CreateInput{Body: "@recipient", MentionedActorIDs: []string{recipientID}})
	send(directID, message.CreateInput{Body: "psst"})
	if got := count(`SELECT count(*) FROM mobile_push_deliveries`); got != 2 {
		t.Fatalf("mobile deliveries = %d, want 2", got)
	}
	if got := count(`SELECT count(*) FROM notification_deliveries`); got != 2 {
		t.Fatalf("web deliveries = %d, want 2", got)
	}
	if err := worker.deliverMobile(ctx); err != nil {
		t.Fatal(err)
	}
	if len(relay.messages) != 2 {
		t.Fatalf("relay messages = %d", len(relay.messages))
	}
	for _, sent := range relay.messages {
		if !sent.Silent || !openPayload(t, key, sent.Ciphertext).Silent {
			t.Fatalf("mobile notification is not quiet: %+v", sent)
		}
	}
	var payload map[string]any
	if err := json.Unmarshal(webPushPayload(notificationContent{Title: "t", Body: "b"}, true), &payload); err != nil || payload["silent"] != true {
		t.Fatalf("web push payload = %v", payload)
	}
	payload = nil
	if err := json.Unmarshal(webPushPayload(notificationContent{Title: "t", Body: "b"}, false), &payload); err != nil {
		t.Fatal(err)
	}
	if _, quiet := payload["silent"]; quiet {
		t.Fatal("ordinary web push marked silent")
	}

	// An ordinary message is not quiet.
	if _, _, err := messages.Create(ctx, sender, directID, message.CreateInput{ClientMsgID: uuid.NewString(), Body: "hello"}); err != nil {
		t.Fatal(err)
	}
	if err := worker.materialize(ctx); err != nil {
		t.Fatal(err)
	}
	if err := worker.deliverMobile(ctx); err != nil {
		t.Fatal(err)
	}
	if last := relay.messages[len(relay.messages)-1]; last.Silent || openPayload(t, key, last.Ciphertext).Silent {
		t.Fatal("ordinary message notified quietly")
	}
}

// An agent may not make its messages quiet, whatever path it takes.
func TestAgentsCannotSendSilently(t *testing.T) {
	pool := testdb.New(t)
	ctx := context.Background()
	orgID, ownerID, agentID, chatID := uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString()
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	for _, statement := range []struct {
		query string
		args  []any
	}{
		{`INSERT INTO organizations(id,name,slug) VALUES($1,'Agents','agents')`, []any{orgID}},
		{`INSERT INTO actors(id,org_id,type,org_role,display_name,handle) VALUES ($2,$1,'user','owner','Owner','owner'),($3,$1,'agent','member','Bot','bot')`, []any{orgID, ownerID, agentID}},
		{`INSERT INTO users(actor_id,org_id,email,password_hash) VALUES ($2,$1,'owner@example.test','hash')`, []any{orgID, ownerID}},
		{`INSERT INTO agents(actor_id,org_id,owner_actor_id,kind) VALUES ($3,$1,$2,'builtin')`, []any{orgID, ownerID, agentID}},
		{`INSERT INTO chats(id,org_id,kind,visibility,name,created_by) VALUES($3,$1,'group','private','Room',$2)`, []any{orgID, ownerID, chatID}},
		{`INSERT INTO chat_members(chat_id,actor_id,org_id,role) VALUES ($4,$2,$1,'owner'),($4,$3,$1,'member')`, []any{orgID, ownerID, agentID, chatID}},
	} {
		if _, err := tx.Exec(ctx, statement.query, statement.args...); err != nil {
			_ = tx.Rollback(ctx)
			t.Fatalf("%s: %v", statement.query, err)
		}
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	messages := message.NewService(pool, 1024, 100, nil)
	agent := identity.User{ActorID: agentID, OrgID: orgID, OrgRole: "member", Status: "active"}
	quiet := message.CreateInput{ClientMsgID: uuid.NewString(), Body: "beep", Silent: true}
	if _, _, err := messages.Create(ctx, agent, chatID, quiet); !errors.Is(err, message.ErrForbidden) {
		t.Fatalf("agent Create(silent) error = %v", err)
	}
	if _, _, err := messages.CreateForAgentRun(ctx, agent, chatID, quiet, message.AgentProvenance{RunID: uuid.NewString()}); !errors.Is(err, message.ErrForbidden) {
		t.Fatalf("agent run Create(silent) error = %v", err)
	}
}

// A relay from before quiet notifications refuses the unknown field; the
// core then sends once more without it.
func TestHTTPRelayFallsBackForOlderRelays(t *testing.T) {
	var bodies []map[string]any
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		bodies = append(bodies, body)
		if _, ok := body["silent"]; ok {
			http.Error(w, "invalid request", http.StatusBadRequest)
			return
		}
		w.WriteHeader(http.StatusAccepted)
	}))
	defer server.Close()
	relay := NewHTTPRelay(server.URL, server.Client())
	if err := relay.Send(context.Background(), RelayMessage{Handle: "h", Ciphertext: "c", Silent: true}); err != nil {
		t.Fatal(err)
	}
	if len(bodies) != 2 {
		t.Fatalf("requests = %d", len(bodies))
	}
	if err := relay.Send(context.Background(), RelayMessage{Handle: "h", Ciphertext: "c"}); err != nil || len(bodies) != 3 {
		t.Fatalf("ordinary send error=%v requests=%d", err, len(bodies))
	}
}
