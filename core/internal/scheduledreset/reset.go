// Package scheduledreset ties a person's scheduled messages to the security
// state of their account. It depends only on pgx so the identity and
// workspace packages can call it inside their own transactions.
//
// Two marks decide whether a scheduled message may still be sent:
//
//   - users.security_epoch, bumped by BumpEpochTx in the same transaction
//     as every account-wide security event. A scheduled message carries the
//     epoch it was authorized under; delivery refuses any other value.
//   - revoked_session_families, written by RevokeFamilyTx when one device is
//     revoked for security reasons. Delivery refuses messages that device
//     scheduled or last changed.
//
// Both writes happen in the security event's own transaction, so once it
// commits no message authorized before it can go out. Reconcile then marks
// the stopped messages failed and tells the author; it may run later (a
// sweep repeats it) because the marks alone already block delivery.
//
// Lock order shared by everyone: organizations, scheduled_messages, actors,
// users, sessions. Security events take only the last three. The
// organization row is locked FOR NO KEY UPDATE, which the foreign key
// checks of their audit inserts (FOR KEY SHARE) do not wait for, so they
// cannot invert the order of delivery.
package scheduledreset

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sync/atomic"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

const (
	// ReasonSecurityReset: password changed or reset, e-mail changed, every
	// other device signed out, or an administrator required a new password.
	ReasonSecurityReset = "security_reset"
	// ReasonAuthorInactive: the account was deactivated.
	ReasonAuthorInactive = "author_inactive"
	// ReasonSessionRevoked: the device that scheduled or last changed the
	// message was removed from the session list, or its refresh token was
	// reused.
	ReasonSessionRevoked = "session_revoked"

	// EventFailed is the realtime event of a message that was not sent.
	EventFailed = "scheduled_message.failed"

	FamilyDeviceRevoked = "device_revoked"
	FamilyRefreshReuse  = "refresh_reuse"
)

// BumpEpochTx records an account-wide security event of the person.
func BumpEpochTx(ctx context.Context, tx pgx.Tx, orgID, actorID string) error {
	if _, err := tx.Exec(ctx, `UPDATE users SET security_epoch = security_epoch + 1 WHERE org_id=$1 AND actor_id=$2`, orgID, actorID); err != nil {
		return fmt.Errorf("bump security epoch: %w", err)
	}
	return nil
}

// RevokeFamilyTx records that one device of the person was revoked for
// security reasons.
func RevokeFamilyTx(ctx context.Context, tx pgx.Tx, orgID, actorID, familyID, reason string) error {
	if _, err := tx.Exec(ctx, `
		INSERT INTO revoked_session_families (family_id, org_id, actor_id, reason) VALUES ($1, $2, $3, $4)
		ON CONFLICT (family_id) DO NOTHING`, familyID, orgID, actorID, reason); err != nil {
		return fmt.Errorf("record revoked session family: %w", err)
	}
	return nil
}

// Event is the whole payload of a scheduled_message.* realtime event. It
// never carries the text, mentions or files: the event log keeps events
// for a long time and replays them to new devices.
type Event struct {
	ID            string    `json:"id"`
	ChatID        string    `json:"chat_id"`
	Status        string    `json:"status"`
	Version       int       `json:"version"`
	SendAt        time.Time `json:"send_at"`
	FailureReason *string   `json:"failure_reason"`
}

