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
	"github.com/comamessenger/comamessenger/core/internal/chat"
	"github.com/comamessenger/comamessenger/core/internal/config"
	"github.com/comamessenger/comamessenger/core/internal/eventlog"
	"github.com/comamessenger/comamessenger/core/internal/id"
	"github.com/comamessenger/comamessenger/core/internal/identity"
	"github.com/comamessenger/comamessenger/core/internal/message"
	"github.com/comamessenger/comamessenger/core/internal/password"
	"github.com/comamessenger/comamessenger/core/internal/push"
	"github.com/comamessenger/comamessenger/core/internal/realtime"
	"github.com/comamessenger/comamessenger/core/internal/testdb"
	"github.com/comamessenger/comamessenger/core/internal/userstate"
)

func TestTwoUserRESTAndWebSocketE2E(t *testing.T) {
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
	identityService, err := identity.NewService(
		identity.NewRepository(pool), hasher, tokenManager,
		24*time.Hour, 24*time.Hour, baseURL, true,
	)
	if err != nil {
		t.Fatal(err)
	}
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
	realtimeServer := realtime.NewServer(logger, baseURL, eventStore, hub, identityService.Authenticate, realtimeConfig, ephemeral)
	server.Config.Handler = NewHandler(logger, baseURL, pool.Ping, Dependencies{
		Identity: identityService, Chats: chat.NewService(pool),
		Messages:  message.NewService(pool, 64*1024, 100, afterCommit),
		UserState: userstate.NewService(pool, 64*1024, afterCommit), Realtime: realtimeServer,
		Push:            push.NewService(pool, config.PushConfig{}),
		RefreshTokenTTL: 24 * time.Hour, RevokeRealtimeSession: realtimeServer.RevokeSession,
	})
	server.Start()
	t.Cleanup(server.Close)

	var owner identity.Tokens
	e2eRequest(t, server.Client(), standardhttp.MethodPost, baseURL+"/api/v1/bootstrap", "", map[string]any{
		"organization_name": "E2E", "organization_slug": "e2e", "display_name": "Owner",
		"handle": "owner", "email": "owner@example.test", "password": "correct horse battery staple", "timezone": "UTC",
	}, standardhttp.StatusCreated, &owner)
	if owner.User.OrganizationName != "E2E" {
		t.Fatalf("bootstrap organization name = %q", owner.User.OrganizationName)
	}

	var invitation identity.Invitation
	e2eRequest(t, server.Client(), standardhttp.MethodPost, baseURL+"/api/v1/invitations", owner.AccessToken, map[string]any{
		"email": "member@example.test", "role": "member",
	}, standardhttp.StatusCreated, &invitation)
	acceptURL, err := url.Parse(invitation.AcceptURL)
	if err != nil || path.Base(acceptURL.Path) == "" {
		t.Fatalf("invitation accept URL = %q, error = %v", invitation.AcceptURL, err)
	}
	invitationToken := path.Base(acceptURL.Path)
	var member identity.Tokens
	e2eRequest(t, server.Client(), standardhttp.MethodPost, baseURL+"/api/v1/invitations/"+invitationToken+"/accept", "", map[string]any{
		"display_name": "Member", "handle": "member", "password": "another correct password", "timezone": "UTC",
	}, standardhttp.StatusCreated, &member)

	var group chat.Chat
	e2eRequest(t, server.Client(), standardhttp.MethodPost, baseURL+"/api/v1/chats", owner.AccessToken, map[string]any{
		"kind": "group", "visibility": "private", "name": "E2E room", "member_ids": []string{member.User.ActorID},
	}, standardhttp.StatusCreated, &group)
	var preferences push.Preferences
	e2eRequest(t, server.Client(), standardhttp.MethodGet, baseURL+"/api/v1/preferences", owner.AccessToken, nil, standardhttp.StatusOK, &preferences)
	preferences.Theme, preferences.Locale, preferences.PushEnabled, preferences.PushPreview = "light", "en", true, true
	preferences.ChatFolders = []push.ChatFolder{{ID: "00000000-0000-4000-8000-000000000080", Name: "Work", Icon: "briefcase", ChatIDs: []string{group.ID}}}
	e2eRequest(t, server.Client(), standardhttp.MethodPatch, baseURL+"/api/v1/preferences", owner.AccessToken, preferences, standardhttp.StatusOK, &preferences)
	if len(preferences.ChatFolders) != 1 || preferences.ChatFolders[0].ChatIDs[0] != group.ID {
		t.Fatalf("chat folders = %+v", preferences.ChatFolders)
	}
	var chatPreferences push.ChatPreferences
	e2eRequest(t, server.Client(), standardhttp.MethodGet, baseURL+"/api/v1/chats/"+group.ID+"/notification-preferences", owner.AccessToken, nil, standardhttp.StatusOK, &chatPreferences)
	e2eRequest(t, server.Client(), standardhttp.MethodPatch, baseURL+"/api/v1/chats/"+group.ID+"/notification-preferences", owner.AccessToken, map[string]any{"notify_level": "mentions", "muted_until": nil}, standardhttp.StatusOK, &chatPreferences)
	if chatPreferences.NotifyLevel != "mentions" {
		t.Fatalf("chat notification preferences = %+v", chatPreferences)
	}
	var subscription push.Subscription
	e2eRequest(t, server.Client(), standardhttp.MethodPut, baseURL+"/api/v1/push/subscriptions", owner.AccessToken, map[string]any{"endpoint": "https://push.example.test/subscription/owner", "keys": map[string]string{"p256dh": "0123456789abcdef", "auth": "0123456789abcdef"}}, standardhttp.StatusCreated, &subscription)

	ownerSocket := e2eSocket(t, baseURL, owner.AccessToken, 0)
	memberSocket := e2eSocket(t, baseURL, member.AccessToken, 0)
	t.Cleanup(func() {
		_ = ownerSocket.Close(websocket.StatusNormalClosure, "test complete")
		_ = memberSocket.Close(websocket.StatusNormalClosure, "test complete")
	})

	var first message.Message
	e2eRequest(t, server.Client(), standardhttp.MethodPost, baseURL+"/api/v1/chats/"+group.ID+"/messages", member.AccessToken, map[string]any{
		"client_msg_id": e2eID(t), "body": "hello owner", "body_format": "plain",
		"mentioned_actor_ids": []string{owner.User.ActorID},
	}, standardhttp.StatusCreated, &first)
	var notificationJobs int
	if err := pool.QueryRow(context.Background(), `SELECT count(*) FROM notification_jobs WHERE org_id=$1 AND event_seq=$2`, owner.User.OrgID, first.CreatedSeq).Scan(&notificationJobs); err != nil || notificationJobs != 1 {
		t.Fatalf("notification job count=%d error=%v", notificationJobs, err)
	}
	ownerFirst := e2eEvent(t, ownerSocket)
	memberFirst := e2eEvent(t, memberSocket)
	if ownerFirst.Seq != first.CreatedSeq || memberFirst.Seq != first.CreatedSeq || ownerFirst.Type != "message.created" {
		t.Fatalf("first websocket events owner=%+v member=%+v message=%+v", ownerFirst, memberFirst, first)
	}
	e2eAck(t, ownerSocket, ownerFirst.Seq)
	e2eAck(t, memberSocket, memberFirst.Seq)

	var second message.Message
	e2eRequest(t, server.Client(), standardhttp.MethodPost, baseURL+"/api/v1/chats/"+group.ID+"/messages", owner.AccessToken, map[string]any{
		"client_msg_id": e2eID(t), "body": "hello member", "body_format": "plain",
	}, standardhttp.StatusCreated, &second)
	ownerSecond := e2eEvent(t, ownerSocket)
	memberSecond := e2eEvent(t, memberSocket)
	if ownerSecond.Seq != second.CreatedSeq || memberSecond.Seq != second.CreatedSeq || memberSecond.Type != "message.created" {
		t.Fatalf("second websocket events owner=%+v member=%+v message=%+v", ownerSecond, memberSecond, second)
	}
	e2eAck(t, ownerSocket, ownerSecond.Seq)
	e2eAck(t, memberSocket, memberSecond.Seq)

	var page message.Page
	e2eRequest(t, server.Client(), standardhttp.MethodGet, baseURL+"/api/v1/chats/"+group.ID+"/messages", owner.AccessToken, nil, standardhttp.StatusOK, &page)
	if len(page.Messages) != 2 || page.Messages[0].ID != second.ID || page.Messages[1].ID != first.ID {
		t.Fatalf("message history = %+v", page.Messages)
	}

	var unread userstate.UnreadSnapshot
	e2eRequest(t, server.Client(), standardhttp.MethodGet, baseURL+"/api/v1/unread", owner.AccessToken, nil, standardhttp.StatusOK, &unread)
	if len(unread.Chats) != 1 || unread.Chats[0].UnreadCount != 1 || unread.Chats[0].MentionCount != 1 {
		t.Fatalf("owner unread = %+v", unread)
	}
	var read userstate.ReadMarker
	e2eRequest(t, server.Client(), standardhttp.MethodPost, baseURL+"/api/v1/chats/"+group.ID+"/read", owner.AccessToken, map[string]any{
		"last_read_seq": second.CreatedSeq,
	}, standardhttp.StatusOK, &read)
	if read.LastReadSeq != second.CreatedSeq {
		t.Fatalf("read marker = %+v", read)
	}
	e2eRequest(t, server.Client(), standardhttp.MethodGet, baseURL+"/api/v1/unread", owner.AccessToken, nil, standardhttp.StatusOK, &unread)
	if len(unread.Chats) != 1 || unread.Chats[0].UnreadCount != 0 || unread.Chats[0].MentionCount != 0 {
		t.Fatalf("owner unread after marker = %+v", unread)
	}

	e2eRequest(t, server.Client(), standardhttp.MethodPost, baseURL+"/api/v1/auth/logout", member.AccessToken, nil, standardhttp.StatusNoContent, nil)
	closeCtx, closeCancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer closeCancel()
	for {
		_, _, err := memberSocket.Read(closeCtx)
		if err == nil {
			continue
		}
		if websocket.CloseStatus(err) != 4001 {
			t.Fatalf("member websocket after logout: close status=%d error=%v", websocket.CloseStatus(err), err)
		}
		break
	}
}

