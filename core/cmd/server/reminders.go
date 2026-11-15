package main

import (
	"context"
	"errors"
	"log/slog"
	"os"

	"github.com/comamessenger/comamessenger/core/internal/reminder"
	"github.com/jackc/pgx/v5/pgxpool"
)

// startReminders runs personal reminders («Напомнить мне»): their River
// client with the message_reminder.fire worker and the cleanup loop. The
// returned stop waits for running jobs on shutdown.
func startReminders(ctx context.Context, pool *pgxpool.Pool, afterCommit func(string, int64), logger *slog.Logger) (*reminder.Service, func(context.Context)) {
	service, stop, err := reminder.Start(ctx, pool, afterCommit, logger)
	if err != nil {
		logger.Error("reminder startup failed", "error", err)
		os.Exit(1)
	}
	return service, func(ctx context.Context) {
		if err := stop(ctx); err != nil && !errors.Is(err, context.Canceled) {
			logger.Error("reminder shutdown failed", "error", err)
		}
	}
}
