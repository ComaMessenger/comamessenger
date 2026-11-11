package scheduled

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
	deliveryQueue       = "scheduled-messages"
	deliveryMaxAttempts = 8
)

// DeliverArgs carries only the record id: the job reads everything else,
// including whether it is still due, from the locked record.
type DeliverArgs struct {
	ScheduledMessageID string `json:"scheduled_message_id"`
}

func (DeliverArgs) Kind() string { return "scheduled_message.deliver" }

type deliverWorker struct {
	river.WorkerDefaults[DeliverArgs]
	service *Service
}

func (w *deliverWorker) Timeout(*river.Job[DeliverArgs]) time.Duration { return 30 * time.Second }

func (w *deliverWorker) Work(ctx context.Context, job *river.Job[DeliverArgs]) error {
	err := w.service.Deliver(ctx, job.Args.ScheduledMessageID, job.ID)
	var snooze Snooze
	if errors.As(err, &snooze) {
		return river.JobSnooze(snooze.Delay)
	}
	if err != nil && job.Attempt >= job.MaxAttempts {
		if failErr := w.service.MarkDeliveryFailed(context.WithoutCancel(ctx), job.Args.ScheduledMessageID, job.ID); failErr != nil {
			return errors.Join(err, failErr)
		}
	}
	return err
}

type riverScheduler struct {
	client *river.Client[pgx.Tx]
}

func (r riverScheduler) ScheduleTx(ctx context.Context, tx pgx.Tx, scheduledMessageID string, at time.Time) (int64, error) {
	result, err := r.client.InsertTx(ctx, tx, DeliverArgs{ScheduledMessageID: scheduledMessageID}, &river.InsertOpts{
		Queue: deliveryQueue, MaxAttempts: deliveryMaxAttempts, ScheduledAt: at,
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

// NewClient installs the delivery worker and wires transactional
// scheduling, following the file.process pattern.
func NewClient(pool *pgxpool.Pool, service *Service, logger *slog.Logger) (*river.Client[pgx.Tx], error) {
	workers := river.NewWorkers()
	river.AddWorker(workers, &deliverWorker{service: service})
	client, err := river.NewClient(riverpgxv5.New(pool), &river.Config{
		Logger:  logger,
		Queues:  map[string]river.QueueConfig{deliveryQueue: {MaxWorkers: 4}},
		Workers: workers,
	})
	if err != nil {
		return nil, fmt.Errorf("create scheduled message client: %w", err)
	}
	service.SetScheduler(riverScheduler{client: client})
	return client, nil
}
