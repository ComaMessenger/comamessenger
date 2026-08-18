package realtime

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"sync"
	"time"

	"github.com/comamessenger/comamessenger/core/internal/config"
	"github.com/comamessenger/comamessenger/core/internal/identity"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	redis "github.com/redis/go-redis/v9"
)

var (
	ErrEphemeralForbidden   = errors.New("ephemeral action forbidden")
	ErrEphemeralInvalid     = errors.New("invalid ephemeral action")
	ErrEphemeralRateLimited = errors.New("ephemeral rate limited")
	ErrEphemeralUnavailable = errors.New("ephemeral coordination unavailable")
)

type ephemeralEnvelope struct {
	OrgID               string          `json:"org_id"`
	ActorIDs            []string        `json:"actor_ids"`
	ExcludeConnectionID string          `json:"exclude_connection_id"`
	Data                json.RawMessage `json:"data"`
}

type localRate struct {
	count int
	reset time.Time
}
type localLease struct {
	value     string
	expiresAt time.Time
}

type Ephemeral struct {
	logger    *slog.Logger
	pool      *pgxpool.Pool
	hub       *Hub
	config    config.RealtimeConfig
	redis     *redis.Client
	channel   string
	namespace string
	opTimeout time.Duration

	mu          sync.Mutex
	localRate   map[string]localRate
	localLeases map[string]localLease
}

func NewEphemeral(logger *slog.Logger, pool *pgxpool.Pool, hub *Hub, realtimeConfig config.RealtimeConfig, redisConfig config.RedisConfig) (*Ephemeral, error) {
	result := &Ephemeral{logger: logger, pool: pool, hub: hub, config: realtimeConfig, namespace: redisConfig.Namespace, opTimeout: redisConfig.OperationTimeout, localRate: make(map[string]localRate), localLeases: make(map[string]localLease)}
	if redisConfig.Mode == "required" {
		options, err := redis.ParseURL(redisConfig.URL)
		if err != nil {
			return nil, fmt.Errorf("parse ephemeral REDIS_URL: %w", err)
		}
		options.DialTimeout, options.ReadTimeout, options.WriteTimeout = redisConfig.ConnectTimeout, redisConfig.OperationTimeout, redisConfig.OperationTimeout
		result.redis = redis.NewClient(options)
		result.channel = redisConfig.Namespace + ":ephemeral"
	}
	return result, nil
}

func (e *Ephemeral) Close() error {
	if e.redis != nil {
		return e.redis.Close()
	}
	return nil
}

func (e *Ephemeral) Run(ctx context.Context) {
	if e.redis == nil {
		return
	}
	backoff := 100 * time.Millisecond
	for ctx.Err() == nil {
		pubsub := e.redis.Subscribe(ctx, e.channel)
		if _, err := pubsub.Receive(ctx); err != nil {
			_ = pubsub.Close()
			if !waitContext(ctx, backoff) {
				return
			}
			backoff = min(backoff*2, 5*time.Second)
			continue
		}
		backoff = 100 * time.Millisecond
		for ctx.Err() == nil {
			message, err := pubsub.ReceiveMessage(ctx)
			if err != nil {
				break
			}
			var envelope ephemeralEnvelope
			if json.Unmarshal([]byte(message.Payload), &envelope) != nil || envelope.OrgID == "" || len(envelope.Data) == 0 {
				continue
			}
			e.hub.BroadcastEphemeral(envelope.OrgID, envelope.ActorIDs, envelope.ExcludeConnectionID, envelope.Data)
		}
		_ = pubsub.Close()
	}
}

func (e *Ephemeral) SubscribeActive(ctx context.Context, user identity.User, subscription *Subscription, chatID, threadRootID *string) error {
	if chatID == nil {
		if threadRootID != nil {
			return ErrEphemeralInvalid
		}
		e.hub.SetActive(subscription, nil, nil)
		return e.deleteLease(ctx, "active", user, subscription.ConnectionID)
	}
	if _, err := uuid.Parse(*chatID); err != nil {
		return ErrEphemeralInvalid
	}
	if err := e.authorizeScope(ctx, user, *chatID, threadRootID); err != nil {
		return err
	}
	e.hub.SetActive(subscription, chatID, threadRootID)
	value, _ := json.Marshal(map[string]any{"chat_id": chatID, "thread_root_id": threadRootID})
	return e.setLease(ctx, "active", user, subscription.ConnectionID, string(value), e.config.ActiveSubscriptionTTL)
}

