package eventlog

import (
	"context"
	"fmt"
	"log/slog"
	"sync/atomic"
	"time"
)

type RetentionStats struct {
	Sweeps        uint64
	DeletedEvents uint64
	Errors        uint64
}

type RetentionWorker struct {
	logger   *slog.Logger
	store    *Store
	window   time.Duration
	interval time.Duration
	minCount int64
	batch    int
	sweeps   atomic.Uint64
	deleted  atomic.Uint64
	errors   atomic.Uint64
}

func NewRetentionWorker(logger *slog.Logger, store *Store, window, interval time.Duration, minCount uint64, batch uint64) *RetentionWorker {
	return &RetentionWorker{
		logger: logger, store: store, window: window, interval: interval,
		minCount: int64(minCount), batch: int(batch),
	}
}

func (w *RetentionWorker) Run(ctx context.Context) {
	w.sweep(ctx)
	ticker := time.NewTicker(w.interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			w.sweep(ctx)
		}
	}
}

func (w *RetentionWorker) Stats() RetentionStats {
	return RetentionStats{
		Sweeps: w.sweeps.Load(), DeletedEvents: w.deleted.Load(), Errors: w.errors.Load(),
	}
}

func (w *RetentionWorker) sweep(ctx context.Context) {
	startedAt := time.Now()
	deleted, err := w.store.Prune(ctx, startedAt.Add(-w.window), w.minCount, w.batch)
	w.sweeps.Add(1)
	if err != nil {
		w.errors.Add(1)
		if ctx.Err() == nil {
			w.logger.Error("event retention sweep failed", "duration", time.Since(startedAt), "error", err)
		}
		return
	}
	w.deleted.Add(uint64(deleted))
	if deleted > 0 {
		w.logger.Info("event retention sweep completed", "deleted_events", deleted, "duration", time.Since(startedAt))
	}
}

// Prune removes only events that are both older than cutoff and below the
// per-organization count floor. Each DELETE is bounded so writers are never
// held behind one large cleanup transaction.
func (s *Store) Prune(ctx context.Context, cutoff time.Time, minCount int64, batch int) (int64, error) {
	if minCount < 1 || batch < 1 {
		return 0, fmt.Errorf("invalid event retention limits")
	}
	rows, err := s.pool.Query(ctx, `SELECT id, event_seq FROM organizations ORDER BY id`)
	if err != nil {
		return 0, fmt.Errorf("list organizations for event retention: %w", err)
	}
	type organization struct {
		id      string
		current int64
	}
	organizations := make([]organization, 0)
	for rows.Next() {
		var item organization
		if err := rows.Scan(&item.id, &item.current); err != nil {
			rows.Close()
			return 0, fmt.Errorf("scan organization for event retention: %w", err)
		}
		organizations = append(organizations, item)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return 0, fmt.Errorf("iterate organizations for event retention: %w", err)
	}
	rows.Close()

	var total int64
	for _, organization := range organizations {
		for {
			result, err := s.pool.Exec(ctx, `
				WITH candidates AS (
					SELECT seq FROM events
					WHERE org_id = $1 AND seq <= $2::bigint - $3::bigint AND occurred_at < $4
					ORDER BY seq
					LIMIT $5
					FOR UPDATE SKIP LOCKED
				)
				DELETE FROM events e USING candidates c
				WHERE e.org_id = $1 AND e.seq = c.seq`,
				organization.id, organization.current, minCount, cutoff, batch)
			if err != nil {
				return total, fmt.Errorf("prune events for organization %s: %w", organization.id, err)
			}
			deleted := result.RowsAffected()
			total += deleted
			if deleted < int64(batch) {
				break
			}
		}
	}
	return total, nil
}
