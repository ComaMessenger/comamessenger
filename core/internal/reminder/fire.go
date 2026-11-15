package reminder

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
)

// Snooze asks the job runner to come back later: the job woke up before the
// reminder's time, which only happens through clock skew.
type Snooze struct{ Delay time.Duration }

func (s Snooze) Error() string { return fmt.Sprintf("reminder not due for %s", s.Delay) }

// Fire makes a due pending reminder fire. jobID is the River job running it,
// or 0 for the sweep of reminders whose job is gone. It is idempotent: the
// organization and the reminder are locked, and only a pending, due reminder
// whose job is this one fires, at most once per version. A stale job (the
// reminder was moved, closed or removed since) does nothing.
//
// Access to the message is not checked here: the reminder fires either way,
// as an alarm the owner set. What the push may show is decided when it is
// built (package push), as of that moment.
func (s *Service) Fire(ctx context.Context, reminderID string, jobID int64) error {
	var orgID string
	if err := s.pool.QueryRow(ctx, `SELECT org_id FROM message_reminders WHERE id = $1`, reminderID).Scan(&orgID); errors.Is(err, pgx.ErrNoRows) {
		return nil
	} else if err != nil {
		return fmt.Errorf("find reminder: %w", err)
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("begin fire reminder: %w", err)
	}
	defer tx.Rollback(ctx)
	if err := lockOrganization(ctx, tx, orgID); errors.Is(err, ErrNotFound) {
		return nil
	} else if err != nil {
		return err
	}
	var current Reminder
	var now time.Time
	var ownerActive bool
	err = scan(tx.QueryRow(ctx, `
		SELECT `+selectColumns+`, clock_timestamp(),
			EXISTS (SELECT 1 FROM actors a WHERE a.org_id = r.org_id AND a.id = r.actor_id AND a.status = 'active' AND a.deleted_at IS NULL)
		FROM message_reminders r WHERE r.id = $1 FOR UPDATE OF r`, reminderID), &current, &now, &ownerActive)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("lock reminder: %w", err)
	}
	if current.State != StatePending {
		return nil
	}
	if jobID != 0 && (current.riverJobID == nil || *current.riverJobID != jobID) {
		// A job of an earlier time: the current job fires it.
		return nil
	}
	if current.RemindAt.After(now) {
		if jobID != 0 {
			return Snooze{Delay: current.RemindAt.Sub(now)}
		}
		return nil
	}
	if !ownerActive {
		// A deactivated person gets no alarm; the reminder goes.
		if _, err := tx.Exec(ctx, `DELETE FROM message_reminders WHERE id = $1`, current.ID); err != nil {
			return fmt.Errorf("drop reminder of an inactive person: %w", err)
		}
		seq, err := insertEvent(ctx, tx, current, EventDeleted, ReasonRemoved)
		if err != nil {
			return err
		}
		if err := tx.Commit(ctx); err != nil {
			return fmt.Errorf("commit drop reminder: %w", err)
		}
		s.notify(orgID, seq)
		return nil
	}
	var result Reminder
	err = scan(tx.QueryRow(ctx, `
		UPDATE message_reminders r SET state = 'fired', fired_at = $2::timestamptz, fired_late = $2::timestamptz - r.remind_at > $3::interval,
			river_job_id = NULL, version = version + 1, updated_at = now()
		WHERE r.id = $1 RETURNING `+selectColumns, current.ID, now, LateAfter.String()), &result)
	if err != nil {
		return fmt.Errorf("fire reminder: %w", err)
	}
	if jobID == 0 {
		// The sweep fires a reminder whose job is gone or stuck: make sure
		// it cannot fire a second time.
		if err := s.cancel(ctx, tx, current.riverJobID); err != nil {
			return err
		}
	}
	seq, err := insertEvent(ctx, tx, result, EventFired, "")
	if err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("commit fire reminder: %w", err)
	}
	s.notify(orgID, seq)
	return nil
}

// sweepAfter: a pending reminder this long past its time whose job is no
// longer waiting (River gave up after its attempts, or the job was lost) is
// fired by the cleanup pass. It is then late and fires without a push
// unless it is still within PushLateLimit.
const sweepAfter = 10 * time.Minute

// Cleanup fires overdue reminders whose job is gone and removes fired
// reminders the owner never closed after FiredRetention.
func (s *Service) Cleanup(ctx context.Context) (int64, error) {
	var problems []error
	rows, err := s.pool.Query(ctx, `
		SELECT r.id FROM message_reminders r
		WHERE r.state = 'pending' AND r.remind_at < now() - $1::interval
		  AND NOT EXISTS (
			SELECT 1 FROM river_job j WHERE j.id = r.river_job_id
			  AND j.state IN ('available', 'pending', 'retryable', 'running', 'scheduled'))
		ORDER BY r.remind_at LIMIT 200`, sweepAfter.String())
	if err != nil {
		problems = append(problems, fmt.Errorf("find overdue reminders: %w", err))
	} else {
		var overdue []string
		for rows.Next() {
			var reminderID string
			if err := rows.Scan(&reminderID); err != nil {
				problems = append(problems, err)
				break
			}
			overdue = append(overdue, reminderID)
		}
		if err := rows.Err(); err != nil {
			problems = append(problems, err)
		}
		rows.Close()
		for _, reminderID := range overdue {
			if err := s.Fire(ctx, reminderID, 0); err != nil {
				problems = append(problems, fmt.Errorf("fire overdue reminder %s: %w", reminderID, err))
			}
		}
	}
	// Removed silently: after three months the alarm is long irrelevant, and
	// the owner's devices drop it on the next list read. Repeated in the
	// outer WHERE so a reminder moved meanwhile (pending again) is kept.
	command, err := s.pool.Exec(ctx, `
		DELETE FROM message_reminders r WHERE r.id IN (
			SELECT id FROM message_reminders WHERE state = 'fired' AND fired_at < now() - $1::interval LIMIT 1000)
		  AND r.state = 'fired' AND r.fired_at < now() - $1::interval`, FiredRetention.String())
	if err != nil {
		problems = append(problems, fmt.Errorf("clean up fired reminders: %w", err))
		return 0, errors.Join(problems...)
	}
	return command.RowsAffected(), errors.Join(problems...)
}

// RunCleanup repeats Cleanup until ctx ends.
func (s *Service) RunCleanup(ctx context.Context, interval time.Duration) {
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if removed, err := s.Cleanup(ctx); err != nil && !errors.Is(err, context.Canceled) {
				s.logger.Error("reminder cleanup failed", "error", err)
			} else if removed > 0 {
				s.logger.Info("fired reminders cleaned up", "removed", removed)
			}
		}
	}
}
