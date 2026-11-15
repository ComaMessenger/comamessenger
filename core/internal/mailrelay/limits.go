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
}

func DefaultLimits() Limits {
	return Limits{
		PerRecipient: 6,
		PerRecipientKind: map[mailtemplate.Kind]int{
			mailtemplate.Invitation: 2, mailtemplate.PasswordReset: 3, mailtemplate.EmailConfirmation: 3,
			mailtemplate.EmailChangeNotice: 3, mailtemplate.Digest: 2,
		},
		PerRecipientGlobal:   10,
		InstallationNew:      100,
		InstallationDefault:  500,
		NewRecipientsNew:     30,
		NewRecipientsDefault: 150,
		NewPeriod:            14 * 24 * time.Hour,
	}
}

// DailyLimit is the installation's cap: an operator override or the tier.
func (l Limits) DailyLimit(installation Installation, now time.Time) int {
	if installation.DailyLimit != nil {
		return *installation.DailyLimit
	}
	if installation.ActivatedAt == nil || now.Sub(*installation.ActivatedAt) < l.NewPeriod {
		return l.InstallationNew
	}
	return l.InstallationDefault
}

func (l Limits) newRecipientLimit(installation Installation, now time.Time) int {
	if installation.ActivatedAt == nil || now.Sub(*installation.ActivatedAt) < l.NewPeriod {
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
		if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended('mail-host:'||$1, 0))`, installation.AppHost); err != nil {
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
			count(*) FILTER (WHERE app_host=$1),
			count(*) FILTER (WHERE app_host=$1 AND kind=$3),
			count(*)
			FROM mail_sends WHERE recipient_hash=$2 AND created_at>$4 AND `+counted, installation.AppHost, recipientHash, string(kind), since).Scan(&perRecipient, &perKind, &global); err != nil {
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
			FROM mail_sends WHERE app_host=$1 AND created_at>$2`, installation.AppHost, since).Scan(&hostTotal, &newRecipients); err != nil {
			return err
		}
		if hostTotal >= limits.DailyLimit(installation, now) {
			return errInstallationLimit
		}
		if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM mail_sends WHERE app_host=$1 AND recipient_hash=$2 AND status IN ('sent','bounced','complained'))`, installation.AppHost, recipientHash).Scan(&known); err != nil {
			return err
		}
		fresh := kind == mailtemplate.Invitation && !known
		if fresh && newRecipients >= limits.newRecipientLimit(installation, now) {
			return errInstallationLimit
		}
		if _, err := tx.Exec(ctx, `INSERT INTO mail_sends(id,installation_id,app_host,kind,recipient_hash,new_recipient,idempotency_key,payload_hash,status,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'reserved',$9)`,
			sendID, installation.ID, installation.AppHost, string(kind), recipientHash, fresh, idempotencyKey, payloadHash, now); err != nil {
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

// Usage is the installation's spend in the current window.
func (s *Store) Usage(ctx context.Context, host string, now time.Time) (int, error) {
	var used int
	err := s.pool.QueryRow(ctx, `SELECT count(*) FROM mail_sends WHERE app_host=$1 AND created_at>$2 AND `+counted, host, now.Add(-24*time.Hour)).Scan(&used)
	return used, err
}

// webhookSend is the letter a provider event refers to.
type webhookSend struct {
	ID            string
	AppHost       string
	RecipientHash []byte
}

// FirstEvent stores an event id; false means it was already processed.
func (s *Store) FirstEvent(ctx context.Context, eventID string) (bool, error) {
	command, err := s.pool.Exec(ctx, `INSERT INTO mail_webhook_events(event_id) VALUES($1) ON CONFLICT DO NOTHING`, eventID)
	if err != nil {
		return false, err
	}
	return command.RowsAffected() == 1, nil
}

func (s *Store) SendByProviderID(ctx context.Context, providerID string) (webhookSend, error) {
	var value webhookSend
	err := s.pool.QueryRow(ctx, `SELECT id::text,app_host,recipient_hash FROM mail_sends WHERE provider_id=$1`, providerID).Scan(&value.ID, &value.AppHost, &value.RecipientHash)
	if errors.Is(err, pgx.ErrNoRows) {
		return webhookSend{}, ErrNotFound
	}
	return value, err
}

func (s *Store) MarkSend(ctx context.Context, sendID, status string) error {
	_, err := s.pool.Exec(ctx, `UPDATE mail_sends SET status=$2 WHERE id=$1`, sendID, status)
	return err
}

// Reputation is a host's last seven days.
func (s *Store) Reputation(ctx context.Context, host string) (sent, bounced, complained int, err error) {
	err = s.pool.QueryRow(ctx, `SELECT
		count(*) FILTER (WHERE status IN ('sent','bounced','complained')),
		count(*) FILTER (WHERE status='bounced'),
		count(*) FILTER (WHERE status='complained')
		FROM mail_sends WHERE app_host=$1 AND created_at>now()-interval '7 days'`, host).Scan(&sent, &bounced, &complained)
	return
}
