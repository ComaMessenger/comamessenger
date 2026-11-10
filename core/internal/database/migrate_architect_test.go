package database

import (
	"context"
	"database/sql"
	"fmt"
	"net/url"
	"os"
	"reflect"
	"testing"
	"time"

	"github.com/comamessenger/comamessenger/core/internal/database/migrations"
	"github.com/jackc/pgx/v5"
	"github.com/pressly/goose/v3"
)

// TestAgentArchitectMigration applies 00001→00047, upgrades to 00048 and
// verifies that Down 00048 restores the 00047 schema exactly even with
// Architect sessions, the architect system agent and its usage records in
// place, while product agents, the runtime worker and their usage survive.
func TestAgentArchitectMigration(t *testing.T) {
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
	name := fmt.Sprintf("coma_migration_%d", time.Now().UnixNano())
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
	if err := goose.UpToContext(ctx, db, ".", 47); err != nil {
		t.Fatal(err)
	}
	const (
		orgID       = "00000000-0000-7000-8000-000000004801"
		ownerID     = "00000000-0000-7000-8000-000000004802"
		productID   = "00000000-0000-7000-8000-000000004803"
		workerID    = "00000000-0000-7000-8000-000000004804"
		architectID = "00000000-0000-7000-8000-000000004805"
		sessionOne  = "00000000-0000-7000-8000-000000004806"
		sessionTwo  = "00000000-0000-7000-8000-000000004807"
	)
	seed, err := db.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	for _, statement := range []string{
		`INSERT INTO organizations(id,name,slug) VALUES('` + orgID + `','Migration','migration-48')`,
		`INSERT INTO actors(id,org_id,type,org_role,display_name,handle) VALUES
			('` + ownerID + `','` + orgID + `','user','owner','Owner','m48-owner'),
			('` + productID + `','` + orgID + `','agent','member','Product','m48-product'),
			('` + workerID + `','` + orgID + `','agent','member','Coma runtime','m48-worker')`,
		`INSERT INTO agents(actor_id,org_id,owner_actor_id,kind,allowed_scopes) VALUES('` + productID + `','` + orgID + `','` + ownerID + `','builtin',ARRAY['messages:read'])`,
		`INSERT INTO agents(actor_id,org_id,owner_actor_id,kind,allowed_scopes,system_role) VALUES('` + workerID + `','` + orgID + `','` + ownerID + `','builtin',ARRAY['runtime:worker'],'runtime_worker')`,
		`INSERT INTO agent_usage(id,org_id,agent_id,correlation_id,provider,model,input_tokens,output_tokens,cost,price_source)
			VALUES('00000000-0000-7000-8000-000000004811','` + orgID + `','` + productID + `','00000000-0000-7000-8000-000000004812','openai','gpt-5-mini',10,5,0.001,'configured')`,
	} {
		if _, err := seed.Exec(statement); err != nil {
			t.Fatalf("%v\n%s", err, statement)
		}
	}
	if err := seed.Commit(); err != nil {
		t.Fatal(err)
	}
	before := schemaSnapshot(t, db)

	if err := goose.UpToContext(ctx, db, ".", 48); err != nil {
		t.Fatal(err)
	}
	// What the Architect leaves behind: its system agent, its usage records
	// and conversations, one of them bound to a product agent's draft.
	mustExec(t, db, `INSERT INTO actors(id,org_id,type,org_role,display_name,handle) VALUES($1,$2,'agent','member','Architect','coma_architect')`, architectID, orgID)
	mustExec(t, db, `INSERT INTO agents(actor_id,org_id,owner_actor_id,kind,enabled,allowed_scopes,operational_status,system_role)
		VALUES($1,$2,$3,'builtin',false,ARRAY[]::text[],'draft','architect')`, architectID, orgID, ownerID)
	mustExec(t, db, `INSERT INTO agent_usage(id,org_id,agent_id,correlation_id,provider,model,input_tokens,output_tokens,cost,price_source)
		VALUES('00000000-0000-7000-8000-000000004813',$1,$2,$3,'openai','gpt-5-mini',1000,100,0.0012,'configured')`, orgID, architectID, sessionOne)
	mustExec(t, db, `INSERT INTO agent_architect_sessions(id,org_id,user_id,expires_at) VALUES($1,$2,$3,now()+interval '1 day')`, sessionOne, orgID, ownerID)
	mustExec(t, db, `INSERT INTO agent_architect_calls(id,org_id,user_id,session_id,status,created_at) VALUES('00000000-0000-7000-8000-000000004814',$1,$2,$3,'failed',now())`, orgID, ownerID, sessionOne)
	mustExec(t, db, `INSERT INTO agent_architect_sessions(id,org_id,user_id,agent_id,questions_asked,expires_at) VALUES($1,$2,$3,$4,4,now()+interval '1 day')`, sessionTwo, orgID, ownerID, productID)

	if err := goose.DownToContext(ctx, db, ".", 47); err != nil {
		t.Fatal(err)
	}
	after := schemaSnapshot(t, db)
	if !reflect.DeepEqual(before, after) {
		for key, value := range before {
			if after[key] != value {
				t.Errorf("schema differs at %s:\nbefore %s\nafter  %s", key, value, after[key])
			}
		}
		for key, value := range after {
			if _, exists := before[key]; !exists {
				t.Errorf("schema object left after Down: %s %s", key, value)
			}
		}
	}
	var architects, workers, products, productUsage, architectUsage int
	if err := db.QueryRowContext(ctx, `SELECT
		(SELECT count(*) FROM actors WHERE id=$1),
		(SELECT count(*) FROM agents WHERE actor_id=$2 AND system_role='runtime_worker'),
		(SELECT count(*) FROM agents WHERE actor_id=$3),
		(SELECT count(*) FROM agent_usage WHERE agent_id=$3),
		(SELECT count(*) FROM agent_usage WHERE agent_id=$1)`, architectID, workerID, productID).Scan(&architects, &workers, &products, &productUsage, &architectUsage); err != nil {
		t.Fatal(err)
	}
	if architects != 0 || architectUsage != 0 || workers != 1 || products != 1 || productUsage != 1 {
		t.Fatalf("after Down: architect actors=%d usage=%d, workers=%d products=%d product usage=%d", architects, architectUsage, workers, products, productUsage)
	}
	// Up again from the restored state works.
	if err := goose.UpToContext(ctx, db, ".", 48); err != nil {
		t.Fatal(err)
	}
}
