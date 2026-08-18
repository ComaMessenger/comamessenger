package realtime

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	standardhttp "net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"
	"github.com/comamessenger/comamessenger/core/internal/access"
	"github.com/comamessenger/comamessenger/core/internal/config"
	"github.com/comamessenger/comamessenger/core/internal/eventlog"
	"github.com/comamessenger/comamessenger/core/internal/id"
	"github.com/comamessenger/comamessenger/core/internal/identity"
	"github.com/comamessenger/comamessenger/core/internal/message"
	"github.com/comamessenger/comamessenger/core/internal/testdb"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestRealtimeLiveDeliveryAndResume(t *testing.T) {
	harness := newRealtimeHarness(t, realtimeTestConfig())
	connection, hello := harness.connect(t, 0)
	if hello.CurrentSeq != 0 {
		t.Fatalf("hello current_seq = %d, want 0", hello.CurrentSeq)
	}

	first := harness.createMessage(t, harness.messages, "live")
	firstEvent := readEvent(t, connection, 3*time.Second)
	if firstEvent.Seq != first.CreatedSeq || firstEvent.Type != "message.created" {
		t.Fatalf("live event = %+v", firstEvent)
	}
	var hydrated message.Message
	if err := json.Unmarshal(firstEvent.Data, &hydrated); err != nil {
		t.Fatal(err)
	}
	if hydrated.ID != first.ID || hydrated.Body != "live" {
		t.Fatalf("hydrated live message = %+v", hydrated)
	}
	if err := wsjson.Write(context.Background(), connection, ackFrame{Op: "ack", Seq: firstEvent.Seq}); err != nil {
		t.Fatal(err)
	}
	_ = connection.Close(websocket.StatusNormalClosure, "offline")

	second := harness.createMessage(t, harness.messages, "offline")
	resumed, resumedHello := harness.connect(t, firstEvent.Seq)
	defer resumed.CloseNow()
	if resumedHello.CurrentSeq != second.CreatedSeq {
		t.Fatalf("resume current_seq = %d, want %d", resumedHello.CurrentSeq, second.CreatedSeq)
	}
	backlogEvent := readEvent(t, resumed, 3*time.Second)
	if backlogEvent.Seq != second.CreatedSeq {
		t.Fatalf("backlog event seq = %d, want %d", backlogEvent.Seq, second.CreatedSeq)
	}
}

func TestRealtimeEphemeralFramesDoNotEnterEventLog(t *testing.T) {
	harness := newRealtimeHarness(t, realtimeTestConfig())
	sender, _ := harness.connect(t, 0)
	defer sender.CloseNow()
	receiver, _ := harness.connect(t, 0)
	defer receiver.CloseNow()
	active := subscribeActiveFrame{Op: "subscribe_active", ChatID: &harness.chatID}
	if err := wsjson.Write(context.Background(), sender, active); err != nil {
		t.Fatal(err)
	}
	if err := wsjson.Write(context.Background(), receiver, active); err != nil {
		t.Fatal(err)
	}
	if err := wsjson.Write(context.Background(), sender, typingFrame{Op: "typing", ChatID: harness.chatID, Active: true}); err != nil {
		t.Fatal(err)
	}
	var typing typingEventFrame
	readJSON(t, receiver, 3*time.Second, &typing)
	if typing.Op != "typing" || typing.ActorID != harness.user.ActorID || !typing.Active {
		t.Fatalf("typing frame = %+v", typing)
	}
	if err := wsjson.Write(context.Background(), sender, presenceFrame{Op: "presence", State: "active"}); err != nil {
		t.Fatal(err)
	}
	var presence presenceEventFrame
	readJSON(t, receiver, 3*time.Second, &presence)
	if presence.Op != "presence" || presence.State != "online" {
		t.Fatalf("presence frame = %+v", presence)
	}
	current, err := harness.store.Current(context.Background(), harness.user.OrgID)
	if err != nil {
		t.Fatal(err)
	}
	if current != 0 {
		t.Fatalf("ephemeral frames advanced durable seq to %d", current)
	}
}

