package mailrelay

import (
	"bytes"
	"context"
	"errors"
	"time"

	"github.com/comamessenger/comamessenger/core/internal/mailtemplate"
	"github.com/jackc/pgx/v5"
)

// Limits are the free tier of ADR-0013. Windows are a rolling 24 hours.
type Limits struct {
	PerRecipient         int
	PerRecipientKind     map[mailtemplate.Kind]int
	PerRecipientGlobal   int
	InstallationNew      int
	InstallationDefault  int
	NewRecipientsNew     int
	NewRecipientsDefault int
	NewPeriod            time.Duration
	// Platform limits apply to hosts under a private public suffix
	// (pages.dev, github.io, onrender.com…), where anyone gets a fresh site
	// for free. They never graduate to the default tier.
	PlatformDaily         int
	PlatformNewRecipients int
}

func DefaultLimits() Limits {
	return Limits{
		PerRecipient: 6,
		PerRecipientKind: map[mailtemplate.Kind]int{
			mailtemplate.Invitation: 2, mailtemplate.PasswordReset: 3, mailtemplate.EmailConfirmation: 3,
			mailtemplate.EmailChangeNotice: 3, mailtemplate.Digest: 2,
		},
		PerRecipientGlobal:    10,
		InstallationNew:       100,
		InstallationDefault:   500,
		NewRecipientsNew:      50,
		NewRecipientsDefault:  300,
		NewPeriod:             14 * 24 * time.Hour,
		PlatformDaily:         30,
		PlatformNewRecipients: 10,
	}
}

// DailyLimit is the installation's cap: an operator override or the tier.
// The age is the site's (SiteActivatedAt), copied into ActivatedAt by the
// caller.
func (l Limits) DailyLimit(installation Installation, now time.Time) int {
	if installation.DailyLimit != nil {
		return *installation.DailyLimit
	}
	if mailtemplate.OnPlatform(installation.AppHost) {
		return l.PlatformDaily
	}
	if l.isNew(installation, now) {
		return l.InstallationNew
	}
	return l.InstallationDefault
}

func (l Limits) isNew(installation Installation, now time.Time) bool {
	return installation.ActivatedAt == nil || now.Sub(*installation.ActivatedAt) < l.NewPeriod
}

func (l Limits) newRecipientLimit(installation Installation, now time.Time) int {
	if mailtemplate.OnPlatform(installation.AppHost) {
		return l.PlatformNewRecipients
	}
	if l.isNew(installation, now) {
		return l.NewRecipientsNew
	}
	return l.NewRecipientsDefault
}

var (
	errRecipientLimit    = errors.New("recipient_limit")
	errInstallationLimit = errors.New("installation_limit")
	errSuppressed        = errors.New("recipient_suppressed")
	errConflict          = errors.New("idempotency_conflict")
	errInProgress        = errors.New("request_in_progress")
)

// reservation is the outcome of Reserve.
type reservation struct {
	ID         string
	ProviderID string
	Replayed   bool
}

// counted statuses spend the limit; failed letters do not.
const counted = `status IN ('reserved','sent','suppressed','bounced','complained')`

// Reserve checks suppression and every limit and records the letter as
// reserved, all under one per-host lock so parallel requests cannot pass the
// limit together. A repeated idempotency key returns the earlier result.
func (s *Store) Reserve(ctx context.Context, limits Limits, installation Installation, kind mailtemplate.Kind, recipientHash []byte, idempotencyKey string, payloadHash []byte, sendID string, now time.Time) (reservation, error) {
	var result reservation
	err := pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended('mail-site:'||$1, 0))`, installation.AppSite); err != nil {
			return err
		}
		// Recipient-wide checks span installations; serialise them too.
		if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended('mail-recipient:'||encode($1,'hex'), 0))`, recipientHash); err != nil {
			return err
		}
		var existingID, status string
		var existingPayload []byte
		var providerID *string
		err := tx.QueryRow(ctx, `SELECT id::text,status,payload_hash,provider_id FROM mail_sends WHERE installation_id=$1 AND idempotency_key=$2`, installation.ID, idempotencyKey).Scan(&existingID, &status, &existingPayload, &providerID)
		switch {
		case err == nil:
			if !bytes.Equal(existingPayload, payloadHash) {
				return errConflict
			}
			switch status {
			case "reserved":
				return errInProgress
			case "failed":
				if _, err := tx.Exec(ctx, `DELETE FROM mail_sends WHERE id=$1`, existingID); err != nil {
					return err
				}
			case "suppressed":
				return errSuppressed
			default:
				result = reservation{ID: existingID, Replayed: true}
				if providerID != nil {
					result.ProviderID = *providerID
				}
				return nil
			}
		case !errors.Is(err, pgx.ErrNoRows):
			return err
		}
		var suppressed bool
		if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM mail_suppressions WHERE recipient_hash=$1)`, recipientHash).Scan(&suppressed); err != nil {
			return err
		}
		if suppressed {
			return errSuppressed
		}
		since := now.Add(-24 * time.Hour)
		var perRecipient, perKind, global, hostTotal, newRecipients int
		var known bool
		if err := tx.QueryRow(ctx, `SELECT
			count(*) FILTER (WHERE app_site=$1),
			count(*) FILTER (WHERE app_site=$1 AND kind=$3),
			count(*)
			FROM mail_sends WHERE recipient_hash=$2 AND created_at>$4 AND `+counted, installation.AppSite, recipientHash, string(kind), since).Scan(&perRecipient, &perKind, &global); err != nil {
			return err
		}
		if perRecipient >= limits.PerRecipient || perKind >= limits.PerRecipientKind[kind] {
			return errRecipientLimit
		}
		if global >= limits.PerRecipientGlobal {
			return errRecipientLimit
		}
		if err := tx.QueryRow(ctx, `SELECT
			count(*) FILTER (WHERE `+counted+`),
			count(*) FILTER (WHERE new_recipient AND `+counted+`)
			FROM mail_sends WHERE app_site=$1 AND created_at>$2`, installation.AppSite, since).Scan(&hostTotal, &newRecipients); err != nil {
			return err
		}
		if hostTotal >= limits.DailyLimit(installation, now) {
			return errInstallationLimit
		}
		if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM mail_sends WHERE app_site=$1 AND recipient_hash=$2 AND status IN ('sent','bounced','complained'))`, installation.AppSite, recipientHash).Scan(&known); err != nil {
			return err
		}
		// Any letter to an address the site never reached counts as new,
		// whatever its type: a password reset phishes as well as an invite.
		fresh := !known
		if fresh && newRecipients >= limits.newRecipientLimit(installation, now) {
			return errInstallationLimit
		}
		young := limits.isNew(installation, now)
		if _, err := tx.Exec(ctx, `INSERT INTO mail_sends(id,installation_id,app_site,kind,recipient_hash,new_recipient,new_installation,idempotency_key,payload_hash,status,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'reserved',$10)`,
			sendID, installation.ID, installation.AppSite, string(kind), recipientHash, fresh, young, idempotencyKey, payloadHash, now); err != nil {
			return err
		}
		result = reservation{ID: sendID}
		return nil
	})
	return result, err
}

