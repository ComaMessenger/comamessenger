package database

import (
	"context"
	"database/sql"
	"fmt"
	"io/fs"
	"net/url"
	"os"
	"sort"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/comamessenger/comamessenger/core/internal/database/migrations"
	"github.com/jackc/pgx/v5"
	"github.com/pressly/goose/v3"
)

// migrationVersionsFor finds the migration with the given name suffix and
// the one right before it, so tests survive renumbering.
func migrationVersionsFor(t *testing.T, suffix string) (int64, int64, string) {
	t.Helper()
	entries, err := fs.ReadDir(migrations.Files, ".")
	if err != nil {
		t.Fatal(err)
	}
	var versions []int64
	var found int64
	var body string
	for _, entry := range entries {
		name := entry.Name()
		if !strings.HasSuffix(name, ".sql") {
			continue
		}
		version, err := strconv.ParseInt(strings.SplitN(name, "_", 2)[0], 10, 64)
		if err != nil {
			t.Fatal(err)
		}
		versions = append(versions, version)
		if strings.HasSuffix(name, suffix) {
			found = version
			data, err := fs.ReadFile(migrations.Files, name)
			if err != nil {
				t.Fatal(err)
			}
			body = string(data)
		}
	}
	sort.Slice(versions, func(i, j int) bool { return versions[i] < versions[j] })
	for index, version := range versions {
		if version == found && index > 0 {
			return versions[index-1], found, body
		}
	}
	t.Fatalf("migration *%s not found", suffix)
	return 0, 0, ""
}

// TestStorageHardeningMigration adds the reconciliation and lease columns
// without queueing behind a long query, then goes down and up again.
func TestStorageHardeningMigration(t *testing.T) {
	rawURL := os.Getenv("TEST_DATABASE_URL")
	if rawURL == "" {
		t.Skip("TEST_DATABASE_URL is not set")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	admin, err := pgx.Connect(ctx, rawURL)
	if err != nil {
		t.Fatal(err)
	}
	defer admin.Close(context.Background())
	name := fmt.Sprintf("coma_migration_storage_%d", time.Now().UnixNano())
	if _, err := admin.Exec(ctx, `CREATE DATABASE `+name); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _, _ = admin.Exec(context.Background(), `DROP DATABASE `+name+` WITH (FORCE)`) })
	parsed, err := url.Parse(rawURL)
	if err != nil {
		t.Fatal(err)
	}
	parsed.Path = "/" + name
	db, err := sql.Open("pgx", parsed.String())
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	goose.SetBaseFS(migrations.Files)
	if err := goose.SetDialect("postgres"); err != nil {
		t.Fatal(err)
	}
	previous, storage, body := migrationVersionsFor(t, "_storage_hardening.sql")
	if !strings.Contains(body, "-- +goose NO TRANSACTION") || strings.Count(body, "SET LOCAL lock_timeout") != 2 {
		t.Fatal("every ALTER of files and file_uploads must run in its own transaction under a lock_timeout")
	}
	if err := goose.UpToContext(ctx, db, ".", previous); err != nil {
		t.Fatal(err)
	}
	holder, err := db.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := holder.ExecContext(ctx, `LOCK TABLE files IN ACCESS SHARE MODE`); err != nil {
		t.Fatal(err)
	}
	started := time.Now()
	err = goose.UpToContext(ctx, db, ".", storage)
	waited := time.Since(started)
	_ = holder.Rollback()
	if err == nil || !strings.Contains(err.Error(), "lock timeout") || waited > 20*time.Second {
		t.Fatalf("migration behind a held lock: err = %v after %v, want a lock timeout within seconds", err, waited)
	}
	count := func() int {
		t.Helper()
		var columns int
		if err := db.QueryRowContext(ctx, `SELECT count(*) FROM information_schema.columns
			WHERE (table_name = 'files' AND column_name IN ('failed_at', 'missing_since'))
			   OR (table_name = 'file_uploads' AND column_name = 'claim_expires_at')`).Scan(&columns); err != nil {
			t.Fatal(err)
		}
		return columns
	}
	for round := 0; round < 2; round++ {
		if err := goose.UpToContext(ctx, db, ".", storage); err != nil {
			t.Fatal(err)
		}
		if got := count(); got != 3 {
			t.Fatalf("storage columns after Up = %d, want 3", got)
		}
		if err := goose.DownToContext(ctx, db, ".", previous); err != nil {
			t.Fatal(err)
		}
		if got := count(); got != 0 {
			t.Fatalf("storage columns after Down = %d, want 0", got)
		}
	}
}
