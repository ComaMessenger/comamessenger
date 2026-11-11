// Package scheduledreset stops a person's pending scheduled messages when a
// security event happens to their account. It depends only on pgx so the
// identity and workspace packages can call it inside their own transactions.
//
// Ordering: the caller locks the organization row with LockOrganization
// before taking any other lock. The scheduled message job locks the same row
// before it reads a record, so a job and a security event are serialized:
// either the message was sent before the event committed, or the job sees
// the record already failed and sends nothing.
package scheduledreset

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
)

const (
	// ReasonSecurityReset: the password was changed or reset, the e-mail
	// changed, or the person or an administrator signed out every device.
	ReasonSecurityReset = "security_reset"
	// ReasonAuthorInactive: the account was deactivated.
	ReasonAuthorInactive = "author_inactive"
)

// ErrOrganizationNotFound is returned when the organization row is missing.
var ErrOrganizationNotFound = errors.New("organization not found")

// LockOrganization takes the organization row lock that orders security
// events against scheduled message delivery.
func LockOrganization(ctx context.Context, tx pgx.Tx, orgID string) error {
	var seq int64
	err := tx.QueryRow(ctx, `SELECT event_seq FROM organizations WHERE id=$1 FOR UPDATE`, orgID).Scan(&seq)
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrOrganizationNotFound
	}
	if err != nil {
		return fmt.Errorf("lock organization for security event: %w", err)
	}
	return nil
}

// FailPendingTx marks every pending scheduled message of the actor failed
// with reason, keeping the text so the author can send it again, and tells
// the author's devices with a scheduled_message.failed event per record.
// The caller holds the organization lock. It returns the last event
// sequence, or 0 when nothing was pending.
func FailPendingTx(ctx context.Context, tx pgx.Tx, orgID, actorID, reason string) (int64, error) {
	rows, err := tx.Query(ctx, `
		WITH failed AS (
			UPDATE scheduled_messages
			SET status='failed', failure_reason=$3, failed_at=now(), version=version+1, updated_at=now()
			WHERE org_id=$1 AND author_id=$2 AND status='pending'
			RETURNING *
		)
		SELECT sm.id, jsonb_build_object(
			'id', sm.id, 'chat_id', sm.chat_id, 'thread_root_id', sm.thread_root_id, 'reply_to_id', sm.reply_to_id,
			'client_msg_id', sm.client_msg_id, 'body', sm.body, 'body_format', sm.body_format,
			'mentioned_actor_ids', to_jsonb(sm.mentioned_actor_ids),
			'files', COALESCE((
				SELECT jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
					'id', f.id, 'name', f.name, 'mime', f.mime, 'size', f.size,
					'sha256', CASE WHEN octet_length(f.sha256)=32 THEN encode(f.sha256, 'hex') END,
					'status', f.status, 'processing_status', f.processing_status, 'preview_file_id', f.preview_file_id,
					'created_at', f.created_at, 'ready_at', f.ready_at, 'uploader_id', f.uploader_id)) ORDER BY smf.ordinal)
				FROM scheduled_message_files smf JOIN files f ON f.org_id=smf.org_id AND f.id=smf.file_id
				WHERE smf.scheduled_message_id=sm.id AND f.status<>'deleted'), '[]'::jsonb),
			'silent', sm.silent, 'send_at', sm.send_at, 'status', sm.status, 'failure_reason', sm.failure_reason,
			'message_id', sm.message_id, 'version', sm.version, 'created_at', sm.created_at, 'updated_at', sm.updated_at,
			'sent_at', sm.sent_at, 'failed_at', sm.failed_at)
		FROM failed sm ORDER BY sm.send_at, sm.id`, orgID, actorID, reason)
	if err != nil {
		return 0, fmt.Errorf("fail pending scheduled messages: %w", err)
	}
	type failed struct {
		id   string
		data []byte
	}
	var items []failed
	for rows.Next() {
		var item failed
		if err := rows.Scan(&item.id, &item.data); err != nil {
			rows.Close()
			return 0, fmt.Errorf("scan failed scheduled message: %w", err)
		}
		items = append(items, item)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return 0, fmt.Errorf("iterate failed scheduled messages: %w", err)
	}
	var seq int64
	for _, item := range items {
		if err := tx.QueryRow(ctx, `UPDATE organizations SET event_seq=event_seq+1 WHERE id=$1 RETURNING event_seq`, orgID).Scan(&seq); err != nil {
			return 0, fmt.Errorf("allocate event sequence: %w", err)
		}
		if _, err := tx.Exec(ctx, `
			INSERT INTO events (org_id, seq, type, actor_id, chat_id, subject_id, audience_actor_id, data)
			VALUES ($1, $2, 'scheduled_message.failed', $3, NULL, $4, $3, $5::jsonb)`, orgID, seq, actorID, item.id, string(item.data)); err != nil {
			return 0, fmt.Errorf("insert scheduled message failure event: %w", err)
		}
	}
	return seq, nil
}

// StopPendingTx locks the organization and fails the actor's pending
// scheduled messages; for callers that have not taken the lock first.
func StopPendingTx(ctx context.Context, tx pgx.Tx, orgID, actorID, reason string) (int64, error) {
	if err := LockOrganization(ctx, tx, orgID); err != nil {
		return 0, err
	}
	return FailPendingTx(ctx, tx, orgID, actorID, reason)
}
