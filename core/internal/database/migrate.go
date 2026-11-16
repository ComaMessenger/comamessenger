package database

import (
	"context"
	"database/sql"
	"errors"
	"fmt"

	"github.com/comamessenger/comamessenger/core/internal/database/migrations"
	"github.com/jackc/pgx/v5/pgxpool"
	_ "github.com/jackc/pgx/v5/stdlib"
	"github.com/pressly/goose/v3"
	"github.com/riverqueue/river/riverdriver/riverpgxv5"
	"github.com/riverqueue/river/rivermigrate"
)

// ErrUnreachable marks a database that did not answer; the caller may retry.
var ErrUnreachable = errors.New("database is not reachable")

// ErrSchemaNewer means the database was migrated by a newer release. Running
// an older Core against it could corrupt data, and migrations are never rolled
// back automatically: the operator starts the newer release again or restores
// the backup taken before the update.
var ErrSchemaNewer = errors.New("database schema is newer than this Core")

func refuseNewerSchema(ctx context.Context, db *sql.DB) error {
	known, err := goose.CollectMigrations(".", 0, goose.MaxVersion)
	if err != nil {
		return fmt.Errorf("collect migrations: %w", err)
	}
	last, err := known.Last()
	if err != nil {
		return fmt.Errorf("collect migrations: %w", err)
	}
	var applied sql.NullInt64
	err = db.QueryRowContext(ctx, `SELECT max(version_id) FROM goose_db_version WHERE is_applied`).Scan(&applied)
	if err != nil {
		var exists bool
		if probe := db.QueryRowContext(ctx, `SELECT to_regclass('goose_db_version') IS NOT NULL`).Scan(&exists); probe == nil && !exists {
			return nil // a new database
		}
		return fmt.Errorf("read schema version: %w", err)
	}
	if applied.Valid && applied.Int64 > last.Version {
		return fmt.Errorf("%w: the database is at migration %d, this Core knows migrations up to %d", ErrSchemaNewer, applied.Int64, last.Version)
	}
	return nil
}

func Migrate(ctx context.Context, databaseURL string) error {
	db, err := sql.Open("pgx", databaseURL)
	if err != nil {
		return fmt.Errorf("open database for migrations: %w", err)
	}
	defer db.Close()

	if err := db.PingContext(ctx); err != nil {
		return fmt.Errorf("%w: %w", ErrUnreachable, err)
	}

	goose.SetBaseFS(migrations.Files)
	if err := goose.SetDialect("postgres"); err != nil {
		return fmt.Errorf("configure migration dialect: %w", err)
	}
	if err := refuseNewerSchema(ctx, db); err != nil {
		return err
	}
	if err := goose.UpContext(ctx, db, "."); err != nil {
		return fmt.Errorf("apply migrations: %w", err)
	}
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		return fmt.Errorf("open database for River migrations: %w", err)
	}
	defer pool.Close()
	migrator, err := rivermigrate.New(riverpgxv5.New(pool), nil)
	if err != nil {
		return fmt.Errorf("configure River migrations: %w", err)
	}
	if _, err := migrator.Migrate(ctx, rivermigrate.DirectionUp, nil); err != nil {
		return fmt.Errorf("apply River migrations: %w", err)
	}

	return nil
}
