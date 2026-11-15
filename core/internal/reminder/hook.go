package reminder

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5"
)

// OnMessageDeletedTx runs inside message.Service.Delete, after the
// organization and the message are locked and the message is marked
// deleted. Every person's reminder about it changes:
//   - without a note it is removed (reminder.deleted, reason
//     message_deleted);
//   - with a note it loses its message and stays: it fires as planned and
//     shows the note with «Сообщение удалено» (reminder.updated). The note is
//     the person's own thought and is never dropped silently.
//
// The fire job of a removed reminder is left alone: it finds no row and does
// nothing. Each event goes only to the reminder's owner.
func OnMessageDeletedTx(ctx context.Context, tx pgx.Tx, orgID, messageID string) error {
	rows, err := tx.Query(ctx, `
		SELECT `+selectColumns+` FROM message_reminders r
		WHERE r.org_id = $1 AND r.message_id = $2
		ORDER BY r.id FOR UPDATE`, orgID, messageID)
	if err != nil {
		return fmt.Errorf("find reminders of deleted message: %w", err)
	}
	var affected []Reminder
	for rows.Next() {
		var item Reminder
		if err := scan(rows, &item); err != nil {
			rows.Close()
			return fmt.Errorf("scan reminder of deleted message: %w", err)
		}
		affected = append(affected, item)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return fmt.Errorf("iterate reminders of deleted message: %w", err)
	}
	for _, item := range affected {
		if item.Note == "" {
			if _, err := tx.Exec(ctx, `DELETE FROM message_reminders WHERE id = $1`, item.ID); err != nil {
				return fmt.Errorf("drop reminder of deleted message: %w", err)
			}
			if _, err := insertEvent(ctx, tx, item, EventDeleted, ReasonMessageDeleted); err != nil {
				return err
			}
			continue
		}
		var kept Reminder
		if err := scan(tx.QueryRow(ctx, `
			UPDATE message_reminders r SET message_id = NULL, version = version + 1, updated_at = now()
			WHERE r.id = $1 RETURNING `+selectColumns, item.ID), &kept); err != nil {
			return fmt.Errorf("detach reminder from deleted message: %w", err)
		}
		if _, err := insertEvent(ctx, tx, kept, EventUpdated, ""); err != nil {
			return err
		}
	}
	return nil
}

// FiredTotal counts the person's fired reminders that are not closed yet:
// UnreadSnapshot.reminders_fired_total and the «Важные» badge. It counts the
// same rows as the fired list, those without access to the message too.
func FiredTotal(ctx context.Context, db interface {
	QueryRow(context.Context, string, ...any) pgx.Row
}, orgID, actorID string) (int, error) {
	var total int
	if err := db.QueryRow(ctx, `SELECT count(*) FROM message_reminders WHERE org_id = $1 AND actor_id = $2 AND state = 'fired'`,
		orgID, actorID).Scan(&total); err != nil {
		return 0, fmt.Errorf("count fired reminders: %w", err)
	}
	return total, nil
}
