package realtime

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"os"
	"testing"
	"time"

	"github.com/comamessenger/comamessenger/core/internal/config"
	"github.com/comamessenger/comamessenger/core/internal/identity"
	"github.com/comamessenger/comamessenger/core/internal/testdb"
)

func TestLocalEphemeralTypingPresenceAndRateLimit(t *testing.T) {
	pool := testdb.New(t)
	member, chatID := seedRealtimeFixture(t, pool)
	var owner identity.User
	if err := pool.QueryRow(context.Background(), `SELECT id,org_id,org_role,status FROM actors WHERE org_id=$1 AND org_role='owner'`, member.OrgID).Scan(&owner.ActorID, &owner.OrgID, &owner.OrgRole, &owner.Status); err != nil {
		t.Fatal(err)
	}
	hub := NewHub(10)
	sender, err := hub.Register(member.OrgID, member.ActorID, "sender", 0)
	if err != nil {
		t.Fatal(err)
	}
	defer sender.Close()
	receiver, err := hub.Register(owner.OrgID, owner.ActorID, "receiver", 0)
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
	redisCfg := config.RedisConfig{Mode: "required", URL: redisURL, Namespace: fmt.Sprintf("coma:ephemeral:test:%d", time.Now().UnixNano()), ConnectTimeout: time.Second, OperationTimeout: time.Second}
	hub1, hub2 := NewHub(10), NewHub(10)
	sender, _ := hub1.Register(member.OrgID, member.ActorID, "sender", 0)
	defer sender.Close()
	receiver, _ := hub2.Register(owner.OrgID, owner.ActorID, "receiver", 0)
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
