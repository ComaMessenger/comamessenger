package realtime

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"
	"github.com/comamessenger/comamessenger/core/internal/config"
	"github.com/comamessenger/comamessenger/core/internal/identity"
	"github.com/comamessenger/comamessenger/core/internal/testdb"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	redis "github.com/redis/go-redis/v9"
)

func TestTypingActionIsValidatedAndBackwardCompatible(t *testing.T) {
	// A frame from a client before the field decodes strictly, and so does one
	// that names the action.
	var legacy typingFrame
	if err := decodeStrict([]byte(`{"op":"typing","chat_id":"`+uuid.NewString()+`","thread_root_id":null,"active":true}`), &legacy); err != nil || legacy.Action != nil {
		t.Fatalf("legacy frame = %+v, %v", legacy, err)
	}
	var withAction typingFrame
	if err := decodeStrict([]byte(`{"op":"typing","chat_id":"`+uuid.NewString()+`","thread_root_id":null,"active":true,"action":"uploading_photo"}`), &withAction); err != nil || withAction.Action == nil || *withAction.Action != "uploading_photo" {
		t.Fatalf("action frame = %+v, %v", withAction, err)
	}

	pool, service, member, chatID, sender, receiver := typingFixture(t, 100)
	_ = pool
	if err := service.Typing(t.Context(), member, sender, chatID, nil, true, nil); err != nil {
		t.Fatal(err)
	}
	var event typingEventFrame
	readEphemeral(t, receiver, &event)
	if event.Action != "typing" {
		t.Fatalf("frame without action is sent as %q", event.Action)
	}
	for _, action := range []string{"recording_voice", "uploading_photo", "uploading_video", "uploading_file", "typing"} {
		action := action
		if err := service.Typing(t.Context(), member, sender, chatID, nil, true, &action); err != nil {
			t.Fatalf("%s: %v", action, err)
		}
		readEphemeral(t, receiver, &event)
		if event.Action != action || !event.Active {
			t.Fatalf("%s: event = %+v", action, event)
		}
	}
	bad := "dancing"
	if err := service.Typing(t.Context(), member, sender, chatID, nil, true, &bad); !errors.Is(err, ErrEphemeralInvalid) {
		t.Fatalf("unknown action error = %v", err)
	}
	empty := ""
	if err := service.Typing(t.Context(), member, sender, chatID, nil, true, &empty); !errors.Is(err, ErrEphemeralInvalid) {
		t.Fatalf("empty action error = %v", err)
	}

	// An old client reading the new frame just ignores the field.
	payload, _ := json.Marshal(typingEventFrame{Op: "typing", ActorID: member.ActorID, ChatID: chatID, Active: true, Action: "recording_voice", ExpiresAt: time.Now()})
	var old struct {
		Op      string `json:"op"`
		ActorID string `json:"actor_id"`
		Active  bool   `json:"active"`
	}
	if err := json.Unmarshal(payload, &old); err != nil || !old.Active {
		t.Fatalf("old client decode = %+v, %v", old, err)
	}

	// Envelopes relayed through Redis are checked the same way.
	relay := &Ephemeral{signingKey: []byte("0123456789abcdef0123456789abcdef")}
	for action, valid := range map[string]bool{"recording_voice": true, "": true, "dancing": false} {
		frame := typingEventFrame{Op: "typing", ActorID: member.ActorID, ChatID: chatID, Active: true, Action: action, ExpiresAt: time.Now()}
		data, _ := json.Marshal(frame)
		envelope := ephemeralEnvelope{OrgID: member.OrgID, ActorIDs: []string{member.ActorID}, Data: data}
		envelope.Signature = relay.signEnvelope(envelope)
		raw, _ := json.Marshal(envelope)
		if _, err := relay.decodeEphemeralEnvelope(raw); (err == nil) != valid {
			t.Fatalf("relay action %q: err = %v", action, err)
		}
	}
}

