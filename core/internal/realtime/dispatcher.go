package realtime

import (
	"context"
	"encoding/json"
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
	RedisThrottled   uint64
	CoalescedWakeups uint64
	SignalPolls      uint64
	FallbackPolls    uint64
	LiveBatches      uint64
	LiveEvents       uint64
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
	redisThrottled atomic.Uint64
	lastRedisWake  atomic.Int64
	coalesced      atomic.Uint64
	signalPolls    atomic.Uint64
	fallbackPolls  atomic.Uint64
	liveBatches    atomic.Uint64
	liveEvents     atomic.Uint64
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
		now := time.Now().UnixNano()
		for {
			last := d.lastRedisWake.Load()
			if last != 0 && time.Duration(now-last) < 50*time.Millisecond {
				d.redisThrottled.Add(1)
				return
			}
			if d.lastRedisWake.CompareAndSwap(last, now) {
				break
			}
		}
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
		RedisThrottled:   d.redisThrottled.Load(),
		CoalescedWakeups: d.coalesced.Load(), SignalPolls: d.signalPolls.Load(),
		FallbackPolls: d.fallbackPolls.Load(), LiveBatches: d.liveBatches.Load(), LiveEvents: d.liveEvents.Load(),
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
		if current <= organization.Watermark {
			continue
		}
		from := organization.Watermark
		for from < current {
			items, err := d.store.Live(ctx, organization.OrgID, from, current, 256)
			if err != nil {
				d.logger.Error("read live event batch", "org_id", organization.OrgID, "from_seq", from, "to_seq", current, "dispatch_trigger", trigger, "error", err)
				break
			}
			if len(items) == 0 {
				d.hub.Advance(organization.OrgID, current)
				from = current
				break
			}
			prepared := make([]PreparedFrame, 0, len(items))
			for _, item := range items {
				payload, err := json.Marshal(item.Frame)
				if err != nil {
					d.logger.Error("serialize live event", "org_id", organization.OrgID, "seq", item.Frame.Seq, "error", err)
					continue
				}
				recipients := make(map[string]struct{}, len(item.RecipientActorIDs))
				for _, actorID := range item.RecipientActorIDs {
					recipients[actorID] = struct{}{}
				}
				excludeSessionID := ""
				if item.ExcludeSessionID != nil {
					excludeSessionID = *item.ExcludeSessionID
				}
				prepared = append(prepared, PreparedFrame{Seq: item.Frame.Seq, Payload: payload, Recipients: recipients, ExcludeSessionID: excludeSessionID})
			}
			through := items[len(items)-1].Frame.Seq
			d.hub.PublishLive(organization.OrgID, through, prepared)
			d.liveBatches.Add(1)
			d.liveEvents.Add(uint64(len(items)))
			from = through
		}
		d.logger.Debug("advanced durable event watermark",
			"org_id", organization.OrgID, "from_seq", organization.Watermark, "to_seq", from,
			"event_lag", current-from, "dispatch_latency", time.Since(startedAt),
			"dispatch_trigger", trigger,
		)
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
