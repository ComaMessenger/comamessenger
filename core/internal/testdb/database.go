package testdb

import (
	"context"
	"fmt"
	"net/url"
	"os"
	"testing"
	"time"

	"github.com/comamessenger/comamessenger/core/internal/database"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// New creates a migrated, isolated PostgreSQL database and drops it after the test.
// Tests are skipped when TEST_DATABASE_URL is absent.
func New(t testing.TB) *pgxpool.Pool {
	t.Helper()
	rawURL := os.Getenv("TEST_DATABASE_URL")
	if rawURL == "" {
		t.Skip("TEST_DATABASE_URL is not set")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	admin, err := pgx.Connect(ctx, rawURL)
	if err != nil {
		t.Fatalf("connect to test database server: %v", err)
	}
	databaseName := fmt.Sprintf("coma_test_%d", time.Now().UnixNano())
	if _, err := admin.Exec(ctx, `CREATE DATABASE `+databaseName); err != nil {
		admin.Close(ctx)
		t.Fatalf("create temporary database: %v", err)
	}
	parsed, err := url.Parse(rawURL)
	if err != nil {
		t.Fatal(err)
	}
	parsed.Path = "/" + databaseName
	testURL := parsed.String()
	if err := database.Migrate(ctx, testURL); err != nil {
		admin.Exec(ctx, `DROP DATABASE `+databaseName+` WITH (FORCE)`)
		admin.Close(ctx)
		t.Fatalf("migrate temporary database: %v", err)
	}
	pool, err := database.NewPool(ctx, testURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		pool.Close()
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cleanupCancel()
		if _, err := admin.Exec(cleanupCtx, `DROP DATABASE `+databaseName+` WITH (FORCE)`); err != nil {
			t.Errorf("drop temporary database: %v", err)
		}
		admin.Close(cleanupCtx)
	})
	return pool
}
