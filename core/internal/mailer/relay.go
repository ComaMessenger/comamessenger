package mailer

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"time"

	"github.com/comamessenger/comamessenger/core/internal/mailtemplate"
	"github.com/jackc/pgx/v5"
)

type relayState struct {
	RelayURL       string
	AppURL         string
	InstallationID string
	KeySealed      []byte
	Challenge      string
	Status         string
	LastError      string
	NextAttemptAt  time.Time
	Attempts       int
}

func (m *Mailer) loadState(ctx context.Context) (relayState, error) {
	var state relayState
	err := m.pool.QueryRow(ctx, `SELECT relay_url,app_url,installation_id,key_sealed,challenge,status,last_error,next_attempt_at,attempts FROM mail_relay_state`).
		Scan(&state.RelayURL, &state.AppURL, &state.InstallationID, &state.KeySealed, &state.Challenge, &state.Status, &state.LastError, &state.NextAttemptAt, &state.Attempts)
	if err == nil && (state.RelayURL != m.relayURL || state.AppURL != m.appURL) {
		// The relay or the public address changed: the old key is useless.
		return relayState{}, pgx.ErrNoRows
	}
	return state, err
}

func (m *Mailer) setStatus(ctx context.Context, status, reason string) {
	_, _ = m.pool.Exec(ctx, `UPDATE mail_relay_state SET status=$1,last_error=$2,next_attempt_at=now(),updated_at=now()`, status, truncate(reason))
	m.forgetState()
	m.kick()
}

func (m *Mailer) resetRegistration(ctx context.Context, reason string) {
	_, _ = m.pool.Exec(ctx, `UPDATE mail_relay_state SET status='registering',installation_id='',key_sealed=NULL,challenge='',last_error=$1,next_attempt_at=now(),attempts=0,updated_at=now()`, truncate(reason))
	m.forgetState()
	m.kick()
}

func truncate(value string) string {
	if len(value) > 500 {
		return value[:500]
	}
	return value
}

func (m *Mailer) kick() {
	select {
	case m.wake <- struct{}{}:
	default:
	}
}

// Challenge is what GET /api/v1/mail-relay/challenge returns so the relay
// can check that this installation really serves its public address.
func (m *Mailer) Challenge(ctx context.Context) (string, string, bool) {
	if m.relayUsable() != "" {
		return "", "", false
	}
	state, err := m.loadState(ctx)
	if err != nil || state.InstallationID == "" || state.Challenge == "" {
		return "", "", false
	}
	return state.InstallationID, state.Challenge, true
}

// Run registers with the relay, keeps the registration verified and
// retries queued letters until ctx ends.
func (m *Mailer) Run(ctx context.Context) {
	ticker := time.NewTicker(15 * time.Second)
	defer ticker.Stop()
	// Give the HTTP server a moment to serve the challenge endpoint.
	first := time.NewTimer(3 * time.Second)
	defer first.Stop()
	select {
	case <-ctx.Done():
		return
	case <-first.C:
	}
	for {
		if m.relayUsable() == "" {
			if err := m.ensureRegistration(ctx); err != nil && ctx.Err() == nil {
				m.logger.Warn("coma mail registration", "error", err)
			}
		}
		if err := m.processOutbox(ctx); err != nil && ctx.Err() == nil {
			m.logger.Warn("coma mail outbox", "error", err)
		}
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		case <-m.wake:
		}
	}
}