func TestTypingActionSharesTypingRateLimit(t *testing.T) {
	_, service, member, chatID, sender, _ := typingFixture(t, 1)
	if err := service.Typing(t.Context(), member, sender, chatID, nil, true, nil); err != nil {
		t.Fatal(err)
	}
	voice := "recording_voice"
	if err := service.Typing(t.Context(), member, sender, chatID, nil, true, &voice); !errors.Is(err, ErrEphemeralRateLimited) {
		t.Fatalf("second action in window error = %v", err)
	}
}

func typingFixture(t *testing.T, limit uint64) (*pgxpool.Pool, *Ephemeral, identity.User, string, *Subscription, *Subscription) {
	t.Helper()
	pool := testdbPool(t)
	member, chatID := seedRealtimeFixture(t, pool)
	var ownerID string
	if err := pool.QueryRow(t.Context(), `SELECT id FROM actors WHERE org_id=$1 AND org_role='owner'`, member.OrgID).Scan(&ownerID); err != nil {
		t.Fatal(err)
	}
	hub := NewHub(10)
	sender, _ := hub.Register(member.OrgID, member.ActorID, "s1", uuid.NewString(), 0)
	t.Cleanup(sender.Close)
	receiver, _ := hub.Register(member.OrgID, ownerID, "s2", uuid.NewString(), 0)
	t.Cleanup(receiver.Close)
	cfg := realtimeTestConfig()
	cfg.EphemeralRateLimit = limit
	cfg.EphemeralRateWindow = time.Minute
	service := newTestEphemeral(t, pool, hub, cfg)
	if err := service.SubscribeActive(t.Context(), member, sender, &chatID, nil); err != nil {
		t.Fatal(err)
	}
	// SubscribeActive spends from its own bucket, not from typing.
	return pool, service, member, chatID, sender, receiver
}

func newTestEphemeral(t *testing.T, pool *pgxpool.Pool, hub *Hub, cfg config.RealtimeConfig) *Ephemeral {
	t.Helper()
	service, err := NewEphemeral(slog.New(slog.NewTextHandler(io.Discard, nil)), pool, hub, cfg, config.RedisConfig{Mode: "disabled", Namespace: "coma:test", OperationTimeout: time.Second})
	if err != nil {
		t.Fatal(err)
	}
	return service
}

func TestLocalPresenceAggregatesConnections(t *testing.T) {
	tracker := newLocalPresence(10 * time.Second)
	ctx := context.Background()
	now := time.Date(2026, 11, 14, 12, 0, 0, 0, time.UTC)
	step := func(connection, state string, at time.Time, wantState string, wantBroadcast bool) {
		t.Helper()
		change, err := tracker.update(ctx, "org", "actor", connection, state, at)
		if err != nil {
			t.Fatal(err)
		}
		if change.State != wantState || change.Broadcast != wantBroadcast {
			t.Fatalf("%s %q at %s: %+v, want %s broadcast=%v", connection, state, at.Sub(now), change, wantState, wantBroadcast)
		}
	}
	step("phone", "away", now, "away", true)
	step("web", "active", now, "online", true)
	step("phone", "away", now.Add(time.Second), "online", false)  // unchanged: nothing to send
	step("web", "active", now.Add(6*time.Second), "online", true) // past half the TTL: refresh
	step("web", "", now.Add(7*time.Second), "away", true)
	if entries, _ := tracker.snapshot(ctx, "org", now.Add(7*time.Second)); len(entries) != 1 || entries[0].State != "away" {
		t.Fatalf("snapshot = %+v", entries)
	}
	step("phone", "", now.Add(8*time.Second), "offline", true)
	step("phone", "", now.Add(9*time.Second), "offline", false) // already gone
	if entries, _ := tracker.snapshot(ctx, "org", now.Add(9*time.Second)); len(entries) != 0 {
		t.Fatalf("snapshot after offline = %+v", entries)
	}
	// A connection that stops confirming expires on its own; receivers have
	// already dropped it by expires_at, so there is nothing more to send.
	step("tab", "active", now.Add(20*time.Second), "online", true)
	step("other", "", now.Add(31*time.Second), "offline", false)
}

