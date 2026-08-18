package coordination

import (
	"context"
	"fmt"
	"io"
	"log/slog"
	"os"
	"testing"
	"time"

	"github.com/comamessenger/comamessenger/core/internal/config"
	redis "github.com/redis/go-redis/v9"
)

func TestRedisPubSubDuplicateAndReconnect(t *testing.T) {
	redisURL := os.Getenv("TEST_REDIS_URL")
	if redisURL == "" {
		t.Skip("TEST_REDIS_URL is not set")
	}
	cfg := redisTestConfig(redisURL, fmt.Sprintf("coma:test:%d", time.Now().UnixNano()))
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	receiver, err := NewRedis(logger, cfg)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	received := make(chan Wakeup, 8)
	go func() {
		receiver.Run(ctx, func(wakeup Wakeup) { received <- wakeup })
		close(done)
	}()
	t.Cleanup(func() {
		cancel()
		select {
		case <-done:
		case <-time.After(2 * time.Second):
			t.Error("Redis coordinator did not stop")
		}
		_ = receiver.Close()
	})
	waitFor(t, 3*time.Second, receiver.Available, "initial Redis subscription")

	wakeup := Wakeup{OrgID: "019c1234-5678-7000-8000-000000000001", HighWatermark: 42}
	receiver.Notify(wakeup.OrgID, wakeup.HighWatermark)
	receiver.Notify(wakeup.OrgID, wakeup.HighWatermark)
	for range 2 {
		select {
		case got := <-received:
			if got != wakeup {
				t.Fatalf("received wakeup = %+v, want %+v", got, wakeup)
			}
		case <-time.After(3 * time.Second):
			t.Fatal("timed out waiting for duplicate Redis wake-up")
		}
	}

	adminOptions, err := redis.ParseURL(redisURL)
	if err != nil {
		t.Fatal(err)
	}
	admin := redis.NewClient(adminOptions)
	defer admin.Close()
	if err := admin.Do(context.Background(), "CLIENT", "KILL", "TYPE", "pubsub").Err(); err != nil {
		t.Fatalf("kill Pub/Sub connection: %v", err)
	}
	waitFor(t, 3*time.Second, func() bool { return receiver.Stats().Reconnects > 0 }, "Redis subscription disconnect")
	waitFor(t, 5*time.Second, receiver.Available, "Redis subscription reconnect")

	receiver.Notify(wakeup.OrgID, wakeup.HighWatermark+1)
	select {
	case got := <-received:
		if got.HighWatermark != wakeup.HighWatermark+1 {
			t.Fatalf("post-reconnect wakeup = %+v", got)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("timed out waiting for Redis wake-up after reconnect")
	}
}

func TestRedisNotifyIsBoundedWhenRedisIsUnavailable(t *testing.T) {
	cfg := redisTestConfig("redis://127.0.0.1:1/0", "coma:test:unavailable")
	coordinator, err := NewRedis(slog.New(slog.NewTextHandler(io.Discard, nil)), cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer coordinator.Close()

	startedAt := time.Now()
	for seq := int64(1); seq <= publishQueueSize*4; seq++ {
		coordinator.Notify("019c1234-5678-7000-8000-000000000001", seq)
	}
	if elapsed := time.Since(startedAt); elapsed > 100*time.Millisecond {
		t.Fatalf("Notify blocked for %s while Redis was unavailable", elapsed)
	}
	if got := coordinator.Stats().Dropped; got == 0 {
		t.Fatal("bounded publish queue did not drop excess wake-up hints")
	}
}

func redisTestConfig(redisURL, namespace string) config.RedisConfig {
	return config.RedisConfig{
		Mode: "required", URL: redisURL, Namespace: namespace,
		ConnectTimeout: 200 * time.Millisecond, OperationTimeout: 100 * time.Millisecond,
	}
}

func waitFor(t *testing.T, timeout time.Duration, condition func() bool, description string) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if condition() {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for %s", description)
}