func (e *Ephemeral) Typing(ctx context.Context, user identity.User, subscription *Subscription, chatID string, threadRootID *string, active bool) error {
	if !e.hub.IsActive(subscription, chatID, threadRootID) {
		return ErrEphemeralForbidden
	}
	if err := e.allow(ctx, user, "typing"); err != nil {
		return err
	}
	if err := e.authorizeScope(ctx, user, chatID, threadRootID); err != nil {
		return err
	}
	leaseScope := chatID
	if threadRootID != nil {
		leaseScope = *threadRootID
	}
	expiresAt := time.Now().UTC()
	if active {
		expiresAt = expiresAt.Add(e.config.TypingTTL)
		if err := e.setLease(ctx, "typing:"+leaseScope, user, subscription.ConnectionID, "1", e.config.TypingTTL); err != nil {
			return err
		}
	} else if err := e.deleteLease(ctx, "typing:"+leaseScope, user, subscription.ConnectionID); err != nil {
		return err
	}
	frame := typingEventFrame{Op: "typing", ActorID: user.ActorID, ChatID: chatID, ThreadRootID: threadRootID, Active: active, ExpiresAt: expiresAt}
	return e.broadcast(ctx, user, subscription.ConnectionID, chatID, frame)
}

func (e *Ephemeral) Presence(ctx context.Context, user identity.User, subscription *Subscription, state string) error {
	if state != "active" && state != "away" {
		return ErrEphemeralInvalid
	}
	if err := e.allow(ctx, user, "presence"); err != nil {
		return err
	}
	expiresAt := time.Now().UTC().Add(e.config.PresenceTTL)
	if err := e.setLease(ctx, "presence", user, subscription.ConnectionID, state, e.config.PresenceTTL); err != nil {
		return err
	}
	frame := presenceEventFrame{Op: "presence", ActorID: user.ActorID, State: map[string]string{"active": "online", "away": "away"}[state], ExpiresAt: expiresAt}
	return e.broadcast(ctx, user, subscription.ConnectionID, "", frame)
}

func (e *Ephemeral) authorizeScope(ctx context.Context, user identity.User, chatID string, threadRootID *string) error {
	if _, err := uuid.Parse(chatID); err != nil {
		return ErrEphemeralInvalid
	}
	var allowed bool
	err := e.pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM chats c JOIN chat_members cm ON cm.org_id=c.org_id AND cm.chat_id=c.id AND cm.actor_id=$3 JOIN actors a ON a.org_id=cm.org_id AND a.id=cm.actor_id WHERE c.org_id=$1 AND c.id=$2 AND c.archived_at IS NULL AND a.status='active' AND a.deleted_at IS NULL)`, user.OrgID, chatID, user.ActorID).Scan(&allowed)
	if err != nil {
		return fmt.Errorf("authorize ephemeral chat: %w", err)
	}
	if !allowed {
		return ErrEphemeralForbidden
	}
	if threadRootID != nil {
		if _, err := uuid.Parse(*threadRootID); err != nil {
			return ErrEphemeralInvalid
		}
		err = e.pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM messages WHERE org_id=$1 AND chat_id=$2 AND id=$3 AND thread_root_id IS NULL AND deleted_at IS NULL)`, user.OrgID, chatID, *threadRootID).Scan(&allowed)
		if err != nil {
			return fmt.Errorf("authorize ephemeral thread: %w", err)
		}
		if !allowed {
			return ErrEphemeralForbidden
		}
	}
	return nil
}

func (e *Ephemeral) recipients(ctx context.Context, user identity.User, chatID string) ([]string, error) {
	query := `SELECT id FROM actors WHERE org_id=$1 AND status='active' AND deleted_at IS NULL`
	args := []any{user.OrgID}
	if chatID != "" {
		query = `SELECT a.id FROM chat_members cm JOIN actors a ON a.org_id=cm.org_id AND a.id=cm.actor_id WHERE cm.org_id=$1 AND cm.chat_id=$2 AND a.status='active' AND a.deleted_at IS NULL`
		args = append(args, chatID)
	}
	rows, err := e.pool.Query(ctx, query, args...)
	if err != nil {
		return nil, fmt.Errorf("list ephemeral recipients: %w", err)
	}
	defer rows.Close()
	result := make([]string, 0)
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		result = append(result, id)
	}
	return result, rows.Err()
}

