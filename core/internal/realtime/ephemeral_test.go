package realtime

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"testing"
	"time"

	"github.com/comamessenger/comamessenger/core/internal/access"
	"github.com/comamessenger/comamessenger/core/internal/config"
	"github.com/comamessenger/comamessenger/core/internal/identity"
	"github.com/comamessenger/comamessenger/core/internal/testdb"
	"github.com/google/uuid"
)

func TestLocalEphemeralTypingPresenceAndRateLimit(t *testing.T) {
	pool := testdb.New(t)
	member, chatID := seedRealtimeFixture(t, pool)
	var owner identity.User
	if err := pool.QueryRow(context.Background(), `SELECT id,org_id,org_role,status FROM actors WHERE org_id=$1 AND org_role='owner'`, member.OrgID).Scan(&owner.ActorID, &owner.OrgID, &owner.OrgRole, &owner.Status); err != nil {
		t.Fatal(err)
	}
	hub := NewHub(10)
	sender, err := hub.Register(member.OrgID, member.ActorID, "session-sender", "sender", 0)
	if err != nil {
		t.Fatal(err)
	}
	defer sender.Close()
	receiver, err := hub.Register(owner.OrgID, owner.ActorID, "session-receiver", "receiver", 0)
	if err != nil {
		t.Fatal(err)
	}
	defer receiver.Close()
	cfg := realtimeTestConfig()
	cfg.TypingTTL = time.Second
	cfg.PresenceTTL = 10 * time.Second
	cfg.ActiveSubscriptionTTL = 10 * time.Second
	cfg.EphemeralRateLimit = 1
	cfg.EphemeralRateWindow = time.Minute
	service, err := NewEphemeral(slog.New(slog.NewTextHandler(io.Discard, nil)), pool, hub, cfg, config.RedisConfig{Mode: "disabled", Namespace: "coma:test", OperationTimeout: time.Second})
	if err != nil {
		t.Fatal(err)
	}
	if err := service.Typing(context.Background(), member, sender, chatID, nil, true); err != ErrEphemeralForbidden {
		t.Fatalf("typing without active error = %v", err)
	}
	if err := service.SubscribeActive(context.Background(), member, sender, &chatID, nil); err != nil {
		t.Fatal(err)
	}
	if err := service.Typing(context.Background(), member, sender, chatID, nil, true); err != nil {
		t.Fatal(err)
	}
	var typing typingEventFrame
	readEphemeral(t, receiver, &typing)
	if typing.ActorID != member.ActorID || !typing.Active || typing.ChatID != chatID {
		t.Fatalf("typing = %+v", typing)
	}
	if err := service.Presence(context.Background(), member, sender, "active"); err != nil {
		t.Fatal(err)
	}
	var presence presenceEventFrame
	readEphemeral(t, receiver, &presence)
	if presence.ActorID != member.ActorID || presence.State != "online" {
		t.Fatalf("presence = %+v", presence)
	}
	if err := service.Presence(context.Background(), member, sender, "away"); err != ErrEphemeralRateLimited {
		t.Fatalf("rate limit error = %v", err)
	}
}

