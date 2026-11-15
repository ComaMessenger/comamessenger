package task

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/riverqueue/river"
	"github.com/riverqueue/river/riverdriver/riverpgxv5"
	"github.com/riverqueue/river/rivertype"
)

const (
	jobQueue       = "tasks"
	jobMaxAttempts = 8
)

// The job arguments carry only the message id: the job reads everything
// else, including whether it is still the current one, from the locked row.

type DueSoonArgs struct {
	MessageID string `json:"message_id"`
}

func (DueSoonArgs) Kind() string { return KindDueSoon }

type OverdueArgs struct {
	MessageID string `json:"message_id"`
}

func (OverdueArgs) Kind() string { return KindOverdue }

type dueSoonWorker struct {
	river.WorkerDefaults[DueSoonArgs]
	service *Service
}

func (w *dueSoonWorker) Timeout(*river.Job[DueSoonArgs]) time.Duration { return 30 * time.Second }

func (w *dueSoonWorker) Work(ctx context.Context, job *river.Job[DueSoonArgs]) error {
	return snoozed(w.service.DueSoon(ctx, job.Args.MessageID, job.ID))
}

type overdueWorker struct {
	river.WorkerDefaults[OverdueArgs]
	service *Service
}

func (w *overdueWorker) Timeout(*river.Job[OverdueArgs]) time.Duration { return 30 * time.Second }

func (w *overdueWorker) Work(ctx context.Context, job *river.Job[OverdueArgs]) error {
	return snoozed(w.service.Overdue(ctx, job.Args.MessageID, job.ID))
}

// Snooze asks River to run the job again later: it woke up early.
type Snooze struct{ Delay time.Duration }

func (s Snooze) Error() string { return fmt.Sprintf("task job not due for %s", s.Delay) }

func snoozed(err error) error {
	var snooze Snooze
	if errors.As(err, &snooze) {
		return river.JobSnooze(snooze.Delay)
	}
	return err
}

type riverJobs struct {
	client *river.Client[pgx.Tx]
}

func (r riverJobs) ScheduleTx(ctx context.Context, tx pgx.Tx, kind, messageID string, at time.Time) (int64, error) {
	var args river.JobArgs
	switch kind {
	case KindDueSoon:
		args = DueSoonArgs{MessageID: messageID}
	case KindOverdue:
		args = OverdueArgs{MessageID: messageID}
	default:
		return 0, fmt.Errorf("unknown task job kind %q", kind)
	}
	result, err := r.client.InsertTx(ctx, tx, args, &river.InsertOpts{Queue: jobQueue, MaxAttempts: jobMaxAttempts, ScheduledAt: at})
	if err != nil {
		return 0, err
	}
	return result.Job.ID, nil
}

// CancelTx removes a job that has not run yet. A job River already cleaned
// up is gone anyway; a stale job that still runs finds nothing to do.
func (r riverJobs) CancelTx(ctx context.Context, tx pgx.Tx, jobID int64) error {
	if _, err := r.client.JobCancelTx(ctx, tx, jobID); err != nil && !errors.Is(err, rivertype.ErrNotFound) {
		return err
	}
	return nil
}

// NewClient installs the task workers (queue tasks, two workers) and wires
// transactional scheduling into service, as request.NewClient does for
// requests.
func NewClient(pool *pgxpool.Pool, service *Service, logger *slog.Logger) (*river.Client[pgx.Tx], error) {
	workers := river.NewWorkers()
	river.AddWorker(workers, &dueSoonWorker{service: service})
	river.AddWorker(workers, &overdueWorker{service: service})
	client, err := river.NewClient(riverpgxv5.New(pool), &river.Config{
		Logger:  logger,
		Queues:  map[string]river.QueueConfig{jobQueue: {MaxWorkers: 2}},
		Workers: workers,
	})
	if err != nil {
		return nil, fmt.Errorf("create task job client: %w", err)
	}
	service.SetJobs(riverJobs{client: client})
	return client, nil
}

// beginJob opens the transaction of a job: the organization lock first, then
// the task (message row first). A task that is gone reports ok false.
func (s *Service) beginJob(ctx context.Context, messageID string) (pgx.Tx, lockedTask, bool, error) {
	var orgID string
	if err := s.pool.QueryRow(ctx, `SELECT org_id FROM message_tasks WHERE message_id = $1`, messageID).Scan(&orgID); errors.Is(err, pgx.ErrNoRows) {
		return nil, lockedTask{}, false, nil
	} else if err != nil {
		return nil, lockedTask{}, false, fmt.Errorf("find task of job: %w", err)
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return nil, lockedTask{}, false, fmt.Errorf("begin task job: %w", err)
	}
	if err := lockOrganization(ctx, tx, orgID); err != nil {
		tx.Rollback(ctx)
		if errors.Is(err, ErrNotFound) {
			return nil, lockedTask{}, false, nil
		}
		return nil, lockedTask{}, false, err
	}
	current, err := lockTask(ctx, tx, orgID, messageID)
	if err != nil {
		tx.Rollback(ctx)
		if errors.Is(err, ErrNotFound) {
			return nil, lockedTask{}, false, nil
		}
		return nil, lockedTask{}, false, err
	}
	return tx, current, true, nil
}