// lastSeenWorld: member and owner share a chat; stranger shares none; helper
// is an agent in the chat, outsider an agent outside it.
type lastSeenWorld struct {
	pool                                     *pgxpool.Pool
	service                                  *Ephemeral
	member                                   identity.User
	chatID                                   string
	memberConn                               *Subscription
	owner, stranger, helper, outsider        *Subscription
	ownerID, strangerID, helperID, outsideID string
}

func newLastSeenWorld(t *testing.T) lastSeenWorld {
	t.Helper()
	pool := testdbPool(t)
	member, chatID := seedRealtimeFixture(t, pool)
	world := lastSeenWorld{pool: pool, member: member, chatID: chatID, strangerID: uuid.NewString(), helperID: uuid.NewString(), outsideID: uuid.NewString()}
	ctx := t.Context()
	if err := pool.QueryRow(ctx, `SELECT id FROM actors WHERE org_id=$1 AND org_role='owner'`, member.OrgID).Scan(&world.ownerID); err != nil {
		t.Fatal(err)
	}
	mustExec(t, pool, `INSERT INTO actors(id,org_id,type,org_role,display_name,handle) VALUES($1,$4,'user','member','Stranger','ls_stranger'),($2,$4,'agent','member','Helper','ls_helper'),($3,$4,'agent','member','Outsider','ls_outsider')`, world.strangerID, world.helperID, world.outsideID, member.OrgID)
	mustExec(t, pool, `INSERT INTO users(actor_id,org_id,email,password_hash) VALUES($1,$4,'member@ls.test','x'),($2,$4,'owner@ls.test','x'),($3,$4,'stranger@ls.test','x')`, member.ActorID, world.ownerID, world.strangerID, member.OrgID)
	mustExec(t, pool, `INSERT INTO chat_members(chat_id,actor_id,org_id,role) VALUES($1,$2,$3,'member')`, chatID, world.helperID, member.OrgID)
	hub := NewHub(10)
	register := func(actorID string) *Subscription {
		subscription, err := hub.Register(member.OrgID, actorID, uuid.NewString(), uuid.NewString(), 0)
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(subscription.Close)
		return subscription
	}
	world.memberConn = register(member.ActorID)
	world.owner, world.stranger, world.helper, world.outsider = register(world.ownerID), register(world.strangerID), register(world.helperID), register(world.outsideID)
	world.service = newTestEphemeral(t, pool, hub, realtimeTestConfig())
	return world
}

func (w lastSeenWorld) leave(t *testing.T) map[string]presenceEventFrame {
	t.Helper()
	if err := w.service.Presence(t.Context(), w.member, w.memberConn, "active"); err != nil {
		t.Fatal(err)
	}
	for _, subscription := range []*Subscription{w.owner, w.stranger, w.helper, w.outsider} {
		var online presenceEventFrame
		readEphemeral(t, subscription, &online)
		if online.State != "online" || online.LastSeenAt != nil {
			t.Fatalf("online frame = %+v", online)
		}
	}
	w.service.Disconnected(t.Context(), w.member, w.memberConn.ConnectionID)
	result := make(map[string]presenceEventFrame)
	for name, subscription := range map[string]*Subscription{"owner": w.owner, "stranger": w.stranger, "helper": w.helper, "outsider": w.outsider} {
		var frame presenceEventFrame
		readEphemeral(t, subscription, &frame)
		if frame.State != "offline" || frame.ActorID != w.member.ActorID {
			t.Fatalf("%s offline frame = %+v", name, frame)
		}
		result[name] = frame
	}
	return result
}

func TestOfflinePresenceCarriesLastSeenOnlyToSharedChats(t *testing.T) {
	world := newLastSeenWorld(t)
	frames := world.leave(t)
	if frames["owner"].LastSeenAt == nil || frames["helper"].LastSeenAt == nil {
		t.Fatalf("shared chat recipients lack last seen: owner=%v helper=%v", frames["owner"].LastSeenAt, frames["helper"].LastSeenAt)
	}
	if frames["stranger"].LastSeenAt != nil || frames["outsider"].LastSeenAt != nil {
		t.Fatalf("recipients without a shared chat got last seen: stranger=%v outsider=%v", frames["stranger"].LastSeenAt, frames["outsider"].LastSeenAt)
	}
	var stored *time.Time
	if err := world.pool.QueryRow(t.Context(), `SELECT last_seen_at FROM users WHERE actor_id=$1`, world.member.ActorID).Scan(&stored); err != nil || stored == nil {
		t.Fatalf("last_seen_at not stored: %v %v", stored, err)
	}
}

