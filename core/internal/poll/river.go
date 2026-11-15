package poll

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
	jobQueue       = "polls"
	jobMaxAttempts = 8
)

// CloseArgs carries only the message id: the job reads everything else,
// including whether it is still the current one, from the locked row.
type CloseArgs struct {
	MessageID string `json:"message_id"`
}

func (CloseArgs) Kind() string { return KindClose }

type closeWorker struct {
	river.WorkerDefaults[CloseArgs]
	service *Service
}

func (w *closeWorker) Timeout(*river.Job[CloseArgs]) time.Duration { return 30 * time.Second }

func (w *closeWorker) Work(ctx context.Context, job *river.Job[CloseArgs]) error {
	err := w.service.Expire(ctx, job.Args.MessageID, job.ID)
	var snooze Snooze
	if errors.As(err, &snooze) {
		return river.JobSnooze(snooze.Delay)
	}
	return err
}

// Snooze asks River to run the job again later: it woke up early.
type Snooze struct{ Delay time.Duration }

func (s Snooze) Error() string { return fmt.Sprintf("poll job not due for %s", s.Delay) }

type riverJobs struct {
	client *river.Client[pgx.Tx]
}

func (r riverJobs) ScheduleTx(ctx context.Context, tx pgx.Tx, messageID string, at time.Time) (int64, error) {
	result, err := r.client.InsertTx(ctx, tx, CloseArgs{MessageID: messageID}, &river.InsertOpts{Queue: jobQueue, MaxAttempts: jobMaxAttempts, ScheduledAt: at})
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

// NewClient installs the poll worker (queue polls, two workers) and wires
// transactional scheduling into service, as task.NewClient does for tasks.
func NewClient(pool *pgxpool.Pool, service *Service, logger *slog.Logger) (*river.Client[pgx.Tx], error) {
	workers := river.NewWorkers()
	river.AddWorker(workers, &closeWorker{service: service})
	client, err := river.NewClient(riverpgxv5.New(pool), &river.Config{
		Logger:  logger,
		Queues:  map[string]river.QueueConfig{jobQueue: {MaxWorkers: 2}},
		Workers: workers,
	})
	if err != nil {
		return nil, fmt.Errorf("create poll job client: %w", err)
	}
	service.SetJobs(riverJobs{client: client})
	return client, nil
}

// Expire closes a poll at its due date (closed_reason expired) and tells
// the author (poll.notified closed_expired, with a push) while they are an
// active member of the live chat. In an archived chat the poll closes
// silently. A stale job, a closed poll or a deleted message changes
// nothing.
func (s *Service) Expire(ctx context.Context, messageID string, jobID int64) error {
	var orgID string
	if err := s.pool.QueryRow(ctx, `SELECT org_id FROM message_polls WHERE message_id = $1`, messageID).Scan(&orgID); errors.Is(err, pgx.ErrNoRows) {
		return nil
	} else if err != nil {
		return fmt.Errorf("find poll of job: %w", err)
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("begin poll job: %w", err)
	}
	defer tx.Rollback(ctx)
	if err := lockOrganization(ctx, tx, orgID); err != nil {
		if errors.Is(err, ErrNotFound) {
			return nil
		}
		return err
	}
	r, err := lockPoll(ctx, tx, orgID, messageID)
	if errors.Is(err, ErrNotFound) {
		return nil
	}
	if err != nil {
		return err
	}
	if r.CloseJobID == nil || *r.CloseJobID != jobID || r.Status != StatusOpen || r.DueAt == nil || r.MessageDeleted {
		return nil
	}
	now := s.Now()
	if now.Before(*r.DueAt) {
		return Snooze{Delay: r.DueAt.Sub(now)}
	}
	r.CloseJobID = nil // this job is running: nothing to cancel
	last, err := s.closeTx(ctx, tx, &r, ReasonExpired, nil, now)
	if err != nil {
		return err
	}
	if !r.ChatArchived {
		var present bool
		if err := tx.QueryRow(ctx, `SELECT EXISTS (
			SELECT 1 FROM chat_members cm
			JOIN actors a ON a.org_id = cm.org_id AND a.id = cm.actor_id AND `+activePerson("a")+`
			WHERE cm.org_id = $1 AND cm.chat_id = $2 AND cm.actor_id = $3)`, r.OrgID, r.ChatID, r.AuthorID).Scan(&present); err != nil {
			return fmt.Errorf("check poll author: %w", err)
		}
		if present {
			if last, err = emitNotified(ctx, tx, r, "closed_expired", nil, r.AuthorID, true); err != nil {
				return err
			}
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("commit poll closing: %w", err)
	}
	s.notify(r.OrgID, last)
	return nil
}
