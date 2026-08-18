package realtime

import (
	"context"
	"log/slog"
	"time"

	"github.com/comamessenger/comamessenger/core/internal/eventlog"
)

type Dispatcher struct {
	logger       *slog.Logger
	store        *eventlog.Store
	hub          *Hub
	pollInterval time.Duration
	wake         chan struct{}
}

func NewDispatcher(logger *slog.Logger, store *eventlog.Store, hub *Hub, pollInterval time.Duration) *Dispatcher {
	return &Dispatcher{logger: logger, store: store, hub: hub, pollInterval: pollInterval, wake: make(chan struct{}, 1)}
}

func (d *Dispatcher) Wake() {
	select {
	case d.wake <- struct{}{}:
	default:
	}
}

func (d *Dispatcher) Run(ctx context.Context) {
	ticker := time.NewTicker(d.pollInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		case <-d.wake:
		}
		d.poll(ctx)
	}
}

func (d *Dispatcher) poll(ctx context.Context) {
	for _, organization := range d.hub.Organizations() {
		startedAt := time.Now()
		current, err := d.store.Current(ctx, organization.OrgID)
		if err != nil {
			d.logger.Error("poll durable event watermark", "org_id", organization.OrgID, "error", err)
			continue
		}
		if current > organization.Watermark {
			d.hub.Advance(organization.OrgID, current)
			d.logger.Debug("advanced durable event watermark",
				"org_id", organization.OrgID, "from_seq", organization.Watermark, "to_seq", current,
				"event_lag", current-organization.Watermark, "dispatch_latency", time.Since(startedAt),
			)
		}
	}
}