func TestLastSeenNobodyHidesBothWays(t *testing.T) {
	world := newLastSeenWorld(t)
	mustExec(t, world.pool, `UPDATE users SET preferences=preferences||'{"last_seen_visibility":"nobody"}' WHERE actor_id=$1`, world.member.ActorID)
	frames := world.leave(t)
	for name, frame := range frames {
		if frame.LastSeenAt != nil {
			t.Fatalf("%s sees hidden last seen", name)
		}
	}

	// Symmetric: an owner who hides their own time sees nobody's.
	world = newLastSeenWorld(t)
	mustExec(t, world.pool, `UPDATE users SET preferences=preferences||'{"last_seen_visibility":"nobody"}' WHERE actor_id=$1`, world.ownerID)
	frames = world.leave(t)
	if frames["owner"].LastSeenAt != nil {
		t.Fatal("viewer who hides last seen still sees the exact time")
	}
	if frames["helper"].LastSeenAt == nil {
		t.Fatal("other shared-chat recipients lose last seen")
	}
}

func TestLastSeenIsWrittenAtMostOncePerMinute(t *testing.T) {
	world := newLastSeenWorld(t)
	ctx := t.Context()
	read := func() time.Time {
		t.Helper()
		var at *time.Time
		if err := world.pool.QueryRow(ctx, `SELECT last_seen_at FROM users WHERE actor_id=$1`, world.member.ActorID).Scan(&at); err != nil || at == nil {
			t.Fatalf("last_seen_at = %v, %v", at, err)
		}
		return *at
	}
	if err := world.service.Presence(ctx, world.member, world.memberConn, "active"); err != nil {
		t.Fatal(err)
	}
	first := read()
	time.Sleep(20 * time.Millisecond)
	for range 3 {
		if err := world.service.Presence(ctx, world.member, world.memberConn, "active"); err != nil {
			t.Fatal(err)
		}
		if err := world.service.Presence(ctx, world.member, world.memberConn, "away"); err != nil {
			t.Fatal(err)
		}
	}
	if !read().Equal(first) {
		t.Fatal("last_seen_at rewritten within a minute")
	}
	// Another instance (no in-memory memory of the write) is held back by
	// the guard in the UPDATE.
	world.service.mu.Lock()
	world.service.lastSeenWrites = make(map[string]time.Time)
	world.service.mu.Unlock()
	mustExec(t, world.pool, `UPDATE users SET last_seen_at=now()-interval '30 seconds' WHERE actor_id=$1`, world.member.ActorID)
	held := read()
	world.service.touchLastSeen(ctx, world.member, time.Now())
	if !read().Equal(held) {
		t.Fatal("UPDATE guard let a second write through within a minute")
	}
	// After a minute the next confirmation writes again.
	world.service.mu.Lock()
	world.service.lastSeenWrites[world.member.OrgID+":"+world.member.ActorID] = time.Now().Add(-2 * time.Minute)
	world.service.mu.Unlock()
	mustExec(t, world.pool, `UPDATE users SET last_seen_at=now()-interval '2 minutes' WHERE actor_id=$1`, world.member.ActorID)
	stale := read()
	world.service.touchLastSeen(ctx, world.member, time.Now())
	if !read().After(stale) {
		t.Fatal("last_seen_at not refreshed after a minute")
	}
}

func mustExec(t *testing.T, pool *pgxpool.Pool, query string, args ...any) {
	t.Helper()
	if _, err := pool.Exec(t.Context(), query, args...); err != nil {
		t.Fatal(err)
	}
}

func testdbPool(t *testing.T) *pgxpool.Pool { return testdb.New(t) }

