package request

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
	jobQueue       = "requests"
	jobMaxAttempts = 8
)

// The job arguments carry only the message id: the job reads everything
// else, including whether it is still the current one, from the locked row.

type AutoRemindArgs struct {
	MessageID string `json:"message_id"`
}

func (AutoRemindArgs) Kind() string { return KindAutoRemind }

type ExpireArgs struct {
	MessageID string `json:"message_id"`
}

func (ExpireArgs) Kind() string { return KindExpire }

type autoRemindWorker struct {
	river.WorkerDefaults[AutoRemindArgs]
	service *Service
}

func (w *autoRemindWorker) Timeout(*river.Job[AutoRemindArgs]) time.Duration { return time.Minute }

func (w *autoRemindWorker) Work(ctx context.Context, job *river.Job[AutoRemindArgs]) error {
	return snoozed(w.service.AutoRemind(ctx, job.Args.MessageID, job.ID))
}

type expireWorker struct {
	river.WorkerDefaults[ExpireArgs]
	service *Service
}

func (w *expireWorker) Timeout(*river.Job[ExpireArgs]) time.Duration { return 30 * time.Second }

func (w *expireWorker) Work(ctx context.Context, job *river.Job[ExpireArgs]) error {
	return snoozed(w.service.Expire(ctx, job.Args.MessageID, job.ID))
}

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
	case KindAutoRemind:
		args = AutoRemindArgs{MessageID: messageID}
	case KindExpire:
		args = ExpireArgs{MessageID: messageID}
	default:
		return 0, fmt.Errorf("unknown request job kind %q", kind)
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

// NewClient installs the request workers (queue requests, two workers) and
// wires transactional scheduling into service, as scheduled.NewClient does
// for scheduled messages.
func NewClient(pool *pgxpool.Pool, service *Service, logger *slog.Logger) (*river.Client[pgx.Tx], error) {
	workers := river.NewWorkers()
	river.AddWorker(workers, &autoRemindWorker{service: service})
	river.AddWorker(workers, &expireWorker{service: service})
	client, err := river.NewClient(riverpgxv5.New(pool), &river.Config{
		Logger:  logger,
		Queues:  map[string]river.QueueConfig{jobQueue: {MaxWorkers: 2}},
		Workers: workers,
	})
	if err != nil {
		return nil, fmt.Errorf("create request job client: %w", err)
	}
	service.SetJobs(riverJobs{client: client})
	return client, nil
}
