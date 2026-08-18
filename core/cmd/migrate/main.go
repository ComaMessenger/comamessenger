package main

import (
	"context"
	"log/slog"
	"os"
	"time"

	"github.com/comamessenger/comamessenger/core/internal/config"
	"github.com/comamessenger/comamessenger/core/internal/database"
)

func main() {
	cfg, err := config.FromEnvironment()
	if err != nil {
		slog.Error("invalid configuration", "error", err)
		os.Exit(1)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	if err := database.Migrate(ctx, cfg.DatabaseURL); err != nil {
		slog.Error("database migration failed", "error", err)
		os.Exit(1)
	}

	slog.Info("database migrations are up to date")
}
