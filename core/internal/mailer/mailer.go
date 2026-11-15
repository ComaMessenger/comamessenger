// Package mailer sends Coma letters for a workspace through the transport
// it chose (ADR-0013): the Coma mail relay, its own SMTP server, or none.
// Relay registration, address verification and retries of temporarily
// failed letters run in the background.
package mailer

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/comamessenger/comamessenger/core/internal/mailrelay"
	"github.com/comamessenger/comamessenger/core/internal/mailtemplate"
	"github.com/comamessenger/comamessenger/core/internal/workspace"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

var (
	ErrNotConfigured = mailtemplate.ErrNotConfigured
	ErrLimit         = mailtemplate.ErrLimit
	ErrRejected      = mailtemplate.ErrRejected
)

// temporaryError is a relay failure worth retrying.
type temporaryError struct {
	reason     string
	retryAfter time.Duration
}

func (e *temporaryError) Error() string { return "coma mail temporarily unavailable: " + e.reason }

// Workspace is the part of the workspace service the mailer needs.
type Workspace interface {
	MailSettings(ctx context.Context, orgID string) (workspace.MailSettings, error)
	SendSMTP(ctx context.Context, config workspace.SMTPConfig, recipient, subject, text, html string) error
	Seal(purpose string, plain []byte) ([]byte, error)
	Open(purpose string, sealed []byte) ([]byte, error)
}

type Mailer struct {
	logger   *slog.Logger
	pool     *pgxpool.Pool
	ws       Workspace
	relayURL string
	appURL   string
	client   *http.Client
	now      func() time.Time
	wake     chan struct{}

	mu        sync.Mutex
	quota     *quotaView
	quotaAt   time.Time
	stateAt   time.Time
	stateLive bool
}

type quotaView struct {
	Status            string `json:"status"`
	DailyLimit        int    `json:"daily_limit"`
	Used              int    `json:"used"`
	PerRecipientLimit int    `json:"per_recipient_limit"`
}