func e2eRealtimeConfig() config.RealtimeConfig {
	return config.RealtimeConfig{
		AuthTimeout: 2 * time.Second, MaxFrameBytes: 256 * 1024, MaxConnectionsPerActor: 10,
		MaxQueuedEvents: 64, MaxQueuedBytes: 1024 * 1024, MaxUnackedEvents: 16,
		HeartbeatInterval: time.Minute, PongTimeout: 2 * time.Second,
		AckInterval: 50 * time.Millisecond, AckTimeout: 3 * time.Second, AckBatchSize: 8,
		TypingTTL: 6 * time.Second, PresenceTTL: time.Minute, ActiveSubscriptionTTL: time.Minute,
		EphemeralRateLimit: 30, EphemeralRateWindow: 10 * time.Second,
	}
}

func e2eRequest(t *testing.T, client *standardhttp.Client, method, endpoint, token string, body any, wantStatus int, output any) {
	t.Helper()
	var payload io.Reader
	if body != nil {
		encoded, err := json.Marshal(body)
		if err != nil {
			t.Fatal(err)
		}
		payload = bytes.NewReader(encoded)
	}
	request, err := standardhttp.NewRequestWithContext(context.Background(), method, endpoint, payload)
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Content-Type", "application/json")
	if token != "" {
		request.Header.Set("Authorization", "Bearer "+token)
	}
	response, err := client.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != wantStatus {
		data, _ := io.ReadAll(io.LimitReader(response.Body, 4096))
		t.Fatalf("%s %s status = %d, want %d: %s", method, endpoint, response.StatusCode, wantStatus, data)
	}
	if output != nil {
		if err := json.NewDecoder(response.Body).Decode(output); err != nil {
			t.Fatal(err)
		}
	}
}

