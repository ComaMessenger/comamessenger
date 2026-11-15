package mailrelay

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

var ErrNotFound = errors.New("not found")

// Store owns the relay's own database. Recipients are stored only as an
// HMAC of the address; letter content is never stored.
type Store struct{ pool *pgxpool.Pool }

func NewStore(pool *pgxpool.Pool) *Store { return &Store{pool: pool} }

const schema = `
CREATE TABLE IF NOT EXISTS mail_installations (
	id uuid PRIMARY KEY,
	key_hash bytea NOT NULL UNIQUE,
	app_url text NOT NULL CHECK (length(app_url) BETWEEN 8 AND 512),
	app_host text NOT NULL,
	challenge text NOT NULL,
	status text NOT NULL CHECK (status IN ('pending', 'active', 'suspended', 'revoked')),
	status_reason text NOT NULL DEFAULT '',
	daily_limit integer CHECK (daily_limit IS NULL OR daily_limit BETWEEN 0 AND 100000),
	registered_ip text NOT NULL DEFAULT '',
	created_at timestamptz NOT NULL DEFAULT now(),
	activated_at timestamptz,
	updated_at timestamptz NOT NULL DEFAULT now(),
	last_seen_at timestamptz
);
CREATE INDEX IF NOT EXISTS mail_installations_host ON mail_installations(app_host, status);

CREATE TABLE IF NOT EXISTS mail_sends (
	id uuid PRIMARY KEY,
	installation_id uuid NOT NULL REFERENCES mail_installations(id) ON DELETE CASCADE,
	app_host text NOT NULL,
	kind text NOT NULL,
	recipient_hash bytea NOT NULL,
	new_recipient boolean NOT NULL DEFAULT false,
	idempotency_key text NOT NULL,
	payload_hash bytea NOT NULL,
	provider_id text,
	status text NOT NULL CHECK (status IN ('reserved', 'sent', 'failed', 'suppressed', 'bounced', 'complained')),
	created_at timestamptz NOT NULL DEFAULT now(),
	UNIQUE (installation_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS mail_sends_host_time ON mail_sends(app_host, created_at);
CREATE INDEX IF NOT EXISTS mail_sends_recipient_time ON mail_sends(recipient_hash, created_at);
CREATE INDEX IF NOT EXISTS mail_sends_provider ON mail_sends(provider_id) WHERE provider_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS mail_suppressions (
	recipient_hash bytea PRIMARY KEY,
	reason text NOT NULL,
	created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS mail_webhook_events (
	event_id text PRIMARY KEY,
	received_at timestamptz NOT NULL DEFAULT now()
);
`

// EnsureSchema creates the relay tables; the relay owns its database.
func (s *Store) EnsureSchema(ctx context.Context) error {
	_, err := s.pool.Exec(ctx, schema)
	return err
}

// Installation is one registered Coma installation.
type Installation struct {
	ID          string
	AppURL      string
	AppHost     string
	Challenge   string
	Status      string
	Reason      string
	DailyLimit  *int
	CreatedAt   time.Time
	ActivatedAt *time.Time
}

const installationColumns = `id::text,app_url,app_host,challenge,status,status_reason,daily_limit,created_at,activated_at`

func scanInstallation(row pgx.Row) (Installation, error) {
	var value Installation
	err := row.Scan(&value.ID, &value.AppURL, &value.AppHost, &value.Challenge, &value.Status, &value.Reason, &value.DailyLimit, &value.CreatedAt, &value.ActivatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return Installation{}, ErrNotFound
	}
	return value, err
}

func (s *Store) CreateInstallation(ctx context.Context, id string, keyHash []byte, appURL, appHost, challenge, ip string) error {
	_, err := s.pool.Exec(ctx, `INSERT INTO mail_installations(id,key_hash,app_url,app_host,challenge,status,registered_ip) VALUES($1,$2,$3,$4,$5,'pending',$6)`, id, keyHash, appURL, appHost, challenge, ip)
	return err
}