// New builds a mailer. relayURL is empty when Coma mail is switched off.
func New(logger *slog.Logger, pool *pgxpool.Pool, ws Workspace, relayURL, appURL string, client *http.Client) *Mailer {
	if client == nil {
		client = &http.Client{Timeout: 15 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	}
	return &Mailer{logger: logger, pool: pool, ws: ws, relayURL: strings.TrimRight(relayURL, "/"), appURL: strings.TrimRight(appURL, "/"),
		client: client, now: time.Now, wake: make(chan struct{}, 1)}
}

// relayUsable reports why Coma mail cannot work for this installation, or
// "" when it can: the relay must be configured and the installation must
// have a public HTTPS address the relay can verify.
func (m *Mailer) relayUsable() string {
	if m.relayURL == "" {
		return "relay_disabled"
	}
	insecure := strings.HasPrefix(m.relayURL, "http://")
	base, err := mailrelay.NormalizeAppURL(m.appURL, insecure)
	if err != nil {
		return "public_https_required"
	}
	if !insecure && mailrelay.PublicOrigin(base) != nil {
		return "public_https_required"
	}
	return ""
}

// EmailConfigured reports whether letters can leave the workspace now.
func (m *Mailer) EmailConfigured(ctx context.Context, orgID string) (bool, error) {
	settings, err := m.ws.MailSettings(ctx, orgID)
	if err != nil {
		return false, err
	}
	switch settings.Delivery {
	case workspace.MailDeliverySMTP:
		return settings.SMTPReady(), nil
	case workspace.MailDeliveryComa:
		return m.relayActive(ctx), nil
	}
	return false, nil
}

func (m *Mailer) relayActive(ctx context.Context) bool {
	if m.relayUsable() != "" {
		return false
	}
	m.mu.Lock()
	if m.now().Sub(m.stateAt) < 10*time.Second {
		live := m.stateLive
		m.mu.Unlock()
		return live
	}
	m.mu.Unlock()
	state, err := m.loadState(ctx)
	live := err == nil && state.Status == "active" && len(state.KeySealed) > 0
	m.mu.Lock()
	m.stateAt, m.stateLive = m.now(), live
	m.mu.Unlock()
	return live
}

func (m *Mailer) forgetState() {
	m.mu.Lock()
	m.stateAt = time.Time{}
	m.quotaAt = time.Time{}
	m.mu.Unlock()
}

// Send delivers one letter. Through Coma mail a temporary failure queues
// the letter for retries and returns nil; ErrLimit and ErrRejected are
// final.
func (m *Mailer) Send(ctx context.Context, orgID string, message mailtemplate.Message) error {
	return m.send(ctx, orgID, message, "", "", true)
}

// SendDigest delivers a digest: the detailed subject and body go through the
// workspace's own SMTP, which never leaves its infrastructure; Coma mail
// gets the counters-only message. Failures are returned, the digest worker
// retries on its own schedule.
func (m *Mailer) SendDigest(ctx context.Context, orgID string, counters mailtemplate.Message, subject, body string) error {
	return m.send(ctx, orgID, counters, subject, body, false)
}

// DigestThroughComa reports whether digests of the workspace go through the
// relay and must therefore be rationed.
func (m *Mailer) DigestThroughComa(ctx context.Context, orgID string) (bool, error) {
	settings, err := m.ws.MailSettings(ctx, orgID)
	if err != nil {
		return false, err
	}
	return settings.Delivery == workspace.MailDeliveryComa, nil
}

func (m *Mailer) send(ctx context.Context, orgID string, message mailtemplate.Message, detailedSubject, detailedBody string, queue bool) error {
	settings, err := m.ws.MailSettings(ctx, orgID)
	if err != nil {
		return err
	}
	message.WorkspaceName = settings.WorkspaceName
	if message.Locale == "" {
		message.Locale = m.localeFor(ctx, orgID, message.To)
	}
	message.Normalize()
	switch settings.Delivery {
	case workspace.MailDeliverySMTP:
		if !settings.SMTPReady() {
			return ErrNotConfigured
		}
		config := settings.SMTP
		if detailedSubject != "" {
			return m.ws.SendSMTP(ctx, config, message.To, detailedSubject, detailedBody, "")
		}
		rendered := mailtemplate.Render(message)
		if config.FromName == "" {
			config.FromName = mailtemplate.CleanName(settings.WorkspaceName, "Coma")
		}
		return m.ws.SendSMTP(ctx, config, message.To, rendered.Subject, rendered.Text, rendered.HTML)
	case workspace.MailDeliveryComa:
		if !m.relayActive(ctx) {
			return ErrNotConfigured
		}
		id := uuid.NewString()
		err := m.relaySend(ctx, id, message)
		var temporary *temporaryError
		if queue && errors.As(err, &temporary) {
			if queueErr := m.enqueue(ctx, orgID, id, message, temporary); queueErr != nil {
				return errors.Join(err, queueErr)
			}
			m.logger.Info("coma mail queued for retry", "kind", message.Kind, "reason", temporary.reason)
			return nil
		}
		return err
	}
	return ErrNotConfigured
}

func (m *Mailer) localeFor(ctx context.Context, orgID, email string) string {
	var locale string
	err := m.pool.QueryRow(ctx, `SELECT COALESCE(preferences->>'locale','') FROM users WHERE org_id=$1 AND email=$2`, orgID, email).Scan(&locale)
	if err != nil || locale != "en" {
		return "ru"
	}
	return locale
}

// relayError is the relay's error body.
type relayError struct {
	Error string `json:"error"`
}

// relaySend posts one message. idempotency is stable across retries, so a
// letter the relay already accepted is never sent twice.
func (m *Mailer) relaySend(ctx context.Context, idempotency string, message mailtemplate.Message) error {
	state, err := m.loadState(ctx)
	if err != nil {
		return &temporaryError{reason: "state"}
	}
	if state.Status == "revoked" {
		return fmt.Errorf("%w: installation revoked", ErrRejected)
	}
	if state.Status != "active" || len(state.KeySealed) == 0 {
		return &temporaryError{reason: "registering"}
	}
	key, err := m.ws.Open("relay-key", state.KeySealed)
	if err != nil {
		return fmt.Errorf("%w: relay key cannot be decrypted", ErrRejected)
	}
	body, err := json.Marshal(message)
	if err != nil {
		return err
	}
	sendCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	request, err := http.NewRequestWithContext(sendCtx, http.MethodPost, m.relayURL+"/v1/messages", bytes.NewReader(body))
	if err != nil {
		return err
	}
	request.Header.Set("Authorization", "Bearer "+string(key))
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Idempotency-Key", idempotency)
	response, err := m.client.Do(request)
	if err != nil {
		return &temporaryError{reason: "network"}
	}
	defer response.Body.Close()
	var failure relayError
	_ = json.NewDecoder(io.LimitReader(response.Body, 8<<10)).Decode(&failure)
	m.forgetQuota()
	switch {
	case response.StatusCode == http.StatusAccepted:
		return nil
	case response.StatusCode == http.StatusUnauthorized:
		m.resetRegistration(ctx, "invalid_key")
		return &temporaryError{reason: "invalid_key"}
	case failure.Error == "installation_pending":
		m.setStatus(ctx, "registering", "installation_pending")
		return &temporaryError{reason: "installation_pending"}
	case failure.Error == "installation_revoked":
		m.setStatus(ctx, "revoked", "installation_revoked")
		return fmt.Errorf("%w: installation revoked", ErrRejected)
	case failure.Error == "recipient_limit" || failure.Error == "installation_limit":
		return fmt.Errorf("%w: %s", ErrLimit, failure.Error)
	case response.StatusCode == http.StatusTooManyRequests || response.StatusCode >= 500:
		return &temporaryError{reason: "relay_" + strconv.Itoa(response.StatusCode), retryAfter: parseRetryAfter(response.Header.Get("Retry-After"))}
	default:
		code := failure.Error
		if code == "" {
			code = strconv.Itoa(response.StatusCode)
		}
		return fmt.Errorf("%w: %s", ErrRejected, code)
	}
}

func parseRetryAfter(value string) time.Duration {
	seconds, err := strconv.Atoi(strings.TrimSpace(value))
	if err != nil || seconds < 1 {
		return 0
	}
	return min(time.Duration(seconds)*time.Second, time.Hour)
}

// ComaStatus is what the settings page shows for Coma mail.
func (m *Mailer) ComaStatus(ctx context.Context) workspace.ComaMailStatus {
	status := workspace.ComaMailStatus{State: "unavailable", PerRecipientLimit: 6}
	if reason := m.relayUsable(); reason != "" {
		status.Reason = reason
		return status
	}
	state, err := m.loadState(ctx)
	if errors.Is(err, pgx.ErrNoRows) {
		status.State = "registering"
		return status
	}
	if err != nil {
		status.State = "error"
		return status
	}
	status.State = state.Status
	if state.Status != "active" {
		status.Reason = state.LastError
		return status
	}
	if quota := m.fetchQuota(ctx, state); quota != nil {
		status.Used, status.DailyLimit = &quota.Used, &quota.DailyLimit
		if quota.PerRecipientLimit > 0 {
			status.PerRecipientLimit = quota.PerRecipientLimit
		}
	}
	return status
}

func (m *Mailer) forgetQuota() {
	m.mu.Lock()
	m.quotaAt = time.Time{}
	m.mu.Unlock()
}

func (m *Mailer) fetchQuota(ctx context.Context, state relayState) *quotaView {
	m.mu.Lock()
	if m.quota != nil && m.now().Sub(m.quotaAt) < time.Minute {
		cached := *m.quota
		m.mu.Unlock()
		return &cached
	}
	m.mu.Unlock()
	key, err := m.ws.Open("relay-key", state.KeySealed)
	if err != nil {
		return nil
	}
	quotaCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	request, err := http.NewRequestWithContext(quotaCtx, http.MethodGet, m.relayURL+"/v1/quota", nil)
	if err != nil {
		return nil
	}
	request.Header.Set("Authorization", "Bearer "+string(key))
	response, err := m.client.Do(request)
	if err != nil {
		return nil
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return nil
	}
	var quota quotaView
	if err := json.NewDecoder(io.LimitReader(response.Body, 8<<10)).Decode(&quota); err != nil {
		return nil
	}
	m.mu.Lock()
	m.quota, m.quotaAt = &quota, m.now()
	m.mu.Unlock()
	return &quota
}