func e2eSocket(t *testing.T, baseURL, token string, lastSeq int64) *websocket.Conn {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	header := standardhttp.Header{"Origin": []string{baseURL}}
	connection, response, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(baseURL, "http")+"/api/v1/ws", &websocket.DialOptions{HTTPHeader: header})
	if err != nil {
		if response != nil {
			t.Fatalf("dial websocket status=%d error=%v", response.StatusCode, err)
		}
		t.Fatal(err)
	}
	requestID := e2eID(t)
	if err := connection.Write(ctx, websocket.MessageText, mustJSON(t, map[string]any{
		"op": "auth", "request_id": requestID, "access_token": token, "last_seq": lastSeq,
	})); err != nil {
		t.Fatal(err)
	}
	var hello struct {
		Op        string `json:"op"`
		RequestID string `json:"request_id"`
	}
	e2eReadSocket(t, connection, &hello)
	if hello.Op != "hello" || hello.RequestID != requestID {
		t.Fatalf("hello = %+v", hello)
	}
	return connection
}

func e2eEvent(t *testing.T, connection *websocket.Conn) eventlog.Frame {
	t.Helper()
	var frame eventlog.Frame
	e2eReadSocket(t, connection, &frame)
	return frame
}

func e2eAck(t *testing.T, connection *websocket.Conn, sequence int64) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	if err := connection.Write(ctx, websocket.MessageText, mustJSON(t, map[string]any{"op": "ack", "seq": sequence})); err != nil {
		t.Fatal(err)
	}
}

func e2eReadSocket(t *testing.T, connection *websocket.Conn, output any) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	messageType, payload, err := connection.Read(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if messageType != websocket.MessageText {
		t.Fatalf("websocket message type = %v", messageType)
	}
	if err := json.Unmarshal(payload, output); err != nil {
		t.Fatalf("decode websocket frame %s: %v", payload, err)
	}
}

func mustJSON(t *testing.T, value any) []byte {
	t.Helper()
	result, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return result
}

func e2eID(t *testing.T) string {
	t.Helper()
	value, err := id.New()
	if err != nil {
		t.Fatal(err)
	}
	return value
}
