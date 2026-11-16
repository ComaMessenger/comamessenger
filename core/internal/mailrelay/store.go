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
	app_site text NOT NULL,
	challenge text NOT NULL,
	status text NOT NULL CHECK (status IN ('pending', 'active', 'suspended', 'revoked')),
	status_reason text NOT NULL DEFAULT '',
	suspended_until timestamptz,
	daily_limit integer CHECK (daily_limit IS NULL OR daily_limit BETWEEN 0 AND 100000),
	registered_ip text NOT NULL DEFAULT '',
	created_at timestamptz NOT NULL DEFAULT now(),
	activated_at timestamptz,
	updated_at timestamptz NOT NULL DEFAULT now(),
	last_seen_at timestamptz
);
CREATE INDEX IF NOT EXISTS mail_installations_site ON mail_installations(app_site, status);
CREATE INDEX IF NOT EXISTS mail_installations_url ON mail_installations(app_url, status);

CREATE TABLE IF NOT EXISTS mail_sends (
	id uuid PRIMARY KEY,
	installation_id uuid NOT NULL REFERENCES mail_installations(id) ON DELETE CASCADE,
	app_site text NOT NULL,
	kind text NOT NULL,
	recipient_hash bytea NOT NULL,
	new_recipient boolean NOT NULL DEFAULT false,
	idempotency_key text NOT NULL,
	payload_hash bytea NOT NULL,
	provider_id text,
	status text NOT NULL CHECK (status IN ('reserved', 'sent', 'failed', 'suppressed', 'bounced', 'complained')),
	new_installation boolean NOT NULL DEFAULT false,
	created_at timestamptz NOT NULL DEFAULT now(),
	UNIQUE (installation_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS mail_sends_site_time ON mail_sends(app_site, created_at);
CREATE INDEX IF NOT EXISTS mail_sends_new_time ON mail_sends(created_at) WHERE new_installation;
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
	AppSite     string
	Challenge   string
	Status      string
	Reason      string
	DailyLimit  *int
	CreatedAt   time.Time
	ActivatedAt *time.Time
}

const installationColumns = `id::text,app_url,app_host,app_site,challenge,status,status_reason,daily_limit,created_at,activated_at`

func scanInstallation(row pgx.Row) (Installation, error) {
	var value Installation
	err := row.Scan(&value.ID, &value.AppURL, &value.AppHost, &value.AppSite, &value.Challenge, &value.Status, &value.Reason, &value.DailyLimit, &value.CreatedAt, &value.ActivatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return Installation{}, ErrNotFound
	}
	return value, err
}

func (s *Store) CreateInstallation(ctx context.Context, id string, keyHash []byte, appURL, appHost, appSite, challenge, ip string) error {
	_, err := s.pool.Exec(ctx, `INSERT INTO mail_installations(id,key_hash,app_url,app_host,app_site,challenge,status,registered_ip) VALUES($1,$2,$3,$4,$5,$6,'pending',$7)`, id, keyHash, appURL, appHost, appSite, challenge, ip)
	return err
}

// SiteBlocked reports whether an operator revoked the site or the complaint
// guard suspended it; a new registration must not lift either.
func (s *Store) SiteBlocked(ctx context.Context, site string) (bool, error) {
	var blocked bool
	err := s.pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM mail_installations WHERE app_site=$1 AND (
		(status='revoked' AND status_reason<>'replaced') OR (status='suspended' AND (suspended_until IS NULL OR suspended_until>now()))))`, site).Scan(&blocked)
	return blocked, err
}

// PendingFor counts recent unverified registrations of one address from one
// client.
func (s *Store) PendingFor(ctx context.Context, appURL, ip string) (int, error) {
	var count int
	err := s.pool.QueryRow(ctx, `SELECT count(*) FROM mail_installations WHERE app_url=$1 AND registered_ip=$2 AND status='pending' AND created_at>now()-interval '1 day'`, appURL, ip).Scan(&count)
	return count, err
}

// InstallationByKey resolves a key; an expired automatic suspension lifts
// here.
func (s *Store) InstallationByKey(ctx context.Context, keyHash []byte) (Installation, error) {
	return scanInstallation(s.pool.QueryRow(ctx, `UPDATE mail_installations SET last_seen_at=now(),
		status=CASE WHEN status='suspended' AND activated_at IS NOT NULL AND suspended_until IS NOT NULL AND suspended_until<=now() THEN 'active' ELSE status END,
		status_reason=CASE WHEN status='suspended' AND activated_at IS NOT NULL AND suspended_until IS NOT NULL AND suspended_until<=now() THEN '' ELSE status_reason END
		WHERE key_hash=$1 RETURNING `+installationColumns, keyHash))
}

func (s *Store) Installation(ctx context.Context, id string) (Installation, error) {
	return scanInstallation(s.pool.QueryRow(ctx, `SELECT `+installationColumns+` FROM mail_installations WHERE id::text=$1`, id))
}

// Activate marks the installation verified and retires older keys of the
// same address: a reinstalled server replaces its previous registration.
// Another path on the same host is another installation and replaces
// nothing.
func (s *Store) Activate(ctx context.Context, id, appURL, site string) error {
	return pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended('mail-site:'||$1, 0))`, site); err != nil {
			return err
		}
		command, err := tx.Exec(ctx, `UPDATE mail_installations SET status='active',activated_at=now(),updated_at=now() WHERE id=$1 AND status='pending'`, id)
		if err != nil {
			return err
		}
		if command.RowsAffected() == 0 {
			return ErrNotFound
		}
		if _, err := tx.Exec(ctx, `DELETE FROM mail_installations WHERE app_url=$1 AND id<>$2 AND status='pending'`, appURL, id); err != nil {
			return err
		}
		_, err = tx.Exec(ctx, `UPDATE mail_installations SET status='revoked',status_reason='replaced',updated_at=now() WHERE app_url=$1 AND id<>$2 AND status='active'`, appURL, id)
		return err
	})
}

