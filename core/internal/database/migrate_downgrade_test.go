package database

import (
	"context"
	"errors"
	"fmt"
	"net/url"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
)

// An older Core must refuse a database migrated by a newer release instead of
// running against a schema it does not know (docs/upgrade.md).
func TestMigrateRefusesSchemaFromNewerRelease(t *testing.T) {
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
	name := fmt.Sprintf("coma_migration_downgrade_%d", time.Now().UnixNano())
	if _, err := admin.Exec(ctx, `CREATE DATABASE `+name); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _, _ = admin.Exec(context.Background(), `DROP DATABASE `+name+` WITH (FORCE)`) })
	parsed, err := url.Parse(rawURL)
	if err != nil {
		t.Fatal(err)
	}
	parsed.Path = "/" + name
	if err := Migrate(ctx, parsed.String()); err != nil {
		t.Fatalf("first migration: %v", err)
	}
	if err := Migrate(ctx, parsed.String()); err != nil {
		t.Fatalf("repeated migration of an up-to-date schema: %v", err)
	}
	db, err := pgx.Connect(ctx, parsed.String())
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close(context.Background())
	if _, err := db.Exec(ctx, `INSERT INTO goose_db_version (version_id, is_applied) VALUES (99999, true)`); err != nil {
		t.Fatal(err)
	}
	if err := Migrate(ctx, parsed.String()); !errors.Is(err, ErrSchemaNewer) {
		t.Fatalf("Migrate() error = %v, want ErrSchemaNewer", err)
	}
}