// DueSoon reminds the responsible person (the candidates of a queue) one
// hour before the due date. It does nothing for a stale job, a closed task,
// a reminder switched off, a deleted message or an archived chat, and
// skips a reminder more than DueSoonMaxLateness late: «in an hour» an hour
// and a half later is not true.
func (s *Service) DueSoon(ctx context.Context, messageID string, jobID int64) error {
	tx, t, ok, err := s.beginJob(ctx, messageID)
	if err != nil || !ok {
		return err
	}
	defer tx.Rollback(ctx)
	if t.DueSoonJobID == nil || *t.DueSoonJobID != jobID || !Active(t.Status) || !t.RemindBeforeDue ||
		t.DueAt == nil || t.DueSoonSentAt != nil {
		return nil
	}
	now := s.Now()
	at := t.DueAt.Add(-RemindBefore)
	if now.Before(at) {
		return Snooze{Delay: at.Sub(now)}
	}
	var seq int64
	if !t.MessageDeleted && !t.ChatArchived && now.Sub(at) <= s.limits.DueSoonMaxLateness {
		targets, err := s.audienceInChat(ctx, tx, t, nil)
		if err != nil {
			return err
		}
		notices := noticeSet{}
		for _, target := range targets {
			notices.add("due_soon", target)
		}
		if seq, err = notices.writeBy(ctx, tx, t.OrgID, t.AuthorID, nil, t.ChatID, t.MessageID, t.DueAt); err != nil {
			return err
		}
	}
	if _, err := tx.Exec(ctx, `UPDATE message_tasks SET due_soon_sent_at=$2, due_soon_job_id=NULL WHERE message_id=$1`, messageID, now); err != nil {
		return fmt.Errorf("record task reminder: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("commit task reminder: %w", err)
	}
	s.notify(t.OrgID, seq)
	return nil
}

// Overdue marks the moment the due date passes: task.updated for every
// card, and, once, task.notified(overdue) to the responsible person (the
// candidates of a queue) and the author, each while an active member of the
// chat. More than OverdueMaxLateness late there is no notice, only the
// update. Nothing for a stale job, a closed task, a deleted message or an
// archived chat.
func (s *Service) Overdue(ctx context.Context, messageID string, jobID int64) error {
	tx, t, ok, err := s.beginJob(ctx, messageID)
	if err != nil || !ok {
		return err
	}
	defer tx.Rollback(ctx)
	if t.OverdueJobID == nil || *t.OverdueJobID != jobID || !Active(t.Status) || t.DueAt == nil || t.OverdueSentAt != nil {
		return nil
	}
	now := s.Now()
	if now.Before(*t.DueAt) {
		return Snooze{Delay: t.DueAt.Sub(now)}
	}
	finish := `UPDATE message_tasks SET overdue_sent_at=$2, overdue_job_id=NULL WHERE message_id=$1`
	if t.MessageDeleted || t.ChatArchived {
		if _, err := tx.Exec(ctx, finish, messageID, now); err != nil {
			return fmt.Errorf("record task overdue: %w", err)
		}
		return tx.Commit(ctx)
	}
	var last int64
	if now.Sub(*t.DueAt) <= s.limits.OverdueMaxLateness {
		targets, err := s.audienceInChat(ctx, tx, t, nil)
		if err != nil {
			return err
		}
		notices := noticeSet{}
		for _, target := range targets {
			notices.add("overdue", target)
		}
		var authorPresent bool
		if err := tx.QueryRow(ctx, `SELECT EXISTS (
			SELECT 1 FROM chat_members cm
			JOIN actors a ON a.org_id = cm.org_id AND a.id = cm.actor_id AND a.status = 'active' AND a.deleted_at IS NULL
			WHERE cm.org_id = $1 AND cm.chat_id = $2 AND cm.actor_id = $3)`, t.OrgID, t.ChatID, t.AuthorID).Scan(&authorPresent); err != nil {
			return fmt.Errorf("check task author: %w", err)
		}
		if authorPresent {
			notices.add("overdue", t.AuthorID)
		}
		if last, err = notices.writeBy(ctx, tx, t.OrgID, t.AuthorID, nil, t.ChatID, t.MessageID, t.DueAt); err != nil {
			return err
		}
	}
	if _, err := tx.Exec(ctx, finish, messageID, now); err != nil {
		return fmt.Errorf("record task overdue: %w", err)
	}
	if err := tx.QueryRow(ctx, `UPDATE message_tasks SET version=version+1 WHERE message_id=$1 RETURNING version`, messageID).Scan(&t.Version); err != nil {
		return fmt.Errorf("bump task version: %w", err)
	}
	seq, err := emitUpdated(ctx, tx, t, t.AuthorID)
	if err != nil {
		return err
	}
	if seq > last {
		last = seq
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("commit task overdue: %w", err)
	}
	s.notify(t.OrgID, last)
	return nil
}
