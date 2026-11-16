package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"strings"
	"time"

	"github.com/comamessenger/comamessenger/core/internal/database"
)

// Release metadata, set by the image build (-ldflags -X main.version=...).
var (
	version = "dev"
	commit  = "unknown"
)

const troubleshootingHint = "See docs/install.md, section «Частые ошибки» (https://github.com/ComaMessenger/comamessenger/blob/main/docs/install.md)."

// explainStartupFailure prints one plain-text paragraph for the operator next
// to the structured log line: `docker compose logs core` shows it verbatim.
func explainStartupFailure(w io.Writer, stage string, err error) {
	hint := ""
	message := err.Error()
	switch {
	case errors.Is(err, database.ErrSchemaNewer):
		hint = "The database was migrated by a newer Coma version. Start that version again, or restore the backup made before the update (docs/upgrade.md)."
	case strings.Contains(message, "password authentication failed"):
		hint = "PostgreSQL rejected the password from DATABASE_URL. POSTGRES_PASSWORD is applied only when the database volume is created: keep the .env that created the installation, or restore it from a backup."
	case strings.Contains(message, "no such host"), strings.Contains(message, "connection refused"), strings.Contains(message, "i/o timeout"):
		hint = "The service is not reachable. Check that it runs (`docker compose ps`) and that the host name in .env matches the Compose service."
	case strings.Contains(message, "outside development"), strings.Contains(message, "at least 32 bytes"):
		hint = "Generate secrets with ./generate-env.sh instead of editing them by hand."
	}
	fmt.Fprintf(w, "\nComa %s cannot start: %s failed.\n  %s\n", version, stage, message)
	if hint != "" {
		fmt.Fprintf(w, "  %s\n", hint)
	}
	fmt.Fprintf(w, "  %s\n\n", troubleshootingHint)
}

// migrateWhenReady waits up to the context deadline for PostgreSQL to accept
// connections, then applies migrations. A rejected password or a schema newer
// than this binary fails at once: waiting does not fix either.
func migrateWhenReady(ctx context.Context, logger *slog.Logger, databaseURL string) error {
	var lastErr error
	for attempt := 0; ; attempt++ {
		err := database.Migrate(ctx, databaseURL)
		if err == nil {
			return nil
		}
		lastErr = err
		if errors.Is(err, database.ErrSchemaNewer) || !errors.Is(err, database.ErrUnreachable) ||
			strings.Contains(err.Error(), "password authentication failed") {
			return err
		}
		if attempt == 0 {
			logger.Warn("waiting for PostgreSQL", "error", err)
		}
		select {
		case <-ctx.Done():
			return lastErr
		case <-time.After(2 * time.Second):
		}
	}
}
