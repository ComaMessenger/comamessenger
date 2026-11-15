package http

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	standardhttp "net/http"
	"net/http/httptest"
	"net/url"
	"path"
	"strings"
	"testing"
	"time"

	"github.com/comamessenger/comamessenger/core/internal/access"
	"github.com/comamessenger/comamessenger/core/internal/agent"
	"github.com/comamessenger/comamessenger/core/internal/api"
	"github.com/comamessenger/comamessenger/core/internal/chat"
	"github.com/comamessenger/comamessenger/core/internal/config"
	"github.com/comamessenger/comamessenger/core/internal/eventlog"
	"github.com/comamessenger/comamessenger/core/internal/identity"
	"github.com/comamessenger/comamessenger/core/internal/message"
	"github.com/comamessenger/comamessenger/core/internal/password"
	"github.com/comamessenger/comamessenger/core/internal/realtime"
	"github.com/comamessenger/comamessenger/core/internal/reminder"
	"github.com/comamessenger/comamessenger/core/internal/testdb"
	"github.com/comamessenger/comamessenger/core/internal/userstate"
	"github.com/google/uuid"
)

// TestRemindersE2E sets a reminder through the HTTP API, lets the real River
// client fire it, and checks that only its owner ever sees it: through the
// routes and through realtime.
func TestRemindersE2E(t *testing.T) {
	pool := testdb.New(t)
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	server := httptest.NewUnstartedServer(nil)
	baseURL := "http://" + server.Listener.Addr().String()
	hasher, err := password.NewHasher(password.Params{MemoryKiB: 19 * 1024, Iterations: 2, Parallelism: 1})
	if err != nil {
		t.Fatal(err)
	}
	tokenManager, err := access.NewManager("0123456789abcdef0123456789abcdef", 15*time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	identityService, err := identity.NewService(identity.NewRepository(pool), hasher, tokenManager, 24*time.Hour, 24*time.Hour, baseURL, true, &e2eEmailSender{})
	if err != nil {
		t.Fatal(err)
	}
	agentService := agent.NewService(pool)
	identityService.SetBearerAuthenticator(agentService.AuthenticateKey)
	eventStore := eventlog.NewStore(pool)
	hub := realtime.NewHub(10)
	realtimeConfig := e2eRealtimeConfig()
	ephemeral, err := realtime.NewEphemeral(logger, pool, hub, realtimeConfig, config.RedisConfig{
		Mode: "disabled", Namespace: "coma:e2e", OperationTimeout: time.Second,
	})
	if err != nil {
		t.Fatal(err)
	}
	dispatcher := realtime.NewDispatcher(logger, eventStore, hub, 20*time.Millisecond, time.Millisecond)
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(func() {
		cancel()
		hub.Shutdown(context.Canceled)
		_ = ephemeral.Close()
	})
	go dispatcher.Run(ctx)
	go ephemeral.Run(ctx)
	afterCommit := func(_ string, _ int64) { dispatcher.WakeLocal() }
	identityService.SetAfterCommit(afterCommit)
	realtimeServer := realtime.NewServer(logger, baseURL, eventStore, hub, identityService.Authenticate, realtimeConfig, ephemeral)
	messageService := message.NewService(pool, 64*1024, 100, afterCommit)
	reminderService := reminder.NewService(pool, afterCommit, logger)
	riverClient, err := reminder.NewClient(pool, reminderService, logger)
	if err != nil {
		t.Fatal(err)
	}
	if err := riverClient.Start(ctx); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		stopCtx, stop := context.WithTimeout(context.Background(), 5*time.Second)
		defer stop()
		_ = riverClient.Stop(stopCtx)
	})
	// A reminder two seconds ahead passes the one-minute rule.
	reminderService.SetClock(func() time.Time { return time.Now().Add(-2 * time.Minute) })
	server.Config.Handler = NewHandler(logger, baseURL, pool.Ping, Dependencies{
		Identity: identityService, Agents: agentService, Chats: chat.NewService(pool, afterCommit),
		Messages: messageService, Reminders: reminderService, UserState: userstate.NewService(pool, 64*1024, afterCommit), Realtime: realtimeServer,
		RefreshTokenTTL: 24 * time.Hour, RevokeRealtimeSession: realtimeServer.RevokeSession,
	})
	server.Start()
	t.Cleanup(server.Close)
	client := server.Client()

	var owner identity.Tokens
	e2eRequest(t, client, standardhttp.MethodPost, baseURL+"/api/v1/bootstrap", "", map[string]any{
		"organization_name": "E2E", "organization_slug": "e2e", "display_name": "Owner",
		"handle": "owner", "email": "owner@example.test", "password": "correct horse battery staple", "timezone": "UTC",
	}, standardhttp.StatusCreated, &owner)
	invite := func(handle string) identity.Tokens {
		var invitation identity.Invitation
		e2eRequest(t, client, standardhttp.MethodPost, baseURL+"/api/v1/invitations", owner.AccessToken, map[string]any{
			"email": handle + "@example.test", "role": "member",
		}, standardhttp.StatusCreated, &invitation)
		acceptURL, err := url.Parse(invitation.AcceptURL)
		if err != nil {
			t.Fatal(err)
		}
		var tokens identity.Tokens
		e2eRequest(t, client, standardhttp.MethodPost, baseURL+"/api/v1/invitations/"+path.Base(acceptURL.Path)+"/accept", "", map[string]any{
			"display_name": handle, "handle": handle, "password": "another correct password", "timezone": "UTC",
		}, standardhttp.StatusCreated, &tokens)
		return tokens
	}
	member, colleague := invite("member"), invite("colleague")
	var group chat.Chat
	e2eRequest(t, client, standardhttp.MethodPost, baseURL+"/api/v1/chats", owner.AccessToken, map[string]any{
		"kind": "group", "visibility": "private", "name": "Plans", "member_ids": []string{member.User.ActorID, colleague.User.ActorID},
	}, standardhttp.StatusCreated, &group)
	var target message.Message
	e2eRequest(t, client, standardhttp.MethodPost, baseURL+"/api/v1/chats/"+group.ID+"/messages", owner.AccessToken, map[string]any{
		"client_msg_id": uuid.NewString(), "body": "Планёрка в понедельник", "body_format": "plain",
	}, standardhttp.StatusCreated, &target)

	memberSocket := e2eSocket(t, baseURL, member.AccessToken, 0)
	defer memberSocket.CloseNow()
	colleagueSocket := e2eSocket(t, baseURL, colleague.AccessToken, 0)
	defer colleagueSocket.CloseNow()

	// strictly decodes a body into the generated contract type.
	strictly := func(t *testing.T, method, endpoint, token string, body any, status int, output any) {
		t.Helper()
		var raw json.RawMessage
		e2eRequest(t, client, method, endpoint, token, body, status, &raw)
		decoder := json.NewDecoder(bytes.NewReader(raw))
		decoder.DisallowUnknownFields()
		if err := decoder.Decode(output); err != nil {
			t.Fatalf("%s %s: %v in %s", method, endpoint, err, raw)
		}
	}
	reminderURL := baseURL + "/api/v1/messages/" + target.ID + "/reminder"

	// Refusals.
	e2eRequest(t, client, standardhttp.MethodPut, reminderURL, member.AccessToken, map[string]any{"remind_at": time.Now().Add(-time.Hour)}, standardhttp.StatusUnprocessableEntity, nil)
	e2eRequest(t, client, standardhttp.MethodPut, reminderURL, member.AccessToken, map[string]any{"remind_at": time.Now().Add(time.Hour), "note": strings.Repeat("я", 201)}, standardhttp.StatusUnprocessableEntity, nil)
	e2eRequest(t, client, standardhttp.MethodPut, reminderURL, member.AccessToken, map[string]any{"remind_at": time.Now().Add(time.Hour), "chat_id": group.ID}, standardhttp.StatusUnprocessableEntity, nil)
	e2eRequest(t, client, standardhttp.MethodPut, baseURL+"/api/v1/messages/"+uuid.NewString()+"/reminder", member.AccessToken, map[string]any{"remind_at": time.Now().Add(time.Hour)}, standardhttp.StatusNotFound, nil)

	var created api.Reminder
	strictly(t, standardhttp.MethodPut, reminderURL, member.AccessToken, map[string]any{"remind_at": time.Now().Add(time.Hour), "note": "позвонить"}, standardhttp.StatusCreated, &created)
	if created.Access != "available" || created.Message == nil || created.Message.Message.Body != "Планёрка в понедельник" ||
		created.Message.Chat.DisplayName != "Plans" || created.Note != "позвонить" || created.State != "pending" {
		t.Fatalf("created = %+v", created)
	}
	reminderID := created.Id.String()
	var moved api.Reminder
	strictly(t, standardhttp.MethodPut, reminderURL, member.AccessToken, map[string]any{"remind_at": time.Now().Add(2 * time.Second)}, standardhttp.StatusOK, &moved)
	if moved.Id != created.Id || moved.Version != 2 || moved.Note != "позвонить" {
		t.Fatalf("moved = %+v", moved)
	}

	// Nobody else reaches it.
	for _, other := range []identity.Tokens{owner, colleague} {
		e2eRequest(t, client, standardhttp.MethodPut, baseURL+"/api/v1/reminders/"+reminderID, other.AccessToken, map[string]any{"remind_at": time.Now().Add(time.Hour), "note": "x"}, standardhttp.StatusNotFound, nil)
		e2eRequest(t, client, standardhttp.MethodDelete, baseURL+"/api/v1/reminders/"+reminderID, other.AccessToken, nil, standardhttp.StatusNoContent, nil)
		e2eRequest(t, client, standardhttp.MethodDelete, reminderURL, other.AccessToken, nil, standardhttp.StatusNoContent, nil)
		for _, state := range []string{"pending", "fired"} {
			var page api.ReminderPage
			strictly(t, standardhttp.MethodGet, baseURL+"/api/v1/reminders?state="+state, other.AccessToken, nil, standardhttp.StatusOK, &page)
			if len(page.Items) != 0 {
				t.Fatalf("someone else lists %+v", page.Items)
			}
		}
		var ids api.ReminderIds
		strictly(t, standardhttp.MethodGet, baseURL+"/api/v1/reminders/ids?chat_id="+group.ID, other.AccessToken, nil, standardhttp.StatusOK, &ids)
		if len(ids.Reminders) != 0 {
			t.Fatalf("someone else's bell: %+v", ids)
		}
	}

	// River fires it; the owner's devices hear it.
	fired := scheduledEvent(t, memberSocket, "reminder.fired")
	if fired.SubjectID != reminderID || fired.ChatID != nil || strings.Contains(string(fired.Data), "позвонить") {
		t.Fatalf("fired frame = %+v %s", fired, fired.Data)
	}
	var page api.ReminderPage
	strictly(t, standardhttp.MethodGet, baseURL+"/api/v1/reminders?state=fired", member.AccessToken, nil, standardhttp.StatusOK, &page)
	if len(page.Items) != 1 || page.Items[0].State != "fired" || page.Items[0].FiredAt == nil || page.Items[0].Access != "available" || page.Items[0].Message == nil {
		t.Fatalf("fired page = %+v", page)
	}
	var unread api.UnreadSnapshot
	e2eRequest(t, client, standardhttp.MethodGet, baseURL+"/api/v1/unread", member.AccessToken, nil, standardhttp.StatusOK, &unread)
	if unread.RemindersFiredTotal == nil || *unread.RemindersFiredTotal != 1 {
		t.Fatalf("member unread = %+v", unread.RemindersFiredTotal)
	}
	e2eRequest(t, client, standardhttp.MethodGet, baseURL+"/api/v1/unread", colleague.AccessToken, nil, standardhttp.StatusOK, &unread)
	if unread.RemindersFiredTotal == nil || *unread.RemindersFiredTotal != 0 {
		t.Fatalf("colleague unread = %+v", unread.RemindersFiredTotal)
	}
	var ids api.ReminderIds
	strictly(t, standardhttp.MethodGet, baseURL+"/api/v1/reminders/ids?chat_id="+group.ID, member.AccessToken, nil, standardhttp.StatusOK, &ids)
	if len(ids.Reminders) != 1 || ids.Reminders[0].MessageId.String() != target.ID || ids.Reminders[0].State != "fired" {
		t.Fatalf("bell = %+v", ids)
	}

	// The colleague's socket got none of it: the next event it gets is the
	// next message, and nothing reminder.* came before it.
	e2eRequest(t, client, standardhttp.MethodPost, baseURL+"/api/v1/chats/"+group.ID+"/messages", owner.AccessToken, map[string]any{
		"client_msg_id": uuid.NewString(), "body": "next", "body_format": "plain",
	}, standardhttp.StatusCreated, nil)
	for _, frame := range framesUntil(t, colleagueSocket, "message.created") {
		if strings.HasPrefix(frame.Type, "reminder.") {
			t.Fatalf("a colleague received %s", frame.Type)
		}
	}

	// Removed from the chat: the reminder stays with its note only.
	e2eRequest(t, client, standardhttp.MethodDelete, baseURL+"/api/v1/chats/"+group.ID+"/members/"+member.User.ActorID, owner.AccessToken, nil, standardhttp.StatusNoContent, nil)
	strictly(t, standardhttp.MethodGet, baseURL+"/api/v1/reminders?state=fired", member.AccessToken, nil, standardhttp.StatusOK, &page)
	if len(page.Items) != 1 || page.Items[0].Access != "none" || page.Items[0].Message != nil || page.Items[0].Note != "позвонить" {
		t.Fatalf("after removal = %+v", page)
	}
	raw, _ := json.Marshal(page)
	if strings.Contains(string(raw), "Планёрка") {
		t.Fatalf("a removed member still reads the message: %s", raw)
	}
	e2eRequest(t, client, standardhttp.MethodGet, baseURL+"/api/v1/reminders/ids?chat_id="+group.ID, member.AccessToken, nil, standardhttp.StatusNotFound, nil)
	e2eRequest(t, client, standardhttp.MethodPut, reminderURL, member.AccessToken, map[string]any{"remind_at": time.Now().Add(time.Hour)}, standardhttp.StatusNotFound, nil)

	// «Готово» still works, and repeats.
	e2eRequest(t, client, standardhttp.MethodDelete, reminderURL, member.AccessToken, nil, standardhttp.StatusNoContent, nil)
	e2eRequest(t, client, standardhttp.MethodDelete, reminderURL, member.AccessToken, nil, standardhttp.StatusNoContent, nil)
	e2eRequest(t, client, standardhttp.MethodGet, baseURL+"/api/v1/unread", member.AccessToken, nil, standardhttp.StatusOK, &unread)
	if unread.RemindersFiredTotal == nil || *unread.RemindersFiredTotal != 0 {
		t.Fatalf("after closing = %+v", unread.RemindersFiredTotal)
	}
	deleted := scheduledEvent(t, memberSocket, "reminder.deleted")
	if !strings.Contains(string(deleted.Data), `"reason":"removed"`) {
		t.Fatalf("deleted frame = %s", deleted.Data)
	}

	// The colleague keeps a reminder about a message that gets deleted: it
	// is shown with its note and access «deleted».
	var kept api.Reminder
	strictly(t, standardhttp.MethodPut, reminderURL, colleague.AccessToken, map[string]any{"remind_at": time.Now().Add(time.Hour), "note": "бюджет"}, standardhttp.StatusCreated, &kept)
	e2eRequest(t, client, standardhttp.MethodDelete, baseURL+"/api/v1/messages/"+target.ID, owner.AccessToken, nil, standardhttp.StatusOK, nil)
	strictly(t, standardhttp.MethodGet, baseURL+"/api/v1/reminders", colleague.AccessToken, nil, standardhttp.StatusOK, &page)
	if len(page.Items) != 1 || page.Items[0].Access != "deleted" || page.Items[0].MessageId != nil || page.Items[0].Message != nil || page.Items[0].Note != "бюджет" {
		t.Fatalf("deleted message reminder = %+v", page)
	}
	var updated api.Reminder
	strictly(t, standardhttp.MethodPut, baseURL+"/api/v1/reminders/"+kept.Id.String(), colleague.AccessToken, map[string]any{"remind_at": time.Now().Add(2 * time.Hour)}, standardhttp.StatusOK, &updated)
	if updated.Access != "deleted" || updated.Note != "бюджет" {
		t.Fatalf("updated = %+v", updated)
	}
	e2eRequest(t, client, standardhttp.MethodDelete, baseURL+"/api/v1/reminders/"+kept.Id.String(), colleague.AccessToken, nil, standardhttp.StatusNoContent, nil)
	strictly(t, standardhttp.MethodGet, baseURL+"/api/v1/reminders", colleague.AccessToken, nil, standardhttp.StatusOK, &page)
	if len(page.Items) != 0 {
		t.Fatalf("after delete = %+v", page)
	}
}
