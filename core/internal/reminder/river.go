package reminder

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
	fireQueue       = "reminders"
	fireMaxAttempts = 8
)

// FireArgs carries only the reminder id: the job reads everything else,
// including whether it is still due, from the locked row. No note, no text.
type FireArgs struct {
	ReminderID string `json:"reminder_id"`
}

func (FireArgs) Kind() string { return "message_reminder.fire" }

type fireWorker struct {
	river.WorkerDefaults[FireArgs]
	service *Service
}

func (w *fireWorker) Timeout(*river.Job[FireArgs]) time.Duration { return 30 * time.Second }

// Work fires the reminder. A transient error is retried by River (up to
// fireMaxAttempts); the fired state, checked under the row lock, makes every
// retry after a success a no-op, so the owner gets one event and one push.
// If River gives up, the cleanup sweep fires the reminder late.
func (w *fireWorker) Work(ctx context.Context, job *river.Job[FireArgs]) error {
	err := w.service.Fire(ctx, job.Args.ReminderID, job.ID)
	var snooze Snooze
	if errors.As(err, &snooze) {
		return river.JobSnooze(snooze.Delay)
	}
	return err
}

type riverScheduler struct {
	client *river.Client[pgx.Tx]
}

func (r riverScheduler) ScheduleTx(ctx context.Context, tx pgx.Tx, reminderID string, at time.Time) (int64, error) {
	result, err := r.client.InsertTx(ctx, tx, FireArgs{ReminderID: reminderID}, &river.InsertOpts{
		Queue: fireQueue, MaxAttempts: fireMaxAttempts, ScheduledAt: at,
	})
	if err != nil {
		return 0, err
	}
	return result.Job.ID, nil
}

// CancelTx removes a job that has not run yet. A job River already cleaned
// up is gone anyway; a stale job that still runs finds nothing to do.
func (r riverScheduler) CancelTx(ctx context.Context, tx pgx.Tx, jobID int64) error {
	if _, err := r.client.JobCancelTx(ctx, tx, jobID); err != nil && !errors.Is(err, rivertype.ErrNotFound) {
		return err
	}
	return nil
}

// NewClient installs the fire worker on its own queue and wires
// transactional scheduling, like scheduled.NewClient.
func NewClient(pool *pgxpool.Pool, service *Service, logger *slog.Logger) (*river.Client[pgx.Tx], error) {
	workers := river.NewWorkers()
	river.AddWorker(workers, &fireWorker{service: service})
	client, err := river.NewClient(riverpgxv5.New(pool), &river.Config{
		Logger:  logger,
		Queues:  map[string]river.QueueConfig{fireQueue: {MaxWorkers: 4}},
		Workers: workers,
	})
	if err != nil {
		return nil, fmt.Errorf("create reminder client: %w", err)
	}
	service.SetScheduler(riverScheduler{client: client})
	return client, nil
}

// Start creates the service, its River client and the cleanup loop for the
// server. The returned stop waits for running jobs; call it on shutdown.
func Start(ctx context.Context, pool *pgxpool.Pool, afterCommit func(string, int64), logger *slog.Logger) (*Service, func(context.Context) error, error) {
	service := NewService(pool, afterCommit, logger)
	client, err := NewClient(pool, service, logger)
	if err != nil {
		return nil, nil, err
	}
	if err := client.Start(ctx); err != nil {
		return nil, nil, fmt.Errorf("start reminder client: %w", err)
	}
	go service.RunCleanup(ctx, time.Minute)
	return service, client.Stop, nil
}