func TestRealtimeSnapshotAfterHelloAndOfflineOnLastClose(t *testing.T) {
	harness := newRealtimeHarness(t, realtimeTestConfig())
	device, _ := harness.connect(t, 0)
	watcher, _ := harness.connect(t, 0)
	defer watcher.CloseNow()
	if err := wsjson.Write(t.Context(), device, map[string]any{"op": "presence", "state": "active"}); err != nil {
		t.Fatal(err)
	}
	var online presenceEventFrame
	readJSON(t, watcher, 3*time.Second, &online)
	if online.Op != "presence" || online.State != "online" {
		t.Fatalf("online frame = %+v", online)
	}
	late := dialAndAuthenticate(t, harness.httpServer.URL, harness.user.ActorID, 0)
	defer late.CloseNow()
	var hello helloFrame
	readJSON(t, late, 3*time.Second, &hello)
	var snapshot presenceSnapshotFrame
	readJSON(t, late, 3*time.Second, &snapshot)
	if snapshot.Op != "presence.snapshot" || len(snapshot.Actors) != 1 || snapshot.Actors[0].ActorID != harness.user.ActorID || snapshot.Actors[0].State != "online" {
		t.Fatalf("snapshot = %+v", snapshot)
	}
	_ = device.Close(websocket.StatusNormalClosure, "bye")
	var offline presenceEventFrame
	readJSON(t, watcher, 3*time.Second, &offline)
	if offline.Op != "presence" || offline.State != "offline" || offline.ActorID != harness.user.ActorID {
		t.Fatalf("offline frame = %+v", offline)
	}
}

func TestRedisPresenceMatchesLocalModel(t *testing.T) {
	redisURL := os.Getenv("TEST_REDIS_URL")
	if redisURL == "" {
		t.Skip("TEST_REDIS_URL is not set")
	}
	options, err := redis.ParseURL(redisURL)
	if err != nil {
		t.Fatal(err)
	}
	client := redis.NewClient(options)
	defer client.Close()
	tracker := &redisPresence{client: client, namespace: fmt.Sprintf("coma:presence:test:%d", time.Now().UnixNano()), ttl: 10 * time.Second, timeout: time.Second}
	local := newLocalPresence(10 * time.Second)
	ctx := t.Context()
	now := time.Now().UTC().Truncate(time.Millisecond)
	steps := []struct {
		connection, state string
		at                time.Duration
	}{
		{"phone", "away", 0}, {"web", "active", 0}, {"phone", "away", time.Second}, {"web", "active", 6 * time.Second},
		{"web", "", 7 * time.Second}, {"phone", "", 8 * time.Second}, {"phone", "", 9 * time.Second},
	}
	for _, step := range steps {
		want, _ := local.update(ctx, "org", "actor", step.connection, step.state, now.Add(step.at))
		got, err := tracker.update(ctx, "org", "actor", step.connection, step.state, now.Add(step.at))
		if err != nil {
			t.Fatal(err)
		}
		if got.State != want.State || got.Broadcast != want.Broadcast || !got.ExpiresAt.Equal(want.ExpiresAt) {
			t.Fatalf("%+v: redis %+v, local %+v", step, got, want)
		}
		if step.at == 0 && step.connection == "web" {
			entries, err := tracker.snapshot(ctx, "org", now)
			if err != nil || len(entries) != 1 || entries[0].State != "online" {
				t.Fatalf("snapshot = %+v, %v", entries, err)
			}
		}
	}
}

func TestEphemeralFrameTimesHaveMillisecondPrecision(t *testing.T) {
	data, _ := json.Marshal(typingEventFrame{Op: "typing", ExpiresAt: frameNow()})
	var raw struct {
		ExpiresAt string `json:"expires_at"`
	}
	_ = json.Unmarshal(data, &raw)
	if _, fraction, ok := strings.Cut(strings.TrimSuffix(raw.ExpiresAt, "Z"), "."); ok && len(fraction) > 3 {
		t.Fatalf("expires_at %q has more than milliseconds", raw.ExpiresAt)
	}
}
