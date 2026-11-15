package away

import (
	"context"
	"fmt"
	"log/slog"
	"time"

	"github.com/comamessenger/comamessenger/core/internal/message"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/riverqueue/river"
	"github.com/riverqueue/river/riverdriver/riverpgxv5"
)

const (
	autoreplyQueue       = "away"
	autoreplyMaxAttempts = 5
)

type autoreplyWorker struct {
	river.WorkerDefaults[AutoreplyArgs]
	service *Service
}

func (w *autoreplyWorker) Timeout(*river.Job[AutoreplyArgs]) time.Duration { return 30 * time.Second }

// Work sends the auto-reply. A retry after a success finds the mark and
// does nothing, so the peer gets one auto-reply.
func (w *autoreplyWorker) Work(ctx context.Context, job *river.Job[AutoreplyArgs]) error {
	return w.service.SendAutoreply(ctx, job.Args)
}

type riverScheduler struct {
	client *river.Client[pgx.Tx]
}

func (r riverScheduler) ScheduleAutoreplyTx(ctx context.Context, tx pgx.Tx, args AutoreplyArgs) error {
	_, err := r.client.InsertTx(ctx, tx, args, &river.InsertOpts{Queue: autoreplyQueue, MaxAttempts: autoreplyMaxAttempts})
	return err
}

// NewClient installs the auto-reply worker on its own queue and wires
// transactional scheduling.
func NewClient(pool *pgxpool.Pool, service *Service, logger *slog.Logger) (*river.Client[pgx.Tx], error) {
	workers := river.NewWorkers()
	river.AddWorker(workers, &autoreplyWorker{service: service})
	client, err := river.NewClient(riverpgxv5.New(pool), &river.Config{
		Logger:  logger,
		Queues:  map[string]river.QueueConfig{autoreplyQueue: {MaxWorkers: 2}},
		Workers: workers,
	})
	if err != nil {
		return nil, fmt.Errorf("create away client: %w", err)
	}
	service.SetScheduler(riverScheduler{client: client})
	return client, nil
}

// Start creates the service and its River client for the server. The
// returned stop waits for running jobs; call it on shutdown.
func Start(ctx context.Context, pool *pgxpool.Pool, messages *message.Service, afterCommit func(string, int64), logger *slog.Logger) (*Service, func(context.Context) error, error) {
	service := NewService(pool, messages, afterCommit, logger)
	client, err := NewClient(pool, service, logger)
	if err != nil {
		return nil, nil, err
	}
	if err := client.Start(ctx); err != nil {
		return nil, nil, fmt.Errorf("start away client: %w", err)
	}
	return service, client.Stop, nil
}
