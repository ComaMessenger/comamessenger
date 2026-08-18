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
	first, err := hub.Register("org", "actor", "session-1", "connection-1", 4)
	if err != nil {
		t.Fatal(err)
	}
	defer first.Close()
	if _, err := hub.Register("org", "actor", "session-2", "connection-2", 4); !errors.Is(err, ErrConnectionLimit) {
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
	if stats.RedisThrottled != 9 || stats.CoalescedWakeups != 1 {
		t.Fatalf("unexpected Redis throttling/coalescing stats: %+v", stats)
	}
	if len(dispatcher.wake) != 1 {
		t.Fatalf("queued wake notifications = %d, want 1", len(dispatcher.wake))
	}
	if got := wakePath(wakeSource(dispatcher.pendingSources.Load())); got != "local_commit+redis" {
		t.Fatalf("wakePath() = %q", got)
	}
}

func TestHubRevokesAllConnectionsForSession(t *testing.T) {
	hub := NewHub(3)
	first, _ := hub.Register("org", "actor", "session", "connection-1", 0)
	second, _ := hub.Register("org", "actor", "session", "connection-2", 0)
	other, _ := hub.Register("org", "actor", "other", "connection-3", 0)
	defer first.Close()
	defer second.Close()
	defer other.Close()

	hub.RevokeSession("session")
	<-first.Context().Done()
	<-second.Context().Done()
	if !errors.Is(context.Cause(first.Context()), errSessionRevoked) || !errors.Is(context.Cause(second.Context()), errSessionRevoked) {
		t.Fatal("revoked session connections did not receive errSessionRevoked")
	}
	select {
	case <-other.Context().Done():
		t.Fatal("another session was revoked")
	default:
	}
}

func TestHubShutdownCancelsSubscriptions(t *testing.T) {
	hub := NewHub(2)
	subscription, err := hub.Register("org", "actor", "session-1", "connection-1", 0)
	if err != nil {
		t.Fatal(err)
	}
	hub.Shutdown(errServiceRestart)
	<-subscription.Context().Done()
	if !errors.Is(contextCause(subscription), errServiceRestart) {
		t.Fatalf("subscription cause = %v, want service restart", contextCause(subscription))
	}
}

func TestHubPublishesPreparedFrameOnlyToAuthorizedSessions(t *testing.T) {
	hub := NewHub(3)
	first, _ := hub.Register("org", "actor-1", "session-1", "connection-1", 4)
	second, _ := hub.Register("org", "actor-2", "session-2", "connection-2", 4)
	excluded, _ := hub.Register("org", "actor-1", "session-excluded", "connection-3", 4)
	defer first.Close()
	defer second.Close()
	defer excluded.Close()

	payload := []byte(`{"op":"event","seq":5}`)
	hub.PublishLive("org", 5, []PreparedFrame{{
		Seq: 5, Payload: payload,
		Recipients:       map[string]struct{}{"actor-1": {}},
		ExcludeSessionID: "session-excluded",
	}})

	select {
	case delivery := <-first.Live():
		if delivery.seq != 5 || string(delivery.payload) != string(payload) {
			t.Fatalf("delivery = %+v", delivery)
		}
		first.releaseLive(len(delivery.payload))
	case <-time.After(time.Second):
		t.Fatal("authorized session did not receive prepared frame")
	}
	for name, subscription := range map[string]*Subscription{"unauthorized": second, "excluded": excluded} {
		select {
		case delivery := <-subscription.Live():
			t.Fatalf("%s session received delivery %+v", name, delivery)
		default:
		}
	}
}

func TestHubDisconnectsSlowLiveConsumerAtQueueLimit(t *testing.T) {
	hub := NewHub(1, 1, 64)
	subscription, err := hub.Register("org", "actor", "session", "connection", 0)
	if err != nil {
		t.Fatal(err)
	}
	defer subscription.Close()

	hub.PublishLive("org", 2, []PreparedFrame{
		{Seq: 1, Payload: []byte(`{"seq":1}`), Recipients: map[string]struct{}{"actor": {}}},
		{Seq: 2, Payload: []byte(`{"seq":2}`), Recipients: map[string]struct{}{"actor": {}}},
	})
	<-subscription.Context().Done()
	if !errors.Is(context.Cause(subscription.Context()), errLiveQueueExceeded) {
		t.Fatalf("subscription cause = %v, want errLiveQueueExceeded", context.Cause(subscription.Context()))
	}
}

func contextCause(subscription *Subscription) error {
	return context.Cause(subscription.Context())
}