// ensureRegistration moves the installation towards an active key. One core
// replica at a time does it, under a session advisory lock.
func (m *Mailer) ensureRegistration(ctx context.Context) error {
	connection, err := m.pool.Acquire(ctx)
	if err != nil {
		return err
	}
	defer connection.Release()
	var locked bool
	if err := connection.QueryRow(ctx, `SELECT pg_try_advisory_lock(hashtextextended('coma-mail-relay-registration',0))`).Scan(&locked); err != nil || !locked {
		return err
	}
	defer func() {
		_, _ = connection.Exec(context.WithoutCancel(ctx), `SELECT pg_advisory_unlock(hashtextextended('coma-mail-relay-registration',0))`)
	}()
	state, err := m.loadState(ctx)
	if errors.Is(err, pgx.ErrNoRows) {
		if _, err := m.pool.Exec(ctx, `INSERT INTO mail_relay_state(relay_url,app_url) VALUES($1,$2)
			ON CONFLICT (singleton) DO UPDATE SET relay_url=EXCLUDED.relay_url,app_url=EXCLUDED.app_url,installation_id='',key_sealed=NULL,challenge='',status='registering',last_error='',next_attempt_at=now(),attempts=0,updated_at=now()`, m.relayURL, m.appURL); err != nil {
			return err
		}
		m.forgetState()
		state, err = m.loadState(ctx)
	}
	if err != nil {
		return err
	}
	if m.now().Before(state.NextAttemptAt) {
		return nil
	}
	switch state.Status {
	case "active":
		return nil
	case "revoked":
		// A suspension lifts after three days and the operator may restore
		// the installation; look again every hour.
		m.forgetQuota()
		if quota := m.fetchQuota(ctx, state); quota != nil && quota.Status == "active" {
			m.setStatus(ctx, "active", "")
			return nil
		}
		_, err := m.pool.Exec(ctx, `UPDATE mail_relay_state SET next_attempt_at=now()+interval '1 hour',updated_at=now()`)
		return err
	}
	if len(state.KeySealed) == 0 {
		created, err := m.register(ctx)
		if err != nil {
			return m.failRegistration(ctx, state, err)
		}
		sealed, err := m.ws.Seal("relay-key", []byte(created.Key))
		if err != nil {
			return err
		}
		if _, err := m.pool.Exec(ctx, `UPDATE mail_relay_state SET installation_id=$1,key_sealed=$2,challenge=$3,status='registering',last_error='',updated_at=now()`, created.InstallationID, sealed, created.Challenge); err != nil {
			return err
		}
		state.KeySealed = sealed
	}
	key, err := m.ws.Open("relay-key", state.KeySealed)
	if err != nil {
		m.resetRegistration(ctx, "key_unreadable")
		return err
	}
	status, code, err := m.relayPost(ctx, "/v1/installations/verify", string(key), nil)
	switch {
	case err != nil:
		return m.failRegistration(ctx, state, err)
	case status == http.StatusOK:
		_, err := m.pool.Exec(ctx, `UPDATE mail_relay_state SET status='active',last_error='',attempts=0,updated_at=now()`)
		m.forgetState()
		m.logger.Info("coma mail is active")
		return err
	case status == http.StatusUnauthorized:
		m.resetRegistration(ctx, "invalid_key")
		return nil
	case code == "installation_revoked":
		m.setStatus(ctx, "revoked", code)
		return nil
	case code == "installation_replaced":
		m.resetRegistration(ctx, code)
		return nil
	default:
		if code == "" {
			code = http.StatusText(status)
		}
		return m.failRegistration(ctx, state, errors.New(code))
	}
}

func (m *Mailer) failRegistration(ctx context.Context, state relayState, cause error) error {
	delay := time.Minute << min(state.Attempts, 6)
	_, err := m.pool.Exec(ctx, `UPDATE mail_relay_state SET status='error',last_error=$1,attempts=attempts+1,next_attempt_at=now()+make_interval(secs=>$2),updated_at=now()`, truncate(cause.Error()), delay.Seconds())
	m.forgetState()
	return errors.Join(cause, err)
}

type registration struct {
	InstallationID string `json:"installation_id"`
	Key            string `json:"key"`
	Challenge      string `json:"challenge"`
}

func (m *Mailer) register(ctx context.Context) (registration, error) {
	var created registration
	status, code, err := m.relayPost(ctx, "/v1/installations", "", map[string]string{"app_url": m.appURL}, &created)
	if err != nil {
		return registration{}, err
	}
	if status != http.StatusCreated || created.Key == "" {
		if code == "" {
			code = http.StatusText(status)
		}
		return registration{}, errors.New(code)
	}
	return created, nil
}

func (m *Mailer) relayPost(ctx context.Context, path, key string, body any, into ...any) (int, string, error) {
	var reader io.Reader = http.NoBody
	if body != nil {
		encoded, err := json.Marshal(body)
		if err != nil {
			return 0, "", err
		}
		reader = bytes.NewReader(encoded)
	}
	postCtx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	request, err := http.NewRequestWithContext(postCtx, http.MethodPost, m.relayURL+path, reader)
	if err != nil {
		return 0, "", err
	}
	request.Header.Set("Content-Type", "application/json")
	if key != "" {
		request.Header.Set("Authorization", "Bearer "+key)
	}
	response, err := m.client.Do(request)
	if err != nil {
		return 0, "", errors.New("relay unreachable")
	}
	defer response.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(response.Body, 16<<10))
	var failure relayError
	_ = json.Unmarshal(raw, &failure)
	if len(into) > 0 && response.StatusCode < 300 {
		if err := json.Unmarshal(raw, into[0]); err != nil {
			return response.StatusCode, "", errors.New("malformed relay response")
		}
	}
	return response.StatusCode, failure.Error, nil
}

