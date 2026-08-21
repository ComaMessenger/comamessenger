package realtime

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/comamessenger/comamessenger/core/internal/access"
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
	Signature           string          `json:"signature"`
}

const (
	maxEphemeralEnvelopeBytes = 64 * 1024
	maxEphemeralDataBytes     = 16 * 1024
)

type localRate struct {
	count int
	reset time.Time
}
type localLease struct {
	value     string
	expiresAt time.Time
}

type Ephemeral struct {
	logger     *slog.Logger
	pool       *pgxpool.Pool
	hub        *Hub
	config     config.RealtimeConfig
	redis      *redis.Client
	channel    string
	namespace  string
	opTimeout  time.Duration
	signingKey []byte

	mu          sync.Mutex
	localRate   map[string]localRate
	localLeases map[string]localLease
}

func NewEphemeral(logger *slog.Logger, pool *pgxpool.Pool, hub *Hub, realtimeConfig config.RealtimeConfig, redisConfig config.RedisConfig) (*Ephemeral, error) {
	result := &Ephemeral{logger: logger, pool: pool, hub: hub, config: realtimeConfig, namespace: redisConfig.Namespace, opTimeout: redisConfig.OperationTimeout, localRate: make(map[string]localRate), localLeases: make(map[string]localLease)}
	if redisConfig.Mode == "required" {
		if len(redisConfig.EphemeralSigningKey) < 32 {
			return nil, fmt.Errorf("REDIS_EPHEMERAL_SIGNING_KEY must be at least 32 bytes")
		}
		result.signingKey = []byte(redisConfig.EphemeralSigningKey)
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
			envelope, err := e.decodeEphemeralEnvelope([]byte(message.Payload))
			if err != nil {
				e.logger.Warn("discard invalid Redis ephemeral envelope", "error", err)
				continue
			}
			e.hub.BroadcastEphemeral(envelope.OrgID, envelope.ActorIDs, envelope.ExcludeConnectionID, envelope.Data)
		}
		_ = pubsub.Close()
	}
}