func TestRealtimePollingRecoversLostWakeup(t *testing.T) {
	cfg := realtimeTestConfig()
	harness := newRealtimeHarness(t, cfg)
	connection, _ := harness.connect(t, 0)
	defer connection.CloseNow()
	serviceWithoutWake := message.NewService(harness.pool, 64*1024, 100, nil)
	created := harness.createMessage(t, serviceWithoutWake, "poll recovery")
	frame := readEvent(t, connection, 3*time.Second)
	if frame.Seq != created.CreatedSeq {
		t.Fatalf("polled event seq = %d, want %d", frame.Seq, created.CreatedSeq)
	}
}

func TestRealtimeRegisterBeforeWatermarkBarrier(t *testing.T) {
	harness := newRealtimeHarnessWithPoll(t, realtimeTestConfig(), time.Hour)
	ctx := context.Background()
	tx, err := harness.pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, `LOCK TABLE events IN ACCESS EXCLUSIVE MODE`); err != nil {
		t.Fatal(err)
	}

	connection := dialAndAuthenticate(t, harness.httpServer.URL, harness.user.ActorID, 0)
	defer connection.CloseNow()
	deadline := time.Now().Add(2 * time.Second)
	for len(harness.hub.Organizations()) == 0 && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	if len(harness.hub.Organizations()) == 0 {
		t.Fatal("connection was not registered before watermark read")
	}
	var seq int64
	if err := tx.QueryRow(ctx, `UPDATE organizations SET event_seq = event_seq + 1 WHERE id = $1 RETURNING event_seq`, harness.user.OrgID).Scan(&seq); err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO events (org_id, seq, type, actor_id, chat_id, subject_id)
		VALUES ($1, $2, 'message.created', $3, $4, $5)`, harness.user.OrgID, seq, harness.user.ActorID,
		harness.chatID, realtimeID(t)); err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}

	var hello helloFrame
	readJSON(t, connection, 3*time.Second, &hello)
	if hello.CurrentSeq != seq {
		t.Fatalf("barrier hello current_seq = %d, want %d", hello.CurrentSeq, seq)
	}
	frame := readEvent(t, connection, 3*time.Second)
	if frame.Seq != seq {
		t.Fatalf("barrier event seq = %d, want %d", frame.Seq, seq)
	}
}

func TestRealtimeSlowConsumerAndShutdownCodes(t *testing.T) {
	cfg := realtimeTestConfig()
	cfg.MaxUnackedEvents = 1
	cfg.MaxQueuedEvents = 2
	cfg.AckTimeout = 100 * time.Millisecond
	harness := newRealtimeHarness(t, cfg)
	connection, _ := harness.connect(t, 0)
	harness.createMessage(t, harness.messages, "one")
	harness.createMessage(t, harness.messages, "two")
	_ = readEvent(t, connection, 3*time.Second)
	readCtx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	_, _, err := connection.Read(readCtx)
	if status := websocket.CloseStatus(err); status != statusSlowConsumer {
		t.Fatalf("slow consumer close status = %d (%v), want %d", status, err, statusSlowConsumer)
	}
	resumed, _ := harness.connect(t, 0)
	firstReplay := readEvent(t, resumed, 3*time.Second)
	if err := wsjson.Write(context.Background(), resumed, ackFrame{Op: "ack", Seq: firstReplay.Seq}); err != nil {
		t.Fatal(err)
	}
	secondReplay := readEvent(t, resumed, 3*time.Second)
	if secondReplay.Seq <= firstReplay.Seq {
		t.Fatalf("resumed events are not ordered: %d then %d", firstReplay.Seq, secondReplay.Seq)
	}
	if err := wsjson.Write(context.Background(), resumed, ackFrame{Op: "ack", Seq: secondReplay.Seq}); err != nil {
		t.Fatal(err)
	}
	_ = resumed.Close(websocket.StatusNormalClosure, "resumed")

	current, err := harness.store.Current(context.Background(), harness.user.OrgID)
	if err != nil {
		t.Fatal(err)
	}
	restarted, _ := harness.connect(t, current)
	harness.server.Shutdown()
	readCtx, cancel = context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	_, _, err = restarted.Read(readCtx)
	if status := websocket.CloseStatus(err); status != websocket.StatusServiceRestart {
		t.Fatalf("shutdown close status = %d (%v), want %d", status, err, websocket.StatusServiceRestart)
	}
}

func TestRealtimeRevokedMembershipDoesNotReceiveQueuedBody(t *testing.T) {
	cfg := realtimeTestConfig()
	harness := newRealtimeHarnessWithPoll(t, cfg, time.Hour)
	connection, _ := harness.connect(t, 0)
	defer connection.CloseNow()
	serviceWithoutWake := message.NewService(harness.pool, 64*1024, 100, nil)
	harness.createMessage(t, serviceWithoutWake, "must stay private")
	if _, err := harness.pool.Exec(context.Background(), `DELETE FROM chat_members WHERE chat_id = $1 AND actor_id = $2`, harness.chatID, harness.user.ActorID); err != nil {
		t.Fatal(err)
	}
	harness.dispatcher.WakeLocal()
	readCtx, cancel := context.WithTimeout(context.Background(), 250*time.Millisecond)
	defer cancel()
	_, _, err := connection.Read(readCtx)
	if err == nil {
		t.Fatal("revoked member received a durable event")
	}
}

func TestRealtimeRejectsRegressingAck(t *testing.T) {
	harness := newRealtimeHarness(t, realtimeTestConfig())
	connection, _ := harness.connect(t, 0)
	created := harness.createMessage(t, harness.messages, "ack")
	frame := readEvent(t, connection, 3*time.Second)
	if frame.Seq != created.CreatedSeq {
		t.Fatalf("event seq = %d, want %d", frame.Seq, created.CreatedSeq)
	}
	if err := wsjson.Write(context.Background(), connection, ackFrame{Op: "ack", Seq: frame.Seq}); err != nil {
		t.Fatal(err)
	}
	if err := wsjson.Write(context.Background(), connection, ackFrame{Op: "ack", Seq: 0}); err != nil {
		t.Fatal(err)
	}
	var protocolError protocolErrorFrame
	readJSON(t, connection, 3*time.Second, &protocolError)
	if protocolError.Code != "invalid_frame" {
		t.Fatalf("regressing ACK response = %+v", protocolError)
	}
}

func TestRealtimeResyncWhenCheckpointExpired(t *testing.T) {
	harness := newRealtimeHarness(t, realtimeTestConfig())
	first := harness.createMessage(t, harness.messages, "expired")
	second := harness.createMessage(t, harness.messages, "retained")
	if _, err := harness.pool.Exec(context.Background(), `DELETE FROM events WHERE org_id = $1 AND seq = $2`, harness.user.OrgID, first.CreatedSeq); err != nil {
		t.Fatal(err)
	}

	connection := dialAndAuthenticate(t, harness.httpServer.URL, harness.user.ActorID, 0)
	defer connection.CloseNow()
	var frame resyncFrame
	readJSON(t, connection, 3*time.Second, &frame)
	if frame.Op != "resync_required" || frame.CurrentSeq != second.CreatedSeq || frame.MinRetainedSeq != second.CreatedSeq-1 {
		t.Fatalf("resync frame = %+v", frame)
	}
	readCtx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	_, _, err := connection.Read(readCtx)
	if status := websocket.CloseStatus(err); status != statusResyncRequired {
		t.Fatalf("resync close status = %d (%v), want %d", status, err, statusResyncRequired)
	}
}

type realtimeHarness struct {
	pool       *pgxpool.Pool
	user       identity.User
	chatID     string
	store      *eventlog.Store
	hub        *Hub
	dispatcher *Dispatcher
	server     *Server
	httpServer *httptest.Server
	messages   *message.Service
}

func newRealtimeHarness(t *testing.T, cfg config.RealtimeConfig) *realtimeHarness {
	return newRealtimeHarnessWithPoll(t, cfg, 20*time.Millisecond)
}

func newRealtimeHarnessWithPoll(t *testing.T, cfg config.RealtimeConfig, pollInterval time.Duration) *realtimeHarness {
	t.Helper()
	pool := testdb.New(t)
	user, chatID := seedRealtimeFixture(t, pool)
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	store := eventlog.NewStore(pool)
	hub := NewHub(int(cfg.MaxConnectionsPerActor), int(cfg.MaxQueuedEvents), int(cfg.MaxQueuedBytes))
	dispatcher := NewDispatcher(logger, store, hub, pollInterval, time.Millisecond)
	sessionID := realtimeID(t)
	authenticate := func(_ context.Context, token string) (identity.User, access.Identity, error) {
		if token != user.ActorID {
			return identity.User{}, access.Identity{}, identity.ErrUnauthorized
		}
		return user, access.Identity{ActorID: user.ActorID, OrgID: user.OrgID, SessionID: sessionID, Role: user.OrgRole}, nil
	}
	ephemeral, err := NewEphemeral(logger, pool, hub, cfg, config.RedisConfig{Mode: "disabled", Namespace: "coma:test", OperationTimeout: time.Second})
	if err != nil {
		t.Fatal(err)
	}
	server := NewServer(logger, "http://example.test", store, hub, authenticate, cfg, ephemeral)
	httpServer := httptest.NewServer(server)
	ctx, cancel := context.WithCancel(context.Background())
	go dispatcher.Run(ctx)
	t.Cleanup(func() {
		server.Shutdown()
		cancel()
		httpServer.Close()
	})
	return &realtimeHarness{
		pool: pool, user: user, chatID: chatID, store: store, hub: hub, dispatcher: dispatcher,
		server: server, httpServer: httpServer, messages: message.NewService(pool, 64*1024, 100, func(string, int64) { dispatcher.WakeLocal() }),
	}
}

func (h *realtimeHarness) connect(t *testing.T, lastSeq int64) (*websocket.Conn, helloFrame) {
	t.Helper()
	connection := dialAndAuthenticate(t, h.httpServer.URL, h.user.ActorID, lastSeq)
	var hello helloFrame
	readJSON(t, connection, 3*time.Second, &hello)
	if hello.Op != "hello" {
		connection.CloseNow()
		t.Fatalf("first server frame = %+v, want hello", hello)
	}
	return connection, hello
}

func (h *realtimeHarness) createMessage(t *testing.T, service *message.Service, body string) message.Message {
	t.Helper()
	result, created, err := service.Create(context.Background(), h.user, h.chatID, message.CreateInput{
		ClientMsgID: realtimeID(t), Body: body, BodyFormat: "plain",
	})
	if err != nil || !created {
		t.Fatalf("Create() = %+v, %v, %v", result, created, err)
	}
	return result
}

func dialAndAuthenticate(t *testing.T, serverURL, token string, lastSeq int64) *websocket.Conn {
	t.Helper()
	wsURL := "ws" + strings.TrimPrefix(serverURL, "http")
	connection, response, err := websocket.Dial(context.Background(), wsURL, &websocket.DialOptions{
		HTTPHeader: standardhttp.Header{"Origin": []string{"http://example.test"}},
	})
	if err != nil {
		if response != nil {
			t.Fatalf("websocket dial: %v (HTTP %d)", err, response.StatusCode)
		}
		t.Fatal(err)
	}
	if err := wsjson.Write(context.Background(), connection, authFrame{
		Op: "auth", RequestID: realtimeID(t), AccessToken: token, LastSeq: lastSeq,
	}); err != nil {
		connection.CloseNow()
		t.Fatal(err)
	}
	return connection
}

func readEvent(t *testing.T, connection *websocket.Conn, timeout time.Duration) eventlog.Frame {
	t.Helper()
	var frame eventlog.Frame
	readJSON(t, connection, timeout, &frame)
	if frame.Op != "event" {
		t.Fatalf("frame op = %q, want event", frame.Op)
	}
	return frame
}

func readJSON(t *testing.T, connection *websocket.Conn, timeout time.Duration, destination any) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	if err := wsjson.Read(ctx, connection, destination); err != nil {
		t.Fatal(err)
	}
}

func seedRealtimeFixture(t *testing.T, pool *pgxpool.Pool) (identity.User, string) {
	t.Helper()
	orgID := realtimeID(t)
	owner := identity.User{ActorID: realtimeID(t), OrgID: orgID, OrgRole: "owner", Status: "active"}
	user := identity.User{ActorID: realtimeID(t), OrgID: orgID, OrgRole: "member", Status: "active"}
	chatID := realtimeID(t)
	ctx := context.Background()
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, `INSERT INTO organizations (id, name, slug) VALUES ($1, 'Realtime', 'realtime-test')`, orgID); err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO actors (id, org_id, type, org_role, display_name, handle)
		VALUES ($1, $3, 'user', 'owner', 'Owner', 'realtime_owner'),
		       ($2, $3, 'user', 'member', 'Member', 'realtime_member')`, owner.ActorID, user.ActorID, orgID); err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO chats (id, org_id, kind, visibility, name, created_by)
		VALUES ($1, $2, 'group', 'private', 'Realtime', $3)`, chatID, orgID, owner.ActorID); err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO chat_members (chat_id, actor_id, org_id, role)
		VALUES ($1, $2, $3, 'owner'), ($1, $4, $3, 'member')`, chatID, owner.ActorID, orgID, user.ActorID); err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	return user, chatID
}