func TestAgentStatusAndStreamingRequireRuntimeRun(t *testing.T) {
	pool := testdb.New(t)
	member, chatID := seedRealtimeFixture(t, pool)
	var ownerID string
	if err := pool.QueryRow(t.Context(), `SELECT id FROM actors WHERE org_id=$1 AND org_role='owner'`, member.OrgID).Scan(&ownerID); err != nil {
		t.Fatal(err)
	}
	agentID, runID, leaseToken := uuid.NewString(), uuid.NewString(), uuid.NewString()
	if _, err := pool.Exec(t.Context(), `INSERT INTO actors(id,org_id,type,org_role,display_name,handle) VALUES($1,$2,'agent','member','Agent','realtime_agent')`, agentID, member.OrgID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(t.Context(), `INSERT INTO agents(actor_id,org_id,owner_actor_id,kind,enabled,allowed_scopes) VALUES($1,$2,$3,'builtin',true,ARRAY['messages:read','runtime:execute'])`, agentID, member.OrgID, ownerID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(t.Context(), `INSERT INTO chat_members(chat_id,actor_id,org_id,role) VALUES($1,$2,$3,'member')`, chatID, agentID, member.OrgID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(t.Context(), `INSERT INTO agent_runs(id,org_id,agent_id,chat_id,correlation_id,status,lease_token,lease_expires_at,started_at) VALUES($1,$2,$3,$4,$5,'running',$6,now()+interval '1 minute',now())`, runID, member.OrgID, agentID, chatID, uuid.NewString(), leaseToken); err != nil {
		t.Fatal(err)
	}
	hub := NewHub(10)
	sender, _ := hub.Register(member.OrgID, agentID, "agent-session", uuid.NewString(), 0)
	defer sender.Close()
	receiver, _ := hub.Register(member.OrgID, member.ActorID, "member-session", uuid.NewString(), 0)
	defer receiver.Close()
	cfg := realtimeTestConfig()
	cfg.EphemeralRateLimit = 1
	service, err := NewEphemeral(slog.New(slog.NewTextHandler(io.Discard, nil)), pool, hub, cfg, config.RedisConfig{Mode: "disabled", Namespace: "coma:test", OperationTimeout: time.Second})
	if err != nil {
		t.Fatal(err)
	}
	agentUser := identity.User{ActorID: agentID, OrgID: member.OrgID, Status: "active"}
	authentication := access.Identity{AuthenticationKind: "api_key", ActorID: agentID, OrgID: member.OrgID, KeyID: uuid.NewString(), Scopes: []string{"messages:read", "runtime:execute"}}
	status := agentStatusFrame{Op: "agent.status", RunID: runID, ChatID: chatID, State: "thinking"}
	if err := service.AgentStatus(t.Context(), agentUser, access.Identity{}, sender, status); !errors.Is(err, ErrEphemeralForbidden) {
		t.Fatalf("human status error = %v", err)
	}
	if err := service.AgentStatus(t.Context(), agentUser, authentication, sender, status); err != nil {
		t.Fatal(err)
	}
	var receivedStatus agentStatusEventFrame
	readEphemeral(t, receiver, &receivedStatus)
	if receivedStatus.RunID != runID || receivedStatus.ActorID != agentID || receivedStatus.State != "thinking" {
		t.Fatalf("agent status = %+v", receivedStatus)
	}
	streamID := uuid.NewString()
	if err := service.MessageStreaming(t.Context(), agentUser, authentication, sender, messageStreamingFrame{Op: "message.streaming", RunID: runID, ChatID: chatID, StreamID: streamID, Index: 1, Delta: "Hello"}); err != nil {
		t.Fatal(err)
	}
	var stream messageStreamingEventFrame
	readEphemeral(t, receiver, &stream)
	if stream.StreamID != streamID || stream.Delta != "Hello" || stream.Done {
		t.Fatalf("message stream = %+v", stream)
	}
	if err := service.MessageStreaming(t.Context(), agentUser, authentication, sender, messageStreamingFrame{Op: "message.streaming", RunID: runID, ChatID: chatID, StreamID: streamID, Index: 2, Delta: " world"}); err != nil {
		t.Fatalf("streaming should use its dedicated higher rate limit: %v", err)
	}
}

func TestRedisEphemeralCrossCoreFanout(t *testing.T) {
	redisURL := os.Getenv("TEST_REDIS_URL")
	if redisURL == "" {
		t.Skip("TEST_REDIS_URL is not set")
	}
	pool := testdb.New(t)
	member, _ := seedRealtimeFixture(t, pool)
	var owner identity.User
	if err := pool.QueryRow(context.Background(), `SELECT id,org_id,org_role,status FROM actors WHERE org_id=$1 AND org_role='owner'`, member.OrgID).Scan(&owner.ActorID, &owner.OrgID, &owner.OrgRole, &owner.Status); err != nil {
		t.Fatal(err)
	}
	cfg := realtimeTestConfig()
	cfg.PresenceTTL = 10 * time.Second
	cfg.EphemeralRateLimit = 100
	cfg.EphemeralRateWindow = time.Second
	redisCfg := config.RedisConfig{Mode: "required", URL: redisURL, Namespace: fmt.Sprintf("coma:ephemeral:test:%d", time.Now().UnixNano()), EphemeralSigningKey: "0123456789abcdef0123456789abcdef", ConnectTimeout: time.Second, OperationTimeout: time.Second}
	hub1, hub2 := NewHub(10), NewHub(10)
	sender, _ := hub1.Register(member.OrgID, member.ActorID, "session-sender", uuid.NewString(), 0)
	defer sender.Close()
	receiver, _ := hub2.Register(owner.OrgID, owner.ActorID, "session-receiver", "receiver", 0)
	defer receiver.Close()
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	first, err := NewEphemeral(logger, pool, hub1, cfg, redisCfg)
	if err != nil {
		t.Fatal(err)
	}
	defer first.Close()
	second, err := NewEphemeral(logger, pool, hub2, cfg, redisCfg)
	if err != nil {
		t.Fatal(err)
	}
	defer second.Close()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go first.Run(ctx)
	go second.Run(ctx)
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		_ = first.Presence(context.Background(), member, sender, "active")
		select {
		case payload := <-receiver.Ephemeral():
			var frame presenceEventFrame
			if err := json.Unmarshal(payload, &frame); err != nil {
				t.Fatal(err)
			}
			if frame.ActorID != member.ActorID || frame.State != "online" {
				t.Fatalf("cross-core presence = %+v", frame)
			}
			return
		case <-time.After(50 * time.Millisecond):
		}
	}
	t.Fatal("timed out waiting for cross-core Redis ephemeral frame")
}

func TestEphemeralEnvelopeRequiresValidSignature(t *testing.T) {
	service := &Ephemeral{signingKey: []byte("0123456789abcdef0123456789abcdef")}
	envelope := ephemeralEnvelope{
		OrgID:    uuid.NewString(),
		ActorIDs: []string{uuid.NewString()},
		Data:     json.RawMessage(`{"op":"presence","actor_id":"` + uuid.NewString() + `","state":"online","expires_at":"2030-01-01T00:00:00Z"}`),
	}
	envelope.Signature = service.signEnvelope(envelope)
	payload, err := json.Marshal(envelope)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := service.decodeEphemeralEnvelope(payload); err != nil {
		t.Fatalf("decode signed envelope: %v", err)
	}

	envelope.Data = json.RawMessage(`{"op":"presence","actor_id":"` + uuid.NewString() + `","state":"away","expires_at":"2030-01-01T00:00:00Z"}`)
	tampered, err := json.Marshal(envelope)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := service.decodeEphemeralEnvelope(tampered); !errors.Is(err, ErrEphemeralInvalid) {
		t.Fatalf("decode tampered envelope error = %v, want ErrEphemeralInvalid", err)
	}
}

func readEphemeral(t *testing.T, subscription *Subscription, destination any) {
	t.Helper()
	select {
	case payload := <-subscription.Ephemeral():
		if err := json.Unmarshal(payload, destination); err != nil {
			t.Fatal(err)
		}
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for ephemeral frame")
	}
}
