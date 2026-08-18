package realtime

import (
	"context"
	"errors"
	"testing"
)

func TestHubConnectionLimitAndWatermark(t *testing.T) {
	hub := NewHub(1)
	first, err := hub.Register("org", "actor", 4)
	if err != nil {
		t.Fatal(err)
	}
	defer first.Close()
	if _, err := hub.Register("org", "actor", 4); !errors.Is(err, ErrConnectionLimit) {
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

func TestHubShutdownCancelsSubscriptions(t *testing.T) {
	hub := NewHub(2)
	subscription, err := hub.Register("org", "actor", 0)
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
