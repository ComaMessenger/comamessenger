// Package webhook receives signed events from external systems (an
// accounting system, a booking tool) and turns them into agent runs through
// webhook triggers. Each webhook has its own secret; a delivery must carry a
// fresh timestamp, a unique delivery id and an HMAC-SHA256 signature over
// both and the body. Accepted and rejected deliveries are journaled.
package webhook

import (
	"bytes"
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/comamessenger/comamessenger/core/internal/agentauthz"
	"io"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/comamessenger/comamessenger/core/internal/agenttrigger"
	"github.com/comamessenger/comamessenger/core/internal/id"
	"github.com/comamessenger/comamessenger/core/internal/identity"
	"github.com/comamessenger/comamessenger/core/internal/permission"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

var (
	ErrInvalid   = errors.New("invalid webhook")
	ErrForbidden = errors.New("webhook forbidden")
	ErrNotFound  = errors.New("webhook not found")
	ErrConflict  = errors.New("webhook in use")
)

const (
	// SignatureTolerance is the accepted clock difference for a delivery.
	SignatureTolerance = 5 * time.Minute
	// MaxBodyBytes is the hard ceiling for any webhook body.
	MaxBodyBytes      = 262144
	journalRetention  = 30 * 24 * time.Hour
	secretPrefix      = "whsec_"
	headerTimestamp   = "X-Coma-Timestamp"
	headerDelivery    = "X-Coma-Delivery"
	headerEvent       = "X-Coma-Event"
	headerSignature   = "X-Coma-Signature"
	signatureSchemeV1 = "sha256="
)

var (
	deliveryPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$`)
	eventPattern    = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.:-]{0,119}$`)
)

type Webhook struct {
	ID                 string     `json:"id"`
	Name               string     `json:"name"`
	Description        string     `json:"description"`
	Enabled            bool       `json:"enabled"`
	SecretHint         string     `json:"secret_hint"`
	RateLimitPerMinute int        `json:"rate_limit_per_minute"`
	MaxBodyBytes       int        `json:"max_body_bytes"`
	LastReceivedAt     *time.Time `json:"last_received_at"`
	// Requests without a valid signature are counted here, not journaled.
	RejectedCount    int64      `json:"rejected_count"`
	LastRejectedAt   *time.Time `json:"last_rejected_at"`
	LastRejectedCode string     `json:"last_rejected_code"`
	TriggerCount     int        `json:"trigger_count"`
	CreatedBy        string     `json:"created_by"`
	CreatedAt        time.Time  `json:"created_at"`
	UpdatedAt        time.Time  `json:"updated_at"`
}

// WebhookWithSecret is returned exactly once, on creation or rotation.
type WebhookWithSecret struct {
	Webhook
	Secret string `json:"secret"`
}

type CreateInput struct {
	Name               string `json:"name"`
	Description        string `json:"description"`
	Enabled            *bool  `json:"enabled"`
	RateLimitPerMinute int    `json:"rate_limit_per_minute"`
	MaxBodyBytes       int    `json:"max_body_bytes"`
}

type UpdateInput struct {
	Name               *string `json:"name"`
	Description        *string `json:"description"`
	Enabled            *bool   `json:"enabled"`
	RateLimitPerMinute *int    `json:"rate_limit_per_minute"`
	MaxBodyBytes       *int    `json:"max_body_bytes"`
}

// Delivery is one journal entry. Bodies are never stored, only their size
// and digest.
type Delivery struct {
	ID          string    `json:"id"`
	DeliveryID  string    `json:"delivery_id"`
	EventType   string    `json:"event_type"`
	Status      string    `json:"status"`
	ErrorCode   string    `json:"error_code"`
	BodyBytes   int       `json:"body_bytes"`
	BodySHA256  string    `json:"body_sha256"`
	RunsCreated int       `json:"runs_created"`
	ReceivedAt  time.Time `json:"received_at"`
}

// Dispatcher creates agent runs for an accepted delivery.
type Dispatcher interface {
	DispatchWebhook(ctx context.Context, tx pgx.Tx, delivery agenttrigger.WebhookDelivery) (int, error)
}

type Service struct {
	pool       *pgxpool.Pool
	aead       cipher.AEAD
	dispatcher Dispatcher
	now        func() time.Time
}