// queuedLetter is a sealed outbox payload.
type queuedLetter struct {
	Message mailtemplate.Message `json:"message"`
}

// letterLifetime is how long a queued letter is worth delivering: no longer
// than its link lives.
func letterLifetime(message mailtemplate.Message, now time.Time) time.Time {
	switch message.Kind {
	case mailtemplate.Invitation:
		if message.Data.ExpiresAt != nil && message.Data.ExpiresAt.Before(now.Add(24*time.Hour)) {
			return *message.Data.ExpiresAt
		}
		return now.Add(24 * time.Hour)
	case mailtemplate.Digest:
		return now.Add(6 * time.Hour)
	default:
		return now.Add(time.Hour)
	}
}

func (m *Mailer) enqueue(ctx context.Context, orgID, id string, message mailtemplate.Message, cause *temporaryError) error {
	plain, err := json.Marshal(queuedLetter{Message: message})
	if err != nil {
		return err
	}
	sealed, err := m.ws.Seal("outbox:"+id, plain)
	if err != nil {
		return err
	}
	now := m.now()
	delay := max(cause.retryAfter, 30*time.Second)
	_, err = m.pool.Exec(ctx, `INSERT INTO mail_outbox(id,org_id,kind,payload,available_at,expires_at,last_error) VALUES($1,$2,$3,$4,$5,$6,$7)`,
		id, orgID, string(message.Kind), sealed, now.Add(delay), letterLifetime(message, now), cause.reason)
	return err
}

// processOutbox retries due letters with the same idempotency key.
func (m *Mailer) processOutbox(ctx context.Context) error {
	if _, err := m.pool.Exec(ctx, `DELETE FROM mail_outbox WHERE expires_at<now()`); err != nil {
		return err
	}
	rows, err := m.pool.Query(ctx, `UPDATE mail_outbox SET lease_until=now()+interval '1 minute'
		WHERE id IN (SELECT id FROM mail_outbox WHERE available_at<=now() AND (lease_until IS NULL OR lease_until<now()) ORDER BY available_at LIMIT 20 FOR UPDATE SKIP LOCKED)
		RETURNING id::text,org_id::text,payload,attempts`)
	if err != nil {
		return err
	}
	type due struct {
		id, orgID string
		payload   []byte
		attempts  int
	}
	items := []due{}
	for rows.Next() {
		var item due
		if err := rows.Scan(&item.id, &item.orgID, &item.payload, &item.attempts); err != nil {
			rows.Close()
			return err
		}
		items = append(items, item)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}
	for _, item := range items {
		plain, err := m.ws.Open("outbox:"+item.id, item.payload)
		var letter queuedLetter
		if err == nil {
			err = json.Unmarshal(plain, &letter)
		}
		if err != nil {
			_, _ = m.pool.Exec(ctx, `DELETE FROM mail_outbox WHERE id=$1`, item.id)
			continue
		}
		err = m.retry(ctx, item.orgID, item.id, letter.Message)
		var temporary *temporaryError
		if errors.As(err, &temporary) {
			delay := max(temporary.retryAfter, min(time.Minute<<min(item.attempts, 5), 30*time.Minute))
			_, _ = m.pool.Exec(ctx, `UPDATE mail_outbox SET attempts=attempts+1,available_at=now()+make_interval(secs=>$2),lease_until=NULL,last_error=$3 WHERE id=$1`, item.id, delay.Seconds(), temporary.reason)
			continue
		}
		if err != nil {
			m.logger.Warn("coma mail letter dropped", "kind", letter.Message.Kind, "error", err)
		}
		_, _ = m.pool.Exec(ctx, `DELETE FROM mail_outbox WHERE id=$1`, item.id)
	}
	return nil
}

// retry sends a queued letter through the workspace's current transport:
// an administrator who switched to SMTP meanwhile gets it via SMTP.
func (m *Mailer) retry(ctx context.Context, orgID, id string, message mailtemplate.Message) error {
	delivery, err := m.DigestThroughComa(ctx, orgID)
	if err != nil {
		return &temporaryError{reason: "settings"}
	}
	if !delivery {
		return m.send(ctx, orgID, message, "", "", false)
	}
	return m.relaySend(ctx, id, message)
}