// Complete records the provider's answer for a reserved letter.
func (s *Store) Complete(ctx context.Context, sendID, status, providerID string) error {
	var provider any
	if providerID != "" {
		provider = providerID
	}
	_, err := s.pool.Exec(ctx, `UPDATE mail_sends SET status=$2,provider_id=$3 WHERE id=$1`, sendID, status, provider)
	return err
}

func (s *Store) Suppress(ctx context.Context, recipientHash []byte, reason string) error {
	_, err := s.pool.Exec(ctx, `INSERT INTO mail_suppressions(recipient_hash,reason) VALUES($1,$2) ON CONFLICT (recipient_hash) DO UPDATE SET reason=EXCLUDED.reason`, recipientHash, reason)
	return err
}

// Usage is the site's spend in the current window.
func (s *Store) Usage(ctx context.Context, site string, now time.Time) (int, error) {
	var used int
	err := s.pool.QueryRow(ctx, `SELECT count(*) FROM mail_sends WHERE app_site=$1 AND created_at>$2 AND `+counted, site, now.Add(-24*time.Hour)).Scan(&used)
	return used, err
}

// ApplyEvent records a provider event once, in one transaction with its
// effects: the recipient is suppressed and, with status, the letter marked.
// It returns the site of the letter and whether the event was new and ours.
func (s *Store) ApplyEvent(ctx context.Context, eventID, providerID, status, reason string) (string, bool, error) {
	var site string
	applied := false
	err := pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		var sendID string
		var recipientHash []byte
		err := tx.QueryRow(ctx, `SELECT id::text,app_site,recipient_hash FROM mail_sends WHERE provider_id=$1`, providerID).Scan(&sendID, &site, &recipientHash)
		if errors.Is(err, pgx.ErrNoRows) {
			// Another sender on the same RuSender account; not ours to judge.
			return nil
		}
		if err != nil {
			return err
		}
		command, err := tx.Exec(ctx, `INSERT INTO mail_webhook_events(event_id) VALUES($1) ON CONFLICT DO NOTHING`, eventID)
		if err != nil || command.RowsAffected() == 0 {
			return err
		}
		if _, err := tx.Exec(ctx, `INSERT INTO mail_suppressions(recipient_hash,reason) VALUES($1,$2) ON CONFLICT (recipient_hash) DO UPDATE SET reason=EXCLUDED.reason`, recipientHash, reason); err != nil {
			return err
		}
		if status != "" {
			if _, err := tx.Exec(ctx, `UPDATE mail_sends SET status=$2 WHERE id=$1`, sendID, status); err != nil {
				return err
			}
		}
		applied = true
		return nil
	})
	return site, applied, err
}

// Reputation is a site's last seven days; complainers counts distinct
// recipients who complained.
func (s *Store) Reputation(ctx context.Context, site string) (sent, bounced, complained, complainers int, err error) {
	err = s.pool.QueryRow(ctx, `SELECT
		count(*) FILTER (WHERE status IN ('sent','bounced','complained')),
		count(*) FILTER (WHERE status='bounced'),
		count(*) FILTER (WHERE status='complained'),
		count(DISTINCT recipient_hash) FILTER (WHERE status='complained')
		FROM mail_sends WHERE app_site=$1 AND created_at>now()-interval '7 days'`, site).Scan(&sent, &bounced, &complained, &complainers)
	return
}
