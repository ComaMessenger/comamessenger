package realtime

import (
	"context"
	"log/slog"
	"sync/atomic"
	"time"

	"github.com/comamessenger/comamessenger/core/internal/eventlog"
)

type wakeSource uint32

const (
	wakeLocalCommit wakeSource = 1 << iota
	wakeRedis
)

type DispatcherStats struct {
	LocalWakeups     uint64
	RedisWakeups     uint64
	CoalescedWakeups uint64
	SignalPolls      uint64
	FallbackPolls    uint64
}

type Dispatcher struct {
	logger         *slog.Logger
	store          *eventlog.Store
	hub            *Hub
	pollInterval   time.Duration
	wakeCoalesce   time.Duration
	wake           chan struct{}
	pendingSources atomic.Uint32
	localWakeups   atomic.Uint64
	redisWakeups   atomic.Uint64
	coalesced      atomic.Uint64
	signalPolls    atomic.Uint64
	fallbackPolls  atomic.Uint64
}

func NewDispatcher(logger *slog.Logger, store *eventlog.Store, hub *Hub, pollInterval, wakeCoalesce time.Duration) *Dispatcher {
	return &Dispatcher{
		logger: logger, store: store, hub: hub, pollInterval: pollInterval, wakeCoalesce: wakeCoalesce,
		wake: make(chan struct{}, 1),
	}
}

func (d *Dispatcher) WakeLocal() { d.queueWake(wakeLocalCommit) }
func (d *Dispatcher) WakeRedis() { d.queueWake(wakeRedis) }

func (d *Dispatcher) queueWake(source wakeSource) {
	switch source {
	case wakeLocalCommit:
		d.localWakeups.Add(1)
	case wakeRedis:
		d.redisWakeups.Add(1)
	default:
		return
	}
	countedAsCoalesced := false
	for {
		current := d.pendingSources.Load()
		if current != 0 && !countedAsCoalesced {
			d.coalesced.Add(1)
			countedAsCoalesced = true
		}
		if d.pendingSources.CompareAndSwap(current, current|uint32(source)) {
			break
		}
	}
	select {
	case d.wake <- struct{}{}:
	default:
	}
}

func (d *Dispatcher) Stats() DispatcherStats {
	return DispatcherStats{
		LocalWakeups: d.localWakeups.Load(), RedisWakeups: d.redisWakeups.Load(),
		CoalescedWakeups: d.coalesced.Load(), SignalPolls: d.signalPolls.Load(),
		FallbackPolls: d.fallbackPolls.Load(),
	}
}

func (d *Dispatcher) Run(ctx context.Context) {
	fallback := time.NewTimer(d.pollInterval)
	defer fallback.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-fallback.C:
			d.fallbackPolls.Add(1)
			d.poll(ctx, "polling_fallback")
			fallback.Reset(d.pollInterval)
		case <-d.wake:
			if !d.waitForCoalescing(ctx) {
				return
			}
			sources := wakeSource(d.pendingSources.Swap(0))
			d.signalPolls.Add(1)
			d.poll(ctx, wakePath(sources))
			resetTimer(fallback, d.pollInterval)
		}
	}
}

func (d *Dispatcher) waitForCoalescing(ctx context.Context) bool {
	timer := time.NewTimer(d.wakeCoalesce)
	defer timer.Stop()
	for {
		select {
		case <-ctx.Done():
			return false
		case <-d.wake:
			// pendingSources already contains this wake-up. Keep collecting until
			// the fixed coalescing window ends instead of extending it forever.
		case <-timer.C:
			return true
		}
	}
}

func (d *Dispatcher) poll(ctx context.Context, trigger string) {
	for _, organization := range d.hub.Organizations() {
		startedAt := time.Now()
		current, err := d.store.Current(ctx, organization.OrgID)
		if err != nil {
			d.logger.Error("poll durable event watermark", "org_id", organization.OrgID, "dispatch_trigger", trigger, "error", err)
			continue
		}
		if current > organization.Watermark {
			d.hub.Advance(organization.OrgID, current)
			d.logger.Debug("advanced durable event watermark",
				"org_id", organization.OrgID, "from_seq", organization.Watermark, "to_seq", current,
				"event_lag", current-organization.Watermark, "dispatch_latency", time.Since(startedAt),
				"dispatch_trigger", trigger,
			)
		}
	}
}

func wakePath(source wakeSource) string {
	switch source {
	case wakeLocalCommit:
		return "local_commit"
	case wakeRedis:
		return "redis"
	case wakeLocalCommit | wakeRedis:
		return "local_commit+redis"
	default:
		return "signal"
	}
}

func resetTimer(timer *time.Timer, duration time.Duration) {
	if !timer.Stop() {
		select {
		case <-timer.C:
		default:
		}
	}
	timer.Reset(duration)
}