func (e *Ephemeral) SubscribeActive(ctx context.Context, user identity.User, subscription *Subscription, chatID, threadRootID *string) error {
	if err := e.allow(ctx, user, "subscribe_active"); err != nil {
		return err
	}
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

func (e *Ephemeral) decodeEphemeralEnvelope(payload []byte) (ephemeralEnvelope, error) {
	if len(payload) == 0 || len(payload) > maxEphemeralEnvelopeBytes {
		return ephemeralEnvelope{}, ErrEphemeralInvalid
	}
	var envelope ephemeralEnvelope
	if err := decodeStrict(payload, &envelope); err != nil {
		return ephemeralEnvelope{}, ErrEphemeralInvalid
	}
	if len(e.signingKey) == 0 || !hmac.Equal([]byte(envelope.Signature), []byte(e.signEnvelope(envelope))) {
		return ephemeralEnvelope{}, ErrEphemeralInvalid
	}
	if _, err := uuid.Parse(envelope.OrgID); err != nil || len(envelope.ActorIDs) == 0 || len(envelope.ActorIDs) > 1000 || len(envelope.Data) == 0 || len(envelope.Data) > maxEphemeralDataBytes {
		return ephemeralEnvelope{}, ErrEphemeralInvalid
	}
	seen := make(map[string]struct{}, len(envelope.ActorIDs))
	for _, actorID := range envelope.ActorIDs {
		if _, err := uuid.Parse(actorID); err != nil {
			return ephemeralEnvelope{}, ErrEphemeralInvalid
		}
		if _, duplicate := seen[actorID]; duplicate {
			return ephemeralEnvelope{}, ErrEphemeralInvalid
		}
		seen[actorID] = struct{}{}
	}
	if envelope.ExcludeConnectionID != "" {
		if _, err := uuid.Parse(envelope.ExcludeConnectionID); err != nil {
			return ephemeralEnvelope{}, ErrEphemeralInvalid
		}
	}
	var operation struct {
		Op string `json:"op"`
	}
	if err := json.Unmarshal(envelope.Data, &operation); err != nil {
		return ephemeralEnvelope{}, ErrEphemeralInvalid
	}
	switch operation.Op {
	case "typing":
		var frame typingEventFrame
		if decodeStrict(envelope.Data, &frame) != nil || frame.Op != "typing" || frame.ExpiresAt.IsZero() {
			return ephemeralEnvelope{}, ErrEphemeralInvalid
		}
		if _, err := uuid.Parse(frame.ActorID); err != nil {
			return ephemeralEnvelope{}, ErrEphemeralInvalid
		}
		if _, err := uuid.Parse(frame.ChatID); err != nil {
			return ephemeralEnvelope{}, ErrEphemeralInvalid
		}
		if frame.ThreadRootID != nil {
			if _, err := uuid.Parse(*frame.ThreadRootID); err != nil {
				return ephemeralEnvelope{}, ErrEphemeralInvalid
			}
		}
	case "presence":
		var frame presenceEventFrame
		if decodeStrict(envelope.Data, &frame) != nil || frame.Op != "presence" || frame.ExpiresAt.IsZero() || (frame.State != "online" && frame.State != "away") {
			return ephemeralEnvelope{}, ErrEphemeralInvalid
		}
		if _, err := uuid.Parse(frame.ActorID); err != nil {
			return ephemeralEnvelope{}, ErrEphemeralInvalid
		}
	case "agent.status":
		var frame agentStatusEventFrame
		if decodeStrict(envelope.Data, &frame) != nil || frame.Op != "agent.status" || frame.ExpiresAt.IsZero() || !validAgentState(frame.State) {
			return ephemeralEnvelope{}, ErrEphemeralInvalid
		}
		if uuid.Validate(frame.ActorID) != nil || uuid.Validate(frame.RunID) != nil || uuid.Validate(frame.ChatID) != nil || (frame.ThreadRootID != nil && uuid.Validate(*frame.ThreadRootID) != nil) {
			return ephemeralEnvelope{}, ErrEphemeralInvalid
		}
	case "message.streaming":
		var frame messageStreamingEventFrame
		if decodeStrict(envelope.Data, &frame) != nil || frame.Op != "message.streaming" || frame.ExpiresAt.IsZero() || frame.Index < 0 || len(frame.Delta) > 8192 {
			return ephemeralEnvelope{}, ErrEphemeralInvalid
		}
		if uuid.Validate(frame.ActorID) != nil || uuid.Validate(frame.RunID) != nil || uuid.Validate(frame.ChatID) != nil || uuid.Validate(frame.StreamID) != nil || (frame.ThreadRootID != nil && uuid.Validate(*frame.ThreadRootID) != nil) {
			return ephemeralEnvelope{}, ErrEphemeralInvalid
		}
	default:
		return ephemeralEnvelope{}, ErrEphemeralInvalid
	}
	return envelope, nil
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

func (e *Ephemeral) AgentStatus(ctx context.Context, user identity.User, authentication access.Identity, subscription *Subscription, input agentStatusFrame) error {
	if input.Op != "agent.status" || !validAgentState(input.State) || uuid.Validate(input.RunID) != nil || uuid.Validate(input.ChatID) != nil || (input.ThreadRootID != nil && uuid.Validate(*input.ThreadRootID) != nil) {
		return ErrEphemeralInvalid
	}
	if err := e.authorizeAgentRun(ctx, user, authentication, input.RunID, input.ChatID, input.ThreadRootID); err != nil {
		return err
	}
	if err := e.allow(ctx, user, "agent.status"); err != nil {
		return err
	}
	expiresAt := time.Now().UTC().Add(15 * time.Second)
	if input.State == "completed" {
		expiresAt = time.Now().UTC()
	} else if input.State == "failed" || input.State == "canceled" {
		expiresAt = time.Now().UTC().Add(8 * time.Second)
	}
	frame := agentStatusEventFrame{Op: input.Op, ActorID: user.ActorID, RunID: input.RunID, ChatID: input.ChatID, ThreadRootID: input.ThreadRootID, State: input.State, ExpiresAt: expiresAt}
	return e.broadcast(ctx, user, subscription.ConnectionID, input.ChatID, frame)
}

func (e *Ephemeral) MessageStreaming(ctx context.Context, user identity.User, authentication access.Identity, subscription *Subscription, input messageStreamingFrame) error {
	if input.Op != "message.streaming" || uuid.Validate(input.RunID) != nil || uuid.Validate(input.ChatID) != nil || uuid.Validate(input.StreamID) != nil || input.Index < 0 || len(input.Delta) > 8192 || (input.ThreadRootID != nil && uuid.Validate(*input.ThreadRootID) != nil) {
		return ErrEphemeralInvalid
	}
	if err := e.authorizeAgentRun(ctx, user, authentication, input.RunID, input.ChatID, input.ThreadRootID); err != nil {
		return err
	}
	if err := e.allow(ctx, user, "message.streaming"); err != nil {
		return err
	}
	expiresAt := time.Now().UTC().Add(15 * time.Second)
	if input.Done {
		expiresAt = time.Now().UTC()
	}
	frame := messageStreamingEventFrame{Op: input.Op, ActorID: user.ActorID, RunID: input.RunID, ChatID: input.ChatID, ThreadRootID: input.ThreadRootID, StreamID: input.StreamID, Index: input.Index, Delta: input.Delta, Reset: input.Reset, Done: input.Done, ExpiresAt: expiresAt}
	return e.broadcast(ctx, user, subscription.ConnectionID, input.ChatID, frame)
}

func (e *Ephemeral) authorizeAgentRun(ctx context.Context, user identity.User, authentication access.Identity, runID, chatID string, threadRootID *string) error {
	if authentication.AuthenticationKind != "api_key" || authentication.ActorID != user.ActorID || authentication.OrgID != user.OrgID || !slices.Contains(authentication.Scopes, "runtime:execute") {
		return ErrEphemeralForbidden
	}
	if err := e.authorizeScope(ctx, user, chatID, threadRootID); err != nil {
		return err
	}
	var allowed bool
	if err := e.pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM agent_runs WHERE org_id=$1 AND agent_id=$2 AND id=$3 AND chat_id=$4 AND thread_root_id IS NOT DISTINCT FROM $5::uuid AND status='running')`, user.OrgID, user.ActorID, runID, chatID, threadRootID).Scan(&allowed); err != nil {
		return err
	}
	if !allowed {
		return ErrEphemeralForbidden
	}
	return nil
}

func validAgentState(state string) bool {
	return state == "thinking" || state == "tool" || state == "streaming" || state == "completed" || state == "failed" || state == "canceled"
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
	envelope.Signature = e.signEnvelope(envelope)
	payload, err := json.Marshal(envelope)
	if err != nil {
		return err
	}
	if len(payload) > maxEphemeralEnvelopeBytes {
		return ErrEphemeralInvalid
	}
	opCtx, cancel := context.WithTimeout(ctx, e.opTimeout)
	defer cancel()
	if err := e.redis.Publish(opCtx, e.channel, payload).Err(); err != nil {
		return ErrEphemeralUnavailable
	}
	return nil
}

func (e *Ephemeral) signEnvelope(envelope ephemeralEnvelope) string {
	canonical, _ := json.Marshal(struct {
		OrgID               string          `json:"org_id"`
		ActorIDs            []string        `json:"actor_ids"`
		ExcludeConnectionID string          `json:"exclude_connection_id"`
		Data                json.RawMessage `json:"data"`
	}{envelope.OrgID, envelope.ActorIDs, envelope.ExcludeConnectionID, envelope.Data})
	mac := hmac.New(sha256.New, e.signingKey)
	_, _ = mac.Write(canonical)
	return base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
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
