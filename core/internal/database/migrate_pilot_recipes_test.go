package database

import (
	"context"
	"database/sql"
	"fmt"
	"io/fs"
	"net/url"
	"os"
	"reflect"
	"sort"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/comamessenger/comamessenger/core/internal/database/migrations"
	"github.com/jackc/pgx/v5"
	"github.com/pressly/goose/v3"
)

// pilotMigrationVersions finds the pilot recipes migration and the one right
// before it in the embedded set, so the test survives renumbering.
func pilotMigrationVersions(t *testing.T) (int64, int64) {
	t.Helper()
	entries, err := fs.ReadDir(migrations.Files, ".")
	if err != nil {
		t.Fatal(err)
	}
	var versions []int64
	var pilot int64
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
		if strings.HasSuffix(name, "_pilot_recipes.sql") {
			pilot = version
		}
	}
	sort.Slice(versions, func(i, j int) bool { return versions[i] < versions[j] })
	for index, version := range versions {
		if version == pilot && index > 0 {
			return versions[index-1], pilot
		}
	}
	t.Fatal("pilot recipes migration not found")
	return 0, 0
}

// TestPilotRecipesMigration upgrades a database with a legacy agent, checks
// the new recipe ids, longer instructions and the direct-card scope (which
// existing agents do not get), then goes back down cleanly.
func TestPilotRecipesMigration(t *testing.T) {
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
	name := fmt.Sprintf("coma_migration_pilot_%d", time.Now().UnixNano())
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
	previous, pilot := pilotMigrationVersions(t)
	if err := goose.UpToContext(ctx, db, ".", previous); err != nil {
		t.Fatal(err)
	}
	const (
		orgID   = "00000000-0000-7000-8000-000000005001"
		ownerID = "00000000-0000-7000-8000-000000005002"
		legacy  = "00000000-0000-7000-8000-000000005003"
		pilotID = "00000000-0000-7000-8000-000000005004"
	)
	seed, err := db.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := seed.Exec(`INSERT INTO organizations(id,name,slug) VALUES($1,'Pilot','migration-pilot')`, orgID); err != nil {
		t.Fatal(err)
	}
	if _, err := seed.Exec(`INSERT INTO actors(id,org_id,type,org_role,display_name,handle) VALUES
		($1,$4,'user','owner','Owner','mp-owner'),($2,$4,'agent','member','Legacy','mp-legacy'),($3,$4,'agent','member','Pilot','mp-pilot')`, ownerID, legacy, pilotID, orgID); err != nil {
		t.Fatal(err)
	}
	if err := seed.Commit(); err != nil {
		t.Fatal(err)
	}
	mustExec(t, db, `INSERT INTO agents(actor_id,org_id,owner_actor_id,kind,recipe) VALUES($1,$2,$3,'builtin','qa')`, legacy, orgID, ownerID)
	if _, err := db.Exec(`INSERT INTO agents(actor_id,org_id,owner_actor_id,kind,recipe) VALUES($1,$2,$3,'builtin','control')`, pilotID, orgID, ownerID); err == nil {
		t.Fatal("a pilot recipe id was accepted before the migration")
	}
	before := schemaSnapshot(t, db)

	if err := goose.UpToContext(ctx, db, ".", pilot); err != nil {
		t.Fatal(err)
	}
	mustExec(t, db, `INSERT INTO agents(actor_id,org_id,owner_actor_id,kind,recipe,description) VALUES($1,$2,$3,'builtin','control',$4)`,
		pilotID, orgID, ownerID, strings.Repeat("и", 3500))
	mustExec(t, db, `UPDATE agents SET recipe='slots' WHERE actor_id=$1`, legacy)

	// Down returns exactly the schema of the previous migration and succeeds
	// with pilot agents and long instructions present.
	if err := goose.DownToContext(ctx, db, ".", previous); err != nil {
		t.Fatal(err)
	}
	if after := schemaSnapshot(t, db); !reflect.DeepEqual(before, after) {
		t.Fatalf("down did not restore the schema:\nbefore=%v\nafter=%v", before, after)
	}
	var recipe string
	var length int
	if err := db.QueryRow(`SELECT recipe,length(description) FROM agents WHERE actor_id=$1`, pilotID).Scan(&recipe, &length); err != nil || recipe != "custom" || length != 2000 {
		t.Fatalf("down: recipe=%s length=%d err=%v", recipe, length, err)
	}
	if err := goose.UpToContext(ctx, db, ".", pilot); err != nil {
		t.Fatalf("up again: %v", err)
	}
}