func (s *Store) SetStatus(ctx context.Context, id, status, reason string) error {
	command, err := s.pool.Exec(ctx, `UPDATE mail_installations SET status=$2,status_reason=$3,suspended_until=NULL,updated_at=now() WHERE id::text=$1`, id, status, reason)
	if err == nil && command.RowsAffected() == 0 {
		return ErrNotFound
	}
	return err
}

// SuspendSite stops every verified installation of a site until the given
// time. Unverified registrations stay pending: lifting a suspension must
// never activate a key whose address was not checked.
func (s *Store) SuspendSite(ctx context.Context, site, reason string, until time.Time) error {
	_, err := s.pool.Exec(ctx, `UPDATE mail_installations SET status='suspended',status_reason=$2,suspended_until=$3,updated_at=now() WHERE app_site=$1 AND status IN ('active','suspended') AND activated_at IS NOT NULL`, site, reason, until)
	return err
}

// SiteActivatedAt is when the site's first installation was verified; a
// reinstalled server keeps the age of its site.
func (s *Store) SiteActivatedAt(ctx context.Context, site string) (*time.Time, error) {
	var first *time.Time
	err := s.pool.QueryRow(ctx, `SELECT min(activated_at) FROM mail_installations WHERE app_site=$1`, site).Scan(&first)
	return first, err
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
		if err := rows.Scan(&item.ID, &item.AppURL, &item.AppHost, &item.AppSite, &item.Challenge, &item.Status, &item.Reason, &item.DailyLimit, &item.CreatedAt, &item.ActivatedAt, &item.LastSeenAt, &item.RegisteredIP, &item.Sent24h, &item.Complaints7d, &item.Bounces7d); err != nil {
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

// Revoke stops every live installation of the site of id: the operator
// judges the site, not one key of it.
func (s *Store) Revoke(ctx context.Context, id, reason string) error {
	command, err := s.pool.Exec(ctx, `UPDATE mail_installations SET status='revoked',status_reason=$2,suspended_until=NULL,updated_at=now()
		WHERE app_site=(SELECT app_site FROM mail_installations WHERE id::text=$1) AND (id::text=$1 OR status IN ('active','pending','suspended'))`, id, reason)
	if err == nil && command.RowsAffected() == 0 {
		return ErrNotFound
	}
	return err
}

// Restore re-enables id and lifts suspensions of its site.
func (s *Store) Restore(ctx context.Context, id string) error {
	return pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		var site string
		if err := tx.QueryRow(ctx, `UPDATE mail_installations SET status='active',status_reason='',suspended_until=NULL,updated_at=now() WHERE id::text=$1 AND activated_at IS NOT NULL RETURNING app_site`, id).Scan(&site); err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return ErrNotFound
			}
			return err
		}
		_, err := tx.Exec(ctx, `UPDATE mail_installations SET status='active',status_reason='',suspended_until=NULL,updated_at=now() WHERE app_site=$1 AND status='suspended' AND activated_at IS NOT NULL`, site)
		return err
	})
}
