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

func voiceMigrationVersions(t *testing.T) (int64, int64) {
	t.Helper()
	entries, err := fs.ReadDir(migrations.Files, ".")
	if err != nil {
		t.Fatal(err)
	}
	var versions []int64
	var voice int64
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
		if strings.HasSuffix(name, "_voice_messages.sql") {
			voice = version
			body, err := fs.ReadFile(migrations.Files, name)
			if err != nil {
				t.Fatal(err)
			}
			// The CHECK must not scan files under ACCESS EXCLUSIVE: it is added
			// NOT VALID and validated in its own transaction.
			if !strings.Contains(string(body), "-- +goose NO TRANSACTION") || !strings.Contains(string(body), "NOT VALID") || !strings.Contains(string(body), "VALIDATE CONSTRAINT files_voice_check") {
				t.Fatal("voice migration must add its CHECK NOT VALID and validate it outside the adding transaction")
			}
			if strings.Count(string(body), "SET LOCAL lock_timeout") != 3 {
				t.Fatal("every ALTER of files must run under its own lock_timeout")
			}
		}
	}
	sort.Slice(versions, func(i, j int) bool { return versions[i] < versions[j] })
	for index, version := range versions {
		if version == voice && index > 0 {
			return versions[index-1], voice
		}
	}
	t.Fatal("voice migration not found")
	return 0, 0
}

// TestVoiceMigration upgrades a database that already has files, checks the
// constraint ends up validated and enforced, then goes down and up again.
func TestVoiceMigration(t *testing.T) {
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
	name := fmt.Sprintf("coma_migration_voice_%d", time.Now().UnixNano())
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
	previous, voice := voiceMigrationVersions(t)
	if err := goose.UpToContext(ctx, db, ".", previous); err != nil {
		t.Fatal(err)
	}
	const (
		orgID   = "00000000-0000-7000-8000-000000006001"
		ownerID = "00000000-0000-7000-8000-000000006002"
		fileID  = "00000000-0000-7000-8000-000000006003"
	)
	seed, err := db.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	mustExecTx(t, seed, `INSERT INTO organizations(id,name,slug) VALUES($1,'Voice','migration-voice')`, orgID)
	mustExecTx(t, seed, `INSERT INTO actors(id,org_id,type,org_role,display_name,handle) VALUES($1,$2,'user','owner','Owner','mv-owner')`, ownerID, orgID)
	if err := seed.Commit(); err != nil {
		t.Fatal(err)
	}
	mustExec(t, db, `INSERT INTO files(id,org_id,uploader_id,storage_driver,storage_key,name,mime,size,status) VALUES($1,$2,$3,'local','objects/a','a.txt','text/plain',1,'ready')`, fileID, orgID, ownerID)

	// A long query holding files makes the migration give up after the
	// lock timeout instead of queueing every later access behind it.
	holder, err := db.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := holder.ExecContext(ctx, `LOCK TABLE files IN ACCESS SHARE MODE`); err != nil {
		t.Fatal(err)
	}
	started := time.Now()
	err = goose.UpToContext(ctx, db, ".", voice)
	waited := time.Since(started)
	_ = holder.Rollback()
	if err == nil || !strings.Contains(err.Error(), "lock timeout") || waited > 20*time.Second {
		t.Fatalf("migration behind a held lock: err = %v after %v, want a lock timeout within seconds", err, waited)
	}

	for round := 0; round < 2; round++ {
		if err := goose.UpToContext(ctx, db, ".", voice); err != nil {
			t.Fatal(err)
		}
		var validated bool
		if err := db.QueryRowContext(ctx, `SELECT convalidated FROM pg_constraint WHERE conname = 'files_voice_check'`).Scan(&validated); err != nil || !validated {
			t.Fatalf("files_voice_check validated = %v, err = %v", validated, err)
		}
		if _, err := db.ExecContext(ctx, `UPDATE files SET voice_duration_ms = 1000 WHERE id = $1`, fileID); err == nil {
			t.Fatal("a duration without a waveform was accepted")
		}
		if _, err := db.ExecContext(ctx, `UPDATE files SET voice_waveform = decode(repeat('00', 64), 'hex') WHERE id = $1`, fileID); err == nil {
			t.Fatal("a waveform without a duration was accepted")
		}
		mustExec(t, db, `UPDATE files SET voice_duration_ms = 1000, voice_waveform = decode(repeat('00', 64), 'hex') WHERE id = $1`, fileID)
		if err := goose.DownToContext(ctx, db, ".", previous); err != nil {
			t.Fatal(err)
		}
		var columns int
		if err := db.QueryRowContext(ctx, `SELECT count(*) FROM information_schema.columns WHERE table_name = 'files' AND column_name LIKE 'voice_%'`).Scan(&columns); err != nil || columns != 0 {
			t.Fatalf("voice columns after Down = %d, err = %v", columns, err)
		}
	}
}