func (e *Ephemeral) broadcast(ctx context.Context, user identity.User, excludeConnectionID, chatID string, frame any) error {
	data, err := json.Marshal(frame)
	if err != nil {
		return err
	}
	actorIDs, err := e.recipients(ctx, user, chatID)
	if err != nil {
		return err
	}
	envelope := ephemeralEnvelope{OrgID: user.OrgID, ActorIDs: actorIDs, ExcludeConnectionID: excludeConnectionID, Data: data}
	if e.redis == nil {
		e.hub.BroadcastEphemeral(envelope.OrgID, envelope.ActorIDs, envelope.ExcludeConnectionID, envelope.Data)
		return nil
	}
	payload, err := json.Marshal(envelope)
	if err != nil {
		return err
	}
	opCtx, cancel := context.WithTimeout(ctx, e.opTimeout)
	defer cancel()
	if err := e.redis.Publish(opCtx, e.channel, payload).Err(); err != nil {
		return ErrEphemeralUnavailable
	}
	return nil
}

func (e *Ephemeral) allow(ctx context.Context, user identity.User, operation string) error {
	key := e.namespace + ":rate:" + user.OrgID + ":" + user.ActorID + ":" + operation
	if e.redis == nil {
		now := time.Now()
		e.mu.Lock()
		defer e.mu.Unlock()
		entry := e.localRate[key]
		if now.After(entry.reset) {
			entry = localRate{reset: now.Add(e.config.EphemeralRateWindow)}
		}
		entry.count++
		e.localRate[key] = entry
		if uint64(entry.count) > e.config.EphemeralRateLimit {
			return ErrEphemeralRateLimited
		}
		return nil
	}
	script := redis.NewScript(`local n=redis.call('INCR',KEYS[1]);if n==1 then redis.call('PEXPIRE',KEYS[1],ARGV[1]) end;return n`)
	opCtx, cancel := context.WithTimeout(ctx, e.opTimeout)
	defer cancel()
	value, err := script.Run(opCtx, e.redis, []string{key}, e.config.EphemeralRateWindow.Milliseconds()).Int64()
	if err != nil {
		return ErrEphemeralUnavailable
	}
	if uint64(value) > e.config.EphemeralRateLimit {
		return ErrEphemeralRateLimited
	}
	return nil
}
func (e *Ephemeral) setLease(ctx context.Context, kind string, user identity.User, connectionID, value string, ttl time.Duration) error {
	key := strings.Join([]string{e.namespace, "lease", kind, user.OrgID, user.ActorID, connectionID}, ":")
	if e.redis == nil {
		now := time.Now()
		e.mu.Lock()
		for leaseKey, lease := range e.localLeases {
			if now.After(lease.expiresAt) {
				delete(e.localLeases, leaseKey)
			}
		}
		e.localLeases[key] = localLease{value: value, expiresAt: now.Add(ttl)}
		e.mu.Unlock()
		return nil
	}
	opCtx, cancel := context.WithTimeout(ctx, e.opTimeout)
	defer cancel()
	if err := e.redis.Set(opCtx, key, value, ttl).Err(); err != nil {
		return ErrEphemeralUnavailable
	}
	return nil
}
func (e *Ephemeral) deleteLease(ctx context.Context, kind string, user identity.User, connectionID string) error {
	key := strings.Join([]string{e.namespace, "lease", kind, user.OrgID, user.ActorID, connectionID}, ":")
	if e.redis == nil {
		e.mu.Lock()
		delete(e.localLeases, key)
		e.mu.Unlock()
		return nil
	}
	opCtx, cancel := context.WithTimeout(ctx, e.opTimeout)
	defer cancel()
	if err := e.redis.Del(opCtx, key).Err(); err != nil {
		return ErrEphemeralUnavailable
	}
	return nil
}
func waitContext(ctx context.Context, d time.Duration) bool {
	timer := time.NewTimer(d)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-timer.C:
		return true
	}
}