func realtimeTestConfig() config.RealtimeConfig {
	return config.RealtimeConfig{
		AuthTimeout: time.Second, MaxFrameBytes: 256 * 1024, MaxConnectionsPerActor: 10,
		MaxQueuedEvents: 256, MaxQueuedBytes: 1024 * 1024, MaxUnackedEvents: 128,
		HeartbeatInterval: time.Hour, PongTimeout: time.Second, AckInterval: 100 * time.Millisecond,
		AckTimeout: 2 * time.Second, AckBatchSize: 10,
		TypingTTL: time.Second, PresenceTTL: 10 * time.Second, ActiveSubscriptionTTL: 10 * time.Second,
		EphemeralRateLimit: 100, EphemeralRateWindow: time.Second,
	}
}

func realtimeID(t *testing.T) string {
	t.Helper()
	value, err := id.New()
	if err != nil {
		t.Fatal(err)
	}
	return value
}

func TestRealtimeRejectsOriginAndAuthentication(t *testing.T) {
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	server := NewServer(logger, "http://allowed.test", nil, NewHub(1), func(context.Context, string) (identity.User, access.Identity, error) {
		return identity.User{}, access.Identity{}, errors.New("denied")
	}, realtimeTestConfig(), nil)
	httpServer := httptest.NewServer(server)
	defer httpServer.Close()
	wsURL := "ws" + strings.TrimPrefix(httpServer.URL, "http")
	_, response, err := websocket.Dial(context.Background(), wsURL, &websocket.DialOptions{
		HTTPHeader: standardhttp.Header{"Origin": []string{"http://evil.test"}},
	})
	if err == nil || response == nil || response.StatusCode != standardhttp.StatusForbidden {
		t.Fatalf("invalid origin dial = response %#v, error %v", response, err)
	}

	connection, _, err := websocket.Dial(context.Background(), wsURL, &websocket.DialOptions{
		HTTPHeader: standardhttp.Header{"Origin": []string{"http://allowed.test"}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := wsjson.Write(context.Background(), connection, authFrame{
		Op: "auth", RequestID: realtimeID(t), AccessToken: "expired", LastSeq: 0,
	}); err != nil {
		t.Fatal(err)
	}
	readCtx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	_, _, err = connection.Read(readCtx)
	cancel()
	if status := websocket.CloseStatus(err); status != statusAuthenticationFailed {
		t.Fatalf("authentication close status = %d (%v), want %d", status, err, statusAuthenticationFailed)
	}

	malformed, _, err := websocket.Dial(context.Background(), wsURL, &websocket.DialOptions{
		HTTPHeader: standardhttp.Header{"Origin": []string{"http://allowed.test"}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := wsjson.Write(context.Background(), malformed, map[string]any{
		"op": "auth", "request_id": realtimeID(t), "access_token": "x", "last_seq": 0, "unknown": true,
	}); err != nil {
		t.Fatal(err)
	}
	var protocolError protocolErrorFrame
	readJSON(t, malformed, 2*time.Second, &protocolError)
	if protocolError.Code != "invalid_frame" {
		t.Fatalf("malformed auth response = %+v", protocolError)
	}
}
