package realtime

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"testing"
	"time"
)

func TestHubConnectionLimitAndWatermark(t *testing.T) {
	hub := NewHub(1)
	first, err := hub.Register("org", "actor", "connection-1", 4)
	if err != nil {
		t.Fatal(err)
	}
	defer first.Close()
	if _, err := hub.Register("org", "actor", "connection-2", 4); !errors.Is(err, ErrConnectionLimit) {
		t.Fatalf("Register() error = %v, want ErrConnectionLimit", err)
	}

	hub.Advance("org", 7)
	select {
	case <-first.Notifications():
	default:
		t.Fatal("subscription was not notified")
	}
	if got := first.Latest(); got != 7 {
		t.Fatalf("Latest() = %d, want 7", got)
	}
	if organizations := hub.Organizations(); len(organizations) != 1 || organizations[0].Watermark != 7 {
		t.Fatalf("Organizations() = %+v", organizations)
	}
}

func TestDispatcherCoalescesWakeupsAndTracksTheirSource(t *testing.T) {
	dispatcher := NewDispatcher(slog.New(slog.NewTextHandler(io.Discard, nil)), nil, nil, time.Second, 5*time.Millisecond)
	for range 10 {
		dispatcher.WakeRedis()
	}
	dispatcher.WakeLocal()

	stats := dispatcher.Stats()
	if stats.RedisWakeups != 10 || stats.LocalWakeups != 1 {
		t.Fatalf("Stats() = %+v", stats)
	}
	if stats.CoalescedWakeups != 10 {
		t.Fatalf("CoalescedWakeups = %d, want 10", stats.CoalescedWakeups)
	}
	if len(dispatcher.wake) != 1 {
		t.Fatalf("queued wake notifications = %d, want 1", len(dispatcher.wake))
	}
	if got := wakePath(wakeSource(dispatcher.pendingSources.Load())); got != "local_commit+redis" {
		t.Fatalf("wakePath() = %q", got)
	}
}

func TestHubShutdownCancelsSubscriptions(t *testing.T) {
	hub := NewHub(2)
	subscription, err := hub.Register("org", "actor", "connection-1", 0)
	if err != nil {
		t.Fatal(err)
	}
	hub.Shutdown(errServiceRestart)
	<-subscription.Context().Done()
	if !errors.Is(contextCause(subscription), errServiceRestart) {
		t.Fatalf("subscription cause = %v, want service restart", contextCause(subscription))
	}
}

func contextCause(subscription *Subscription) error {
	return context.Cause(subscription.Context())
}
