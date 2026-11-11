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

	"github.com/coder/websocket"
	"github.com/comamessenger/comamessenger/core/internal/access"
	"github.com/comamessenger/comamessenger/core/internal/agent"
	"github.com/comamessenger/comamessenger/core/internal/chat"
	"github.com/comamessenger/comamessenger/core/internal/config"
	"github.com/comamessenger/comamessenger/core/internal/eventlog"
	"github.com/comamessenger/comamessenger/core/internal/identity"
	"github.com/comamessenger/comamessenger/core/internal/message"
	"github.com/comamessenger/comamessenger/core/internal/password"
	"github.com/comamessenger/comamessenger/core/internal/realtime"
	"github.com/comamessenger/comamessenger/core/internal/scheduled"
	"github.com/comamessenger/comamessenger/core/internal/scheduledreset"
	"github.com/comamessenger/comamessenger/core/internal/testdb"
	"github.com/google/uuid"
)

// TestScheduledMessagesE2E schedules through the HTTP API and lets the real
// River client deliver the message on time, watching the author's socket.
func TestScheduledMessagesE2E(t *testing.T) {
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
	scheduledService := scheduled.NewService(pool, messageService, afterCommit, logger)
	riverClient, err := scheduled.NewClient(pool, scheduledService, logger)
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
	server.Config.Handler = NewHandler(logger, baseURL, pool.Ping, Dependencies{
		Identity: identityService, Agents: agentService, Chats: chat.NewService(pool, afterCommit),
		Messages: messageService, Scheduled: scheduledService, Realtime: realtimeServer,
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
	var invitation identity.Invitation
	e2eRequest(t, client, standardhttp.MethodPost, baseURL+"/api/v1/invitations", owner.AccessToken, map[string]any{
		"email": "member@example.test", "role": "member",
	}, standardhttp.StatusCreated, &invitation)
	acceptURL, err := url.Parse(invitation.AcceptURL)
	if err != nil {
		t.Fatal(err)
	}
	var member identity.Tokens
	e2eRequest(t, client, standardhttp.MethodPost, baseURL+"/api/v1/invitations/"+path.Base(acceptURL.Path)+"/accept", "", map[string]any{
		"display_name": "Member", "handle": "member", "password": "another correct password", "timezone": "UTC",
	}, standardhttp.StatusCreated, &member)
	var group chat.Chat
	e2eRequest(t, client, standardhttp.MethodPost, baseURL+"/api/v1/chats", owner.AccessToken, map[string]any{
		"kind": "group", "visibility": "private", "name": "Plans", "member_ids": []string{member.User.ActorID},
	}, standardhttp.StatusCreated, &group)

	authorSocket := e2eSocket(t, baseURL, member.AccessToken, 0)
	defer authorSocket.CloseNow()
	ownerSocket := e2eSocket(t, baseURL, owner.AccessToken, 0)
	defer ownerSocket.CloseNow()

	endpoint := baseURL + "/api/v1/chats/" + group.ID + "/scheduled-messages"
	e2eRequest(t, client, standardhttp.MethodPost, endpoint, member.AccessToken, map[string]any{
		"client_msg_id": uuid.NewString(), "body": "too early", "send_at": time.Now().Add(-time.Minute),
	}, standardhttp.StatusUnprocessableEntity, nil)
	e2eRequest(t, client, standardhttp.MethodPost, endpoint, member.AccessToken, map[string]any{
		"client_msg_id": uuid.NewString(), "body": "unknown field", "send_at": time.Now().Add(time.Hour), "run_id": uuid.NewString(),
	}, standardhttp.StatusBadRequest, nil)
	request := map[string]any{
		"client_msg_id": uuid.NewString(), "body": "Good morning!", "send_at": time.Now().Add(2 * time.Second), "silent": true,
	}
	var created scheduled.ScheduledMessage
	e2eRequest(t, client, standardhttp.MethodPost, endpoint, member.AccessToken, request, standardhttp.StatusCreated, &created)
	e2eRequest(t, client, standardhttp.MethodPost, endpoint, member.AccessToken, request, standardhttp.StatusOK, nil)
	if created.Status != "pending" || !created.Silent || created.Body != "Good morning!" {
		t.Fatalf("created = %#v", created)
	}

	// The organization owner, a member of the same chat, sees nothing of it.
	item := baseURL + "/api/v1/scheduled-messages/" + created.ID
	e2eRequest(t, client, standardhttp.MethodGet, item, owner.AccessToken, nil, standardhttp.StatusNotFound, nil)
	e2eRequest(t, client, standardhttp.MethodPatch, item, owner.AccessToken, map[string]any{"expected_version": 1, "body": "x"}, standardhttp.StatusNotFound, nil)
	e2eRequest(t, client, standardhttp.MethodPost, item+"/send", owner.AccessToken, nil, standardhttp.StatusNotFound, nil)
	e2eRequest(t, client, standardhttp.MethodDelete, item, owner.AccessToken, nil, standardhttp.StatusNotFound, nil)
	var ownerList struct {
		ScheduledMessages []scheduled.ScheduledMessage `json:"scheduled_messages"`
	}
	e2eRequest(t, client, standardhttp.MethodGet, baseURL+"/api/v1/scheduled-messages", owner.AccessToken, nil, standardhttp.StatusOK, &ownerList)
	if len(ownerList.ScheduledMessages) != 0 {
		t.Fatalf("owner list = %#v", ownerList)
	}
	var mine struct {
		ScheduledMessages []scheduled.ScheduledMessage `json:"scheduled_messages"`
	}
	e2eRequest(t, client, standardhttp.MethodGet, baseURL+"/api/v1/scheduled-messages?chat_id="+group.ID, member.AccessToken, nil, standardhttp.StatusOK, &mine)
	if len(mine.ScheduledMessages) != 1 || mine.ScheduledMessages[0].ID != created.ID {
		t.Fatalf("author list = %#v", mine)
	}

	// The author's devices hear about it; River sends it on time and the
	// other member sees nothing before the message itself.
	scheduledEvent(t, authorSocket, "scheduled_message.created")
	ownerFrames := framesUntil(t, ownerSocket, "message.created")
	for _, frame := range ownerFrames {
		if strings.HasPrefix(frame.Type, "scheduled_message.") {
			t.Fatalf("owner received %s", frame.Type)
		}
	}
	var delivered message.Message
	if err := json.Unmarshal(ownerFrames[len(ownerFrames)-1].Data, &delivered); err != nil {
		t.Fatal(err)
	}
	if delivered.Body != "Good morning!" || delivered.ActorID != member.User.ActorID || !delivered.Silent {
		t.Fatalf("delivered = %#v", delivered)
	}
	// The event names what changed; the record tells the rest.
	sentEvent := scheduledEvent(t, authorSocket, "scheduled_message.sent")
	var event scheduledreset.Event
	decoder := json.NewDecoder(bytes.NewReader(sentEvent.Data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&event); err != nil || event.ID != created.ID || event.Status != "sent" {
		t.Fatalf("sent event %s: %v", sentEvent.Data, err)
	}
	if bytes.Contains(sentEvent.Data, []byte("Good morning")) {
		t.Fatal("event carries the text")
	}
	var sent scheduled.ScheduledMessage
	e2eRequest(t, client, standardhttp.MethodGet, item, member.AccessToken, nil, standardhttp.StatusOK, &sent)
	if sent.MessageID == nil || *sent.MessageID != delivered.ID || sent.Status != "sent" {
		t.Fatalf("sent = %#v", sent)
	}
	e2eRequest(t, client, standardhttp.MethodPost, item+"/send", member.AccessToken, nil, standardhttp.StatusConflict, nil)
	e2eRequest(t, client, standardhttp.MethodDelete, item, member.AccessToken, nil, standardhttp.StatusNoContent, nil)
	e2eRequest(t, client, standardhttp.MethodGet, item, member.AccessToken, nil, standardhttp.StatusNotFound, nil)

	// Removing a device from the session list stops what it scheduled;
	// signing out on a device itself does not.
	var phone identity.Tokens
	e2eRequest(t, client, standardhttp.MethodPost, baseURL+"/api/v1/auth/login", "", map[string]any{
		"email": "member@example.test", "password": "another correct password",
	}, standardhttp.StatusOK, &phone)
	var tablet identity.Tokens
	e2eRequest(t, client, standardhttp.MethodPost, baseURL+"/api/v1/auth/login", "", map[string]any{
		"email": "member@example.test", "password": "another correct password",
	}, standardhttp.StatusOK, &tablet)
	later := func(token, body string) scheduled.ScheduledMessage {
		var result scheduled.ScheduledMessage
		e2eRequest(t, client, standardhttp.MethodPost, endpoint, token, map[string]any{
			"client_msg_id": uuid.NewString(), "body": body, "send_at": time.Now().Add(time.Hour),
		}, standardhttp.StatusCreated, &result)
		return result
	}
	fromPhone, fromTablet, fromLaptop := later(phone.AccessToken, "phone"), later(tablet.AccessToken, "tablet"), later(member.AccessToken, "laptop")
	var phoneSessions struct {
		Sessions []identity.Session `json:"sessions"`
	}
	e2eRequest(t, client, standardhttp.MethodGet, baseURL+"/api/v1/sessions", phone.AccessToken, nil, standardhttp.StatusOK, &phoneSessions)
	phoneSessionID := ""
	for _, session := range phoneSessions.Sessions {
		if session.Current {
			phoneSessionID = session.ID
		}
	}
	e2eRequest(t, client, standardhttp.MethodDelete, baseURL+"/api/v1/sessions/"+phoneSessionID, member.AccessToken, nil, standardhttp.StatusNoContent, nil)
	e2eRequest(t, client, standardhttp.MethodPost, baseURL+"/api/v1/auth/logout", tablet.AccessToken, nil, standardhttp.StatusNoContent, nil)
	status := func(item scheduled.ScheduledMessage) (string, string) {
		var got scheduled.ScheduledMessage
		e2eRequest(t, client, standardhttp.MethodGet, baseURL+"/api/v1/scheduled-messages/"+item.ID, member.AccessToken, nil, standardhttp.StatusOK, &got)
		reason := ""
		if got.FailureReason != nil {
			reason = *got.FailureReason
		}
		return got.Status, reason
	}
	if got, reason := status(fromPhone); got != "failed" || reason != "session_revoked" {
		t.Fatalf("phone message = %s %s", got, reason)
	}
	for _, item := range []scheduled.ScheduledMessage{fromTablet, fromLaptop} {
		if got, reason := status(item); got != "pending" {
			t.Fatalf("%s = %s %s", item.Body, got, reason)
		}
	}
}

// framesUntil reads event frames until one of the wanted type arrives.
func framesUntil(t *testing.T, connection *websocket.Conn, eventType string) []eventlog.Frame {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	var frames []eventlog.Frame
	for {
		_, payload, err := connection.Read(ctx)
		if err != nil {
			t.Fatalf("waiting for %s: %v", eventType, err)
		}
		var frame eventlog.Frame
		if err := json.Unmarshal(payload, &frame); err != nil {
			t.Fatal(err)
		}
		if frame.Op != "event" {
			continue
		}
		frames = append(frames, frame)
		e2eAck(t, connection, frame.Seq)
		if frame.Type == eventType {
			return frames
		}
	}
}

func scheduledEvent(t *testing.T, connection *websocket.Conn, eventType string) eventlog.Frame {
	t.Helper()
	frames := framesUntil(t, connection, eventType)
	return frames[len(frames)-1]
}