// InsertEventTx records an event for the author's devices only. chat_id
// stays empty on purpose: delivery must not depend on chat membership, so an
// author who left still learns that the message failed. The caller holds
// the organization row lock. A failure event also queues a push to the
// author.
func InsertEventTx(ctx context.Context, tx pgx.Tx, orgID, authorID, eventType string, event Event) (int64, error) {
	payload, err := json.Marshal(event)
	if err != nil {
		return 0, fmt.Errorf("marshal scheduled message event: %w", err)
	}
	var seq int64
	if err := tx.QueryRow(ctx, `UPDATE organizations SET event_seq = event_seq + 1 WHERE id = $1 RETURNING event_seq`, orgID).Scan(&seq); err != nil {
		return 0, fmt.Errorf("allocate event sequence: %w", err)
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO events (org_id, seq, type, actor_id, chat_id, subject_id, audience_actor_id, data)
		VALUES ($1, $2, $3, $4, NULL, $5, $4, $6::jsonb)`, orgID, seq, eventType, authorID, event.ID, string(payload)); err != nil {
		return 0, fmt.Errorf("insert scheduled message event: %w", err)
	}
	// A failure also notifies the author's devices by push, queued in the
	// same transaction as the failure itself so it cannot be lost or sent
	// for a failure that rolled back. The push worker sends it only to the
	// author and only while the record is still this failure (see package
	// push); it carries the reason, never the text or the chat.
	if eventType == EventFailed {
		if _, err := tx.Exec(ctx, `INSERT INTO notification_jobs (org_id, event_seq) VALUES ($1, $2) ON CONFLICT DO NOTHING`, orgID, seq); err != nil {
			return 0, fmt.Errorf("queue scheduled message failure push: %w", err)
		}
	}
	return seq, nil
}

// stoppedCondition selects pending messages of author that may no longer be
// sent, and stoppedReason names why, most serious first.
const stoppedCondition = `(author.inactive OR NOT author.password_ok OR sm.security_epoch <> author.security_epoch
	OR EXISTS (SELECT 1 FROM revoked_session_families rsf WHERE rsf.family_id = sm.session_family_id))`

const stoppedReason = `CASE WHEN author.inactive THEN 'author_inactive'
	WHEN NOT author.password_ok OR sm.security_epoch <> author.security_epoch THEN 'security_reset'
	ELSE 'session_revoked' END`

// Reconcile marks the author's stopped pending messages failed, keeping
// their text so the author can send them again, and tells the author's
// devices. It returns the last event sequence, or 0 if nothing changed.
func Reconcile(ctx context.Context, pool *pgxpool.Pool, orgID, actorID string) (int64, error) {
	tx, err := pool.Begin(ctx)
	if err != nil {
		return 0, fmt.Errorf("begin scheduled message reconcile: %w", err)
	}
	defer tx.Rollback(ctx)
	var seq int64
	if err := tx.QueryRow(ctx, `SELECT event_seq FROM organizations WHERE id=$1 FOR NO KEY UPDATE`, orgID).Scan(&seq); errors.Is(err, pgx.ErrNoRows) {
		return 0, nil
	} else if err != nil {
		return 0, fmt.Errorf("lock organization: %w", err)
	}
	rows, err := tx.Query(ctx, `
		WITH author AS (
			SELECT (a.status <> 'active' OR a.deleted_at IS NOT NULL) AS inactive,
			       u.must_change_password_at IS NULL AS password_ok, u.security_epoch
			FROM actors a JOIN users u ON u.org_id = a.org_id AND u.actor_id = a.id
			WHERE a.org_id = $1 AND a.id = $2
		)
		UPDATE scheduled_messages sm
		SET status = 'failed', failure_reason = `+stoppedReason+`, failed_at = now(), version = version + 1, updated_at = now()
		FROM author
		WHERE sm.org_id = $1 AND sm.author_id = $2 AND sm.status = 'pending' AND `+stoppedCondition+`
		RETURNING sm.id, sm.chat_id, sm.status, sm.version, sm.send_at, sm.failure_reason`, orgID, actorID)
	if err != nil {
		return 0, fmt.Errorf("fail stopped scheduled messages: %w", err)
	}
	var events []Event
	for rows.Next() {
		var event Event
		if err := rows.Scan(&event.ID, &event.ChatID, &event.Status, &event.Version, &event.SendAt, &event.FailureReason); err != nil {
			rows.Close()
			return 0, fmt.Errorf("scan stopped scheduled message: %w", err)
		}
		events = append(events, event)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return 0, fmt.Errorf("iterate stopped scheduled messages: %w", err)
	}
	seq = 0
	for _, event := range events {
		if seq, err = InsertEventTx(ctx, tx, orgID, actorID, EventFailed, event); err != nil {
			return 0, err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return 0, fmt.Errorf("commit scheduled message reconcile: %w", err)
	}
	return seq, nil
}

// Author identifies whose scheduled messages to reconcile.
type Author struct{ OrgID, ActorID string }

// Stopped lists authors who have stopped pending messages not yet marked
// failed: the sweep's work list.
func Stopped(ctx context.Context, pool *pgxpool.Pool, limit int) ([]Author, error) {
	rows, err := pool.Query(ctx, `
		SELECT DISTINCT sm.org_id, sm.author_id
		FROM scheduled_messages sm
		JOIN LATERAL (
			SELECT (a.status <> 'active' OR a.deleted_at IS NOT NULL) AS inactive,
			       u.must_change_password_at IS NULL AS password_ok, u.security_epoch
			FROM actors a JOIN users u ON u.org_id = a.org_id AND u.actor_id = a.id
			WHERE a.org_id = sm.org_id AND a.id = sm.author_id
		) author ON true
		WHERE sm.status = 'pending' AND `+stoppedCondition+`
		LIMIT $1`, limit)
	if err != nil {
		return nil, fmt.Errorf("find stopped scheduled messages: %w", err)
	}
	defer rows.Close()
	var result []Author
	for rows.Next() {
		var item Author
		if err := rows.Scan(&item.OrgID, &item.ActorID); err != nil {
			return nil, err
		}
		result = append(result, item)
	}
	return result, rows.Err()
}

var afterCommit atomic.Pointer[func(orgID string, highWatermark int64)]

// SetAfterCommit installs the realtime wake-up used once ReconcileAfter has
// committed failure events, so the author's devices hear at once instead of
// at the next poll. The server sets it at start-up, next to the services
// that write the security events.
func SetAfterCommit(callback func(orgID string, highWatermark int64)) {
	if callback == nil {
		afterCommit.Store(nil)
		return
	}
	afterCommit.Store(&callback)
}

// ReconcileAfter runs Reconcile once a security event has committed and
// wakes realtime delivery. Its failure is not the event's failure: delivery
// already refuses the stopped messages and the periodic sweep marks them.
func ReconcileAfter(ctx context.Context, pool *pgxpool.Pool, orgID, actorID string) {
	seq, err := Reconcile(context.WithoutCancel(ctx), pool, orgID, actorID)
	if err != nil || seq == 0 {
		return
	}
	if callback := afterCommit.Load(); callback != nil {
		(*callback)(orgID, seq)
	}
}
