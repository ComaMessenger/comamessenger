package coordination

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"sync"
	"sync/atomic"
	"time"

	"github.com/comamessenger/comamessenger/core/internal/config"
	redis "github.com/redis/go-redis/v9"
)

const publishQueueSize = 256

type Wakeup struct {
	OrgID         string `json:"org_id"`
	HighWatermark int64  `json:"high_watermark"`
}

type RedisStats struct {
	Published       uint64
	PublishErrors   uint64
	Received        uint64
	InvalidMessages uint64
	Dropped         uint64
	Reconnects      uint64
}

type Redis struct {
	logger           *slog.Logger
	client           *redis.Client
	channel          string
	connectTimeout   time.Duration
	operationTimeout time.Duration
	outgoing         chan Wakeup
	available        atomic.Bool
	published        atomic.Uint64
	publishErrors    atomic.Uint64
	received         atomic.Uint64
	invalidMessages  atomic.Uint64
	dropped          atomic.Uint64
	reconnects       atomic.Uint64
}

func NewRedis(logger *slog.Logger, cfg config.RedisConfig) (*Redis, error) {
	if cfg.Mode != "required" {
		return nil, fmt.Errorf("Redis coordinator requires REDIS_MODE=required")
	}
	options, err := redis.ParseURL(cfg.URL)
	if err != nil {
		return nil, fmt.Errorf("parse REDIS_URL: %w", err)
	}
	options.DialTimeout = cfg.ConnectTimeout
	options.ReadTimeout = cfg.OperationTimeout
	options.WriteTimeout = cfg.OperationTimeout
	return &Redis{
		logger: logger, client: redis.NewClient(options), channel: cfg.Namespace + ":events:wakeup",
		connectTimeout: cfg.ConnectTimeout, operationTimeout: cfg.OperationTimeout,
		outgoing: make(chan Wakeup, publishQueueSize),
	}, nil
}

// Notify is deliberately non-blocking. PostgreSQL already contains the event,
// so a full queue may drop this hint and let periodic polling recover it.
func (r *Redis) Notify(orgID string, highWatermark int64) {
	if orgID == "" || highWatermark < 1 {
		return
	}
	select {
	case r.outgoing <- Wakeup{OrgID: orgID, HighWatermark: highWatermark}:
	default:
		r.dropped.Add(1)
	}
}

func (r *Redis) Ping(ctx context.Context) error {
	pingCtx, cancel := context.WithTimeout(ctx, r.connectTimeout+r.operationTimeout)
	defer cancel()
	if err := r.client.Ping(pingCtx).Err(); err != nil {
		r.available.Store(false)
		return err
	}
	r.available.Store(true)
	return nil
}

func (r *Redis) Run(ctx context.Context, onWakeup func(Wakeup)) {
	var workers sync.WaitGroup
	workers.Add(2)
	go func() {
		defer workers.Done()
		r.publishLoop(ctx)
	}()
	go func() {
		defer workers.Done()
		r.subscribeLoop(ctx, onWakeup)
	}()
	workers.Wait()
}

func (r *Redis) Available() bool { return r.available.Load() }

func (r *Redis) Stats() RedisStats {
	return RedisStats{
		Published: r.published.Load(), PublishErrors: r.publishErrors.Load(), Received: r.received.Load(),
		InvalidMessages: r.invalidMessages.Load(), Dropped: r.dropped.Load(), Reconnects: r.reconnects.Load(),
	}
}

func (r *Redis) Close() error { return r.client.Close() }

func (r *Redis) publishLoop(ctx context.Context) {
	for {
		select {
		case <-ctx.Done():
			return
		case wakeup := <-r.outgoing:
			payload, err := json.Marshal(wakeup)
			if err != nil {
				r.publishErrors.Add(1)
				continue
			}
			operationCtx, cancel := context.WithTimeout(ctx, r.operationTimeout)
			err = r.client.Publish(operationCtx, r.channel, payload).Err()
			cancel()
			if err != nil {
				r.available.Store(false)
				r.publishErrors.Add(1)
				r.logger.Warn("publish Redis event wake-up failed",
					"org_id", wakeup.OrgID, "high_watermark", wakeup.HighWatermark, "error", err,
				)
				continue
			}
			r.available.Store(true)
			r.published.Add(1)
		}
	}
}

func (r *Redis) subscribeLoop(ctx context.Context, onWakeup func(Wakeup)) {
	backoff := 100 * time.Millisecond
	for ctx.Err() == nil {
		pubsub := r.client.Subscribe(ctx, r.channel)
		stopOnCancel := context.AfterFunc(ctx, func() { _ = pubsub.Close() })
		receiveCtx, cancel := context.WithTimeout(ctx, r.connectTimeout+r.operationTimeout)
		_, err := pubsub.Receive(receiveCtx)
		cancel()
		if err != nil {
			stopOnCancel()
			_ = pubsub.Close()
			r.available.Store(false)
			if ctx.Err() != nil {
				return
			}
			r.reconnects.Add(1)
			if !waitForRetry(ctx, backoff) {
				return
			}
			backoff = min(backoff*2, 5*time.Second)
			continue
		}
		r.available.Store(true)
		backoff = 100 * time.Millisecond
		r.logger.Info("subscribed to Redis event wake-ups", "channel", r.channel)

		for ctx.Err() == nil {
			message, err := pubsub.ReceiveMessage(ctx)
			if err != nil {
				stopOnCancel()
				_ = pubsub.Close()
				r.available.Store(false)
				if ctx.Err() != nil {
					return
				}
				r.reconnects.Add(1)
				r.logger.Warn("Redis event wake-up subscription interrupted", "error", err)
				break
			}
			var wakeup Wakeup
			if err := json.Unmarshal([]byte(message.Payload), &wakeup); err != nil || wakeup.OrgID == "" || wakeup.HighWatermark < 1 {
				r.invalidMessages.Add(1)
				r.logger.Warn("ignored invalid Redis event wake-up")
				continue
			}
			r.received.Add(1)
			onWakeup(wakeup)
		}
		stopOnCancel()
		_ = pubsub.Close()
	}
}

func waitForRetry(ctx context.Context, delay time.Duration) bool {
	timer := time.NewTimer(delay)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-timer.C:
		return true
	}
}