func NewService(pool *pgxpool.Pool, secret string, dispatcher Dispatcher) (*Service, error) {
	digest := sha256.Sum256([]byte("comamessenger/integration-webhooks/v1\x00" + secret))
	block, err := aes.NewCipher(digest[:])
	if err != nil {
		return nil, err
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	return &Service{pool: pool, aead: aead, dispatcher: dispatcher, now: time.Now}, nil
}

func canManage(current identity.User) bool {
	return permission.Allows(current.OrgRole, current.Permissions, permission.IntegrationsManage)
}

const webhookSelect = `SELECT hook.id,hook.name,hook.description,hook.enabled,hook.secret_hint,hook.rate_limit_per_minute,hook.max_body_bytes,hook.last_received_at,
	hook.rejected_count,hook.last_rejected_at,hook.last_rejected_code,
	(SELECT count(*) FROM agent_triggers trigger WHERE trigger.org_id=hook.org_id AND trigger.type='webhook' AND trigger.superseded_at IS NULL AND trigger.config->>'webhook_id'=hook.id::text),
	hook.created_by,hook.created_at,hook.updated_at FROM integration_webhooks hook`

func scanWebhook(row pgx.Row) (Webhook, error) {
	var hook Webhook
	err := row.Scan(&hook.ID, &hook.Name, &hook.Description, &hook.Enabled, &hook.SecretHint, &hook.RateLimitPerMinute, &hook.MaxBodyBytes, &hook.LastReceivedAt,
		&hook.RejectedCount, &hook.LastRejectedAt, &hook.LastRejectedCode,
		&hook.TriggerCount, &hook.CreatedBy, &hook.CreatedAt, &hook.UpdatedAt)
	return hook, err
}

// List returns the webhooks of the workspace. Agent builders see them too,
// to start an agent by one, but without the secret hint or rejection
// details, which only integrations.manage needs.
func (service *Service) List(ctx context.Context, current identity.User) ([]Webhook, error) {
	manager := canManage(current)
	if !manager && !agentauthz.New().CanBuild(current) {
		return nil, ErrForbidden
	}
	rows, err := service.pool.Query(ctx, webhookSelect+` WHERE hook.org_id=$1 ORDER BY lower(hook.name),hook.id`, current.OrgID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := make([]Webhook, 0)
	for rows.Next() {
		hook, err := scanWebhook(rows)
		if err != nil {
			return nil, err
		}
		if !manager {
			hook.SecretHint, hook.RejectedCount, hook.LastRejectedAt, hook.LastRejectedCode = "", 0, nil, ""
		}
		result = append(result, hook)
	}
	return result, rows.Err()
}

func (service *Service) get(ctx context.Context, orgID, webhookID string) (Webhook, error) {
	hook, err := scanWebhook(service.pool.QueryRow(ctx, webhookSelect+` WHERE hook.org_id=$1 AND hook.id=$2`, orgID, webhookID))
	if errors.Is(err, pgx.ErrNoRows) {
		return Webhook{}, ErrNotFound
	}
	return hook, err
}

func validSettings(name, description string, rate, maxBody int) bool {
	return len([]rune(name)) >= 1 && len([]rune(name)) <= 120 && len([]rune(description)) <= 500 && rate >= 1 && rate <= 6000 && maxBody >= 1024 && maxBody <= MaxBodyBytes
}

func (service *Service) Create(ctx context.Context, current identity.User, input CreateInput) (WebhookWithSecret, error) {
	if !canManage(current) {
		return WebhookWithSecret{}, ErrForbidden
	}
	if input.RateLimitPerMinute == 0 {
		input.RateLimitPerMinute = 60
	}
	if input.MaxBodyBytes == 0 {
		input.MaxBodyBytes = 65536
	}
	name, description := strings.TrimSpace(input.Name), strings.TrimSpace(input.Description)
	if !validSettings(name, description, input.RateLimitPerMinute, input.MaxBodyBytes) {
		return WebhookWithSecret{}, ErrInvalid
	}
	webhookID, err := id.New()
	if err != nil {
		return WebhookWithSecret{}, err
	}
	secret, nonce, ciphertext, err := service.newSecret(current.OrgID, webhookID)
	if err != nil {
		return WebhookWithSecret{}, err
	}
	enabled := true
	if input.Enabled != nil {
		enabled = *input.Enabled
	}
	tx, err := service.pool.Begin(ctx)
	if err != nil {
		return WebhookWithSecret{}, err
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, `INSERT INTO integration_webhooks(id,org_id,name,description,enabled,secret_nonce,secret_ciphertext,secret_hint,rate_limit_per_minute,max_body_bytes,created_by,updated_by)
		VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11)`, webhookID, current.OrgID, name, description, enabled, nonce, ciphertext, secretHint(secret),
		input.RateLimitPerMinute, input.MaxBodyBytes, current.ActorID); err != nil {
		return WebhookWithSecret{}, err
	}
	if err := audit(ctx, tx, current, webhookID, "create", map[string]any{"name": name, "enabled": enabled}); err != nil {
		return WebhookWithSecret{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return WebhookWithSecret{}, err
	}
	hook, err := service.get(ctx, current.OrgID, webhookID)
	return WebhookWithSecret{Webhook: hook, Secret: secret}, err
}

func (service *Service) Update(ctx context.Context, current identity.User, webhookID string, input UpdateInput) (Webhook, error) {
	if !canManage(current) {
		return Webhook{}, ErrForbidden
	}
	if uuid.Validate(webhookID) != nil {
		return Webhook{}, ErrNotFound
	}
	existing, err := service.get(ctx, current.OrgID, webhookID)
	if err != nil {
		return Webhook{}, err
	}
	if input.Name != nil {
		existing.Name = strings.TrimSpace(*input.Name)
	}
	if input.Description != nil {
		existing.Description = strings.TrimSpace(*input.Description)
	}
	if input.Enabled != nil {
		existing.Enabled = *input.Enabled
	}
	if input.RateLimitPerMinute != nil {
		existing.RateLimitPerMinute = *input.RateLimitPerMinute
	}
	if input.MaxBodyBytes != nil {
		existing.MaxBodyBytes = *input.MaxBodyBytes
	}
	if !validSettings(existing.Name, existing.Description, existing.RateLimitPerMinute, existing.MaxBodyBytes) {
		return Webhook{}, ErrInvalid
	}
	tx, err := service.pool.Begin(ctx)
	if err != nil {
		return Webhook{}, err
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, `UPDATE integration_webhooks SET name=$3,description=$4,enabled=$5,rate_limit_per_minute=$6,max_body_bytes=$7,updated_by=$8,updated_at=now()
		WHERE org_id=$1 AND id=$2`, current.OrgID, webhookID, existing.Name, existing.Description, existing.Enabled, existing.RateLimitPerMinute, existing.MaxBodyBytes, current.ActorID); err != nil {
		return Webhook{}, err
	}
	if err := audit(ctx, tx, current, webhookID, "update", map[string]any{"name": existing.Name, "enabled": existing.Enabled,
		"rate_limit_per_minute": existing.RateLimitPerMinute, "max_body_bytes": existing.MaxBodyBytes}); err != nil {
		return Webhook{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Webhook{}, err
	}
	return service.get(ctx, current.OrgID, webhookID)
}

// RotateSecret replaces the secret immediately; the old one stops working.
func (service *Service) RotateSecret(ctx context.Context, current identity.User, webhookID string) (WebhookWithSecret, error) {
	if !canManage(current) {
		return WebhookWithSecret{}, ErrForbidden
	}
	if uuid.Validate(webhookID) != nil {
		return WebhookWithSecret{}, ErrNotFound
	}
	secret, nonce, ciphertext, err := service.newSecret(current.OrgID, webhookID)
	if err != nil {
		return WebhookWithSecret{}, err
	}
	tx, err := service.pool.Begin(ctx)
	if err != nil {
		return WebhookWithSecret{}, err
	}
	defer tx.Rollback(ctx)
	result, err := tx.Exec(ctx, `UPDATE integration_webhooks SET secret_nonce=$3,secret_ciphertext=$4,secret_hint=$5,updated_by=$6,updated_at=now() WHERE org_id=$1 AND id=$2`,
		current.OrgID, webhookID, nonce, ciphertext, secretHint(secret), current.ActorID)
	if err != nil {
		return WebhookWithSecret{}, err
	}
	if result.RowsAffected() != 1 {
		return WebhookWithSecret{}, ErrNotFound
	}
	if err := audit(ctx, tx, current, webhookID, "rotate_secret", nil); err != nil {
		return WebhookWithSecret{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return WebhookWithSecret{}, err
	}
	hook, err := service.get(ctx, current.OrgID, webhookID)
	return WebhookWithSecret{Webhook: hook, Secret: secret}, err
}

// Delete refuses while agent triggers reference the webhook; disable it or
// remove the triggers first.
func (service *Service) Delete(ctx context.Context, current identity.User, webhookID string) error {
	if !canManage(current) {
		return ErrForbidden
	}
	if uuid.Validate(webhookID) != nil {
		return ErrNotFound
	}
	tx, err := service.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	var used bool
	if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM agent_triggers WHERE org_id=$1 AND type='webhook' AND superseded_at IS NULL AND config->>'webhook_id'=$2::text)`, current.OrgID, webhookID).Scan(&used); err != nil {
		return err
	}
	if used {
		return ErrConflict
	}
	result, err := tx.Exec(ctx, `DELETE FROM integration_webhooks WHERE org_id=$1 AND id=$2`, current.OrgID, webhookID)
	if err != nil {
		return err
	}
	if result.RowsAffected() != 1 {
		return ErrNotFound
	}
	if err := audit(ctx, tx, current, webhookID, "delete", nil); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (service *Service) Deliveries(ctx context.Context, current identity.User, webhookID string) ([]Delivery, error) {
	if !canManage(current) {
		return nil, ErrForbidden
	}
	if uuid.Validate(webhookID) != nil {
		return nil, ErrNotFound
	}
	if _, err := service.get(ctx, current.OrgID, webhookID); err != nil {
		return nil, err
	}
	rows, err := service.pool.Query(ctx, `SELECT id,delivery_id,event_type,status,error_code,body_bytes,body_sha256,runs_created,received_at
		FROM integration_webhook_deliveries WHERE org_id=$1 AND webhook_id=$2 ORDER BY received_at DESC,id DESC LIMIT 100`, current.OrgID, webhookID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := make([]Delivery, 0)
	for rows.Next() {
		var delivery Delivery
		if err := rows.Scan(&delivery.ID, &delivery.DeliveryID, &delivery.EventType, &delivery.Status, &delivery.ErrorCode, &delivery.BodyBytes, &delivery.BodySHA256,
			&delivery.RunsCreated, &delivery.ReceivedAt); err != nil {
			return nil, err
		}
		result = append(result, delivery)
	}
	return result, rows.Err()
}

// Outcome is the public result of a receive attempt. Status is an HTTP
// status; Code is a stable machine-readable reason. Unsigned marks a request
// that did not prove knowledge of the secret: callers rate-limit those per
// client address.
type Outcome struct {
	Status      int    `json:"-"`
	Code        string `json:"status"`
	DeliveryID  string `json:"delivery_id,omitempty"`
	RunsCreated int    `json:"runs_created"`
	Unsigned    bool   `json:"-"`
}

// Headers abstracts http.Header for Receive.
type Headers interface{ Get(string) string }

// Receive verifies and journals one delivery. body is already bounded by the
// caller to MaxBodyBytes+1.
//
// Order matters: size, headers, timestamp and signature are checked before
// anything is counted against the webhook. Requests without a valid
// signature never consume the webhook's rate limit and never add journal
// rows; they only bump an aggregate counter on the webhook. The per-minute
// limit counts signed deliveries only.
func (service *Service) Receive(ctx context.Context, webhookID string, headers Headers, body []byte) (Outcome, error) {
	if uuid.Validate(webhookID) != nil {
		return Outcome{Status: 404, Code: "not_found", Unsigned: true}, nil
	}
	var orgID, name string
	var enabled bool
	var rate, maxBody int
	var nonce, ciphertext []byte
	err := service.pool.QueryRow(ctx, `SELECT org_id,name,enabled,rate_limit_per_minute,max_body_bytes,secret_nonce,secret_ciphertext FROM integration_webhooks WHERE id=$1`, webhookID).Scan(
		&orgID, &name, &enabled, &rate, &maxBody, &nonce, &ciphertext)
	if errors.Is(err, pgx.ErrNoRows) {
		return Outcome{Status: 404, Code: "not_found", Unsigned: true}, nil
	}
	if err != nil {
		return Outcome{}, err
	}
	now := service.now().UTC()
	unsigned := func(status int, code string) (Outcome, error) {
		if _, err := service.pool.Exec(ctx, `UPDATE integration_webhooks SET rejected_count=rejected_count+1,last_rejected_at=$2,last_rejected_code=$3 WHERE id=$1`,
			webhookID, now, code); err != nil {
			return Outcome{}, err
		}
		return Outcome{Status: status, Code: code, Unsigned: true}, nil
	}
	if len(body) > maxBody {
		return unsigned(413, "body_too_large")
	}
	deliveryID := strings.TrimSpace(headers.Get(headerDelivery))
	eventType := strings.TrimSpace(headers.Get(headerEvent))
	if !deliveryPattern.MatchString(deliveryID) || (eventType != "" && !eventPattern.MatchString(eventType)) {
		return unsigned(400, "invalid_headers")
	}
	timestamp, err := strconv.ParseInt(strings.TrimSpace(headers.Get(headerTimestamp)), 10, 64)
	if err != nil {
		return unsigned(400, "invalid_timestamp")
	}
	if skew := now.Sub(time.Unix(timestamp, 0)); skew > SignatureTolerance || skew < -SignatureTolerance {
		return unsigned(401, "stale_timestamp")
	}
	secret, err := service.openSecret(orgID, webhookID, nonce, ciphertext)
	if err != nil {
		return Outcome{}, err
	}
	if !validSignature(secret, headers.Get(headerTimestamp), deliveryID, body, headers.Get(headerSignature)) {
		return unsigned(401, "invalid_signature")
	}
	// From here on the sender holds the secret.
	if !enabled {
		return Outcome{Status: 403, Code: "webhook_disabled", DeliveryID: deliveryID}, nil
	}
	var recent int
	if err := service.pool.QueryRow(ctx, `SELECT count(*) FROM integration_webhook_deliveries WHERE webhook_id=$1 AND received_at>$2`, webhookID, now.Add(-time.Minute)).Scan(&recent); err != nil {
		return Outcome{}, err
	}
	if recent >= rate {
		return Outcome{Status: 429, Code: "rate_limited", DeliveryID: deliveryID}, nil
	}
	digest := sha256.Sum256(body)
	record := Delivery{DeliveryID: deliveryID, EventType: eventType, BodyBytes: len(body), BodySHA256: hex.EncodeToString(digest[:])}
	reject := func(status int, code string) (Outcome, error) {
		record.Status, record.ErrorCode = "rejected", code
		if err := service.journal(ctx, nil, orgID, webhookID, &record, now); err != nil {
			return Outcome{}, err
		}
		return Outcome{Status: status, Code: code, DeliveryID: deliveryID}, nil
	}
	trimmed := bytes.TrimSpace(body)
	if len(trimmed) == 0 || trimmed[0] != '{' || !json.Valid(trimmed) {
		return reject(400, "invalid_json")
	}
	payload := json.RawMessage(trimmed)
	tx, err := service.pool.Begin(ctx)
	if err != nil {
		return Outcome{}, err
	}
	defer tx.Rollback(ctx)
	record.Status = "accepted"
	if err := service.journal(ctx, tx, orgID, webhookID, &record, now); err != nil {
		var pgErr interface{ SQLState() string }
		if errors.As(err, &pgErr) && pgErr.SQLState() == "23505" {
			_ = tx.Rollback(ctx)
			outcome, rejectErr := reject(200, "duplicate_delivery")
			outcome.Code = "duplicate"
			return outcome, rejectErr
		}
		return Outcome{}, err
	}
	runs := 0
	if service.dispatcher != nil {
		runs, err = service.dispatcher.DispatchWebhook(ctx, tx, agenttrigger.WebhookDelivery{OrgID: orgID, WebhookID: webhookID, WebhookName: name, RecordID: record.ID,
			DeliveryID: deliveryID, EventType: eventType, ReceivedAt: now, Payload: payload})
		if err != nil {
			return Outcome{}, err
		}
	}
	if _, err := tx.Exec(ctx, `UPDATE integration_webhook_deliveries SET runs_created=$2 WHERE id=$1`, record.ID, runs); err != nil {
		return Outcome{}, err
	}
	if _, err := tx.Exec(ctx, `UPDATE integration_webhooks SET last_received_at=$2 WHERE id=$1`, webhookID, now); err != nil {
		return Outcome{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Outcome{}, err
	}
	return Outcome{Status: 202, Code: "accepted", DeliveryID: deliveryID, RunsCreated: runs}, nil
}

// JournalLimit is how many newest journal rows each webhook keeps.
const JournalLimit = 1000

// CleanupJournal removes journal rows older than the retention period and
// beyond the newest JournalLimit rows of each webhook.
func (service *Service) CleanupJournal(ctx context.Context) (int64, error) {
	now := service.now().UTC()
	result, err := service.pool.Exec(ctx, `DELETE FROM integration_webhook_deliveries delivery
		WHERE delivery.received_at < $1
		   OR delivery.id IN (
			SELECT ranked.id FROM (
				SELECT id,row_number() OVER (PARTITION BY webhook_id ORDER BY received_at DESC,id DESC) AS position
				FROM integration_webhook_deliveries) ranked
			WHERE ranked.position > $2)`, now.Add(-journalRetention), JournalLimit)
	if err != nil {
		return 0, err
	}
	return result.RowsAffected(), nil
}

// Run cleans the journal periodically until ctx ends.
func (service *Service) Run(ctx context.Context, interval time.Duration, logger interface{ Error(string, ...any) }) {
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		if _, err := service.CleanupJournal(ctx); err != nil && ctx.Err() == nil && logger != nil {
			logger.Error("webhook journal cleanup failed", "error", err)
		}
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

func (service *Service) journal(ctx context.Context, tx pgx.Tx, orgID, webhookID string, record *Delivery, now time.Time) error {
	recordID, err := id.New()
	if err != nil {
		return err
	}
	record.ID = recordID
	const statement = `INSERT INTO integration_webhook_deliveries(id,org_id,webhook_id,delivery_id,event_type,status,error_code,body_bytes,body_sha256,received_at)
		VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`
	args := []any{recordID, orgID, webhookID, record.DeliveryID, record.EventType, record.Status, record.ErrorCode, record.BodyBytes, record.BodySHA256, now}
	if tx != nil {
		_, err = tx.Exec(ctx, statement, args...)
	} else {
		_, err = service.pool.Exec(ctx, statement, args...)
	}
	return err
}

// Sign computes the signature header value for a delivery. External systems
// implement the same: HMAC-SHA256 over "<timestamp>.<delivery id>.<body>".
func Sign(secret, timestamp, deliveryID string, body []byte) string {
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(timestamp))
	mac.Write([]byte{'.'})
	mac.Write([]byte(deliveryID))
	mac.Write([]byte{'.'})
	mac.Write(body)
	return signatureSchemeV1 + hex.EncodeToString(mac.Sum(nil))
}

func validSignature(secret, timestamp, deliveryID string, body []byte, header string) bool {
	expected := Sign(secret, strings.TrimSpace(timestamp), deliveryID, body)
	for _, candidate := range strings.Split(header, ",") {
		if hmac.Equal([]byte(strings.TrimSpace(candidate)), []byte(expected)) {
			return true
		}
	}
	return false
}

func (service *Service) newSecret(orgID, webhookID string) (string, []byte, []byte, error) {
	raw := make([]byte, 32)
	if _, err := io.ReadFull(rand.Reader, raw); err != nil {
		return "", nil, nil, err
	}
	secret := secretPrefix + base64.RawURLEncoding.EncodeToString(raw)
	nonce := make([]byte, service.aead.NonceSize())
	if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
		return "", nil, nil, err
	}
	return secret, nonce, service.aead.Seal(nil, nonce, []byte(secret), secretAAD(orgID, webhookID)), nil
}

func (service *Service) openSecret(orgID, webhookID string, nonce, ciphertext []byte) (string, error) {
	plain, err := service.aead.Open(nil, nonce, ciphertext, secretAAD(orgID, webhookID))
	if err != nil {
		return "", fmt.Errorf("decrypt webhook secret: %w", err)
	}
	return string(plain), nil
}

func secretAAD(orgID, webhookID string) []byte {
	return []byte(orgID + "\x00webhook\x00" + webhookID + "\x001")
}

func secretHint(secret string) string {
	return secretPrefix + "••••" + secret[len(secret)-4:]
}

func audit(ctx context.Context, tx pgx.Tx, current identity.User, webhookID, operation string, metadata map[string]any) error {
	auditID, err := id.New()
	if err != nil {
		return err
	}
	if metadata == nil {
		metadata = map[string]any{}
	}
	encoded, _ := json.Marshal(metadata)
	_, err = tx.Exec(ctx, `INSERT INTO audit_log(id,org_id,actor_id,action,target_type,target_id,metadata)
		VALUES($1,$2,$3,'integration.webhook.' || $4,'integration_webhook',$5,$6)`, auditID, current.OrgID, current.ActorID, operation, webhookID, encoded)
	return err
}