// HostBlocked reports whether an operator or the complaint guard stopped
// mail from this host; a new registration must not lift that.
func (s *Store) HostBlocked(ctx context.Context, host string) (bool, error) {
	var blocked bool
	err := s.pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM mail_installations WHERE app_host=$1 AND status IN ('suspended','revoked') AND status_reason<>'replaced')`, host).Scan(&blocked)
	return blocked, err
}

func (s *Store) PendingForHost(ctx context.Context, host string) (int, error) {
	var count int
	err := s.pool.QueryRow(ctx, `SELECT count(*) FROM mail_installations WHERE app_host=$1 AND status='pending' AND created_at>now()-interval '1 day'`, host).Scan(&count)
	return count, err
}

func (s *Store) InstallationByKey(ctx context.Context, keyHash []byte) (Installation, error) {
	return scanInstallation(s.pool.QueryRow(ctx, `UPDATE mail_installations SET last_seen_at=now() WHERE key_hash=$1 RETURNING `+installationColumns, keyHash))
}

func (s *Store) Installation(ctx context.Context, id string) (Installation, error) {
	return scanInstallation(s.pool.QueryRow(ctx, `SELECT `+installationColumns+` FROM mail_installations WHERE id::text=$1`, id))
}

// Activate marks the installation verified and retires older keys of the
// same host: a reinstalled server replaces its previous registration.
func (s *Store) Activate(ctx context.Context, id, host string) error {
	return pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended('mail-host:'||$1, 0))`, host); err != nil {
			return err
		}
		command, err := tx.Exec(ctx, `UPDATE mail_installations SET status='active',activated_at=now(),updated_at=now() WHERE id=$1 AND status='pending'`, id)
		if err != nil {
			return err
		}
		if command.RowsAffected() == 0 {
			return ErrNotFound
		}
		_, err = tx.Exec(ctx, `UPDATE mail_installations SET status='revoked',status_reason='replaced',updated_at=now() WHERE app_host=$1 AND id<>$2 AND status IN ('active','pending')`, host, id)
		return err
	})
}

func (s *Store) SetStatus(ctx context.Context, id, status, reason string) error {
	command, err := s.pool.Exec(ctx, `UPDATE mail_installations SET status=$2,status_reason=$3,updated_at=now() WHERE id::text=$1`, id, status, reason)
	if err == nil && command.RowsAffected() == 0 {
		return ErrNotFound
	}
	return err
}

// SuspendHost stops every live installation of a host.
func (s *Store) SuspendHost(ctx context.Context, host, reason string) error {
	_, err := s.pool.Exec(ctx, `UPDATE mail_installations SET status='suspended',status_reason=$2,updated_at=now() WHERE app_host=$1 AND status IN ('active','pending')`, host, reason)
	return err
}

func (s *Store) SetLimit(ctx context.Context, id string, limit *int) error {
	command, err := s.pool.Exec(ctx, `UPDATE mail_installations SET daily_limit=$2,updated_at=now() WHERE id::text=$1`, id, limit)
	if err == nil && command.RowsAffected() == 0 {
		return ErrNotFound
	}
	return err
}

// InstallationSummary is a row of the operator listing.
type InstallationSummary struct {
	Installation
	Sent24h      int
	Complaints7d int
	Bounces7d    int
	LastSeenAt   *time.Time
	RegisteredIP string
}

func (s *Store) ListInstallations(ctx context.Context) ([]InstallationSummary, error) {
	rows, err := s.pool.Query(ctx, `SELECT `+installationColumns+`,last_seen_at,registered_ip,
		(SELECT count(*) FROM mail_sends m WHERE m.installation_id=i.id AND m.created_at>now()-interval '24 hours' AND m.status<>'failed'),
		(SELECT count(*) FROM mail_sends m WHERE m.installation_id=i.id AND m.created_at>now()-interval '7 days' AND m.status='complained'),
		(SELECT count(*) FROM mail_sends m WHERE m.installation_id=i.id AND m.created_at>now()-interval '7 days' AND m.status='bounced')
		FROM mail_installations i ORDER BY created_at`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := []InstallationSummary{}
	for rows.Next() {
		var item InstallationSummary
		if err := rows.Scan(&item.ID, &item.AppURL, &item.AppHost, &item.Challenge, &item.Status, &item.Reason, &item.DailyLimit, &item.CreatedAt, &item.ActivatedAt, &item.LastSeenAt, &item.RegisteredIP, &item.Sent24h, &item.Complaints7d, &item.Bounces7d); err != nil {
			return nil, err
		}
		item.Challenge = ""
		result = append(result, item)
	}
	return result, rows.Err()
}

// Cleanup removes the send log after 30 days and stale registrations.
func (s *Store) Cleanup(ctx context.Context) error {
	_, err := s.pool.Exec(ctx, `
		DELETE FROM mail_sends WHERE created_at < now() - interval '30 days';
		DELETE FROM mail_webhook_events WHERE received_at < now() - interval '30 days';
		DELETE FROM mail_installations WHERE status='pending' AND created_at < now() - interval '7 days';
		UPDATE mail_sends SET status='failed' WHERE status='reserved' AND created_at < now() - interval '10 minutes';`)
	return err
}
