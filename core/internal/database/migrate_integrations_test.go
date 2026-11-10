package database

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"net/url"
	"os"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/comamessenger/comamessenger/core/internal/database/migrations"
	"github.com/jackc/pgx/v5"
	_ "github.com/jackc/pgx/v5/stdlib"
	"github.com/pressly/goose/v3"
)

// TestWorkspaceIntegrationsMigration applies 00001→00046 with legacy
// per-agent MCP servers, upgrades to 00047, checks the copied connections and
// bindings, then verifies that Down 00047 restores the 00046 schema exactly
// and does not fail on rows created by the new features.
func TestWorkspaceIntegrationsMigration(t *testing.T) {
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
	if err := goose.UpToContext(ctx, db, ".", 46); err != nil {
		t.Fatal(err)
	}
	const (
		orgID     = "00000000-0000-7000-8000-000000004701"
		ownerID   = "00000000-0000-7000-8000-000000004702"
		agentOne  = "00000000-0000-7000-8000-000000004703"
		agentTwo  = "00000000-0000-7000-8000-000000004704"
		serverOne = "00000000-0000-7000-8000-000000004705"
		serverTwo = "00000000-0000-7000-8000-000000004706"
	)
	seed, err := db.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := seed.Exec(`INSERT INTO organizations(id,name,slug) VALUES($1,'Migration','migration-47')`, orgID); err != nil {
		t.Fatal(err)
	}
	if _, err := seed.Exec(`INSERT INTO actors(id,org_id,type,org_role,display_name,handle) VALUES
		($1,$4,'user','owner','Owner','m47-owner'),($2,$4,'agent','member','One','m47-one'),($3,$4,'agent','member','Two','m47-two')`, ownerID, agentOne, agentTwo, orgID); err != nil {
		t.Fatal(err)
	}
	if err := seed.Commit(); err != nil {
		t.Fatal(err)
	}
	mustExec(t, db, `INSERT INTO agents(actor_id,org_id,owner_actor_id,kind) VALUES($1,$3,$4,'builtin'),($2,$3,$4,'builtin')`, agentOne, agentTwo, orgID, ownerID)
	mustExec(t, db, `INSERT INTO agent_drafts(org_id,agent_id,version,recipe,max_output_tokens,max_tool_iterations,max_chain_depth,per_chat_concurrency,
		rate_limit_per_minute,provider_rate_limit_per_minute,execution_timeout_seconds,created_by)
		VALUES($1,$2,2,'custom',1000,4,1,1,60,60,120,$3)`, orgID, agentTwo, ownerID)
	// Both agents use the name "crm": unique per agent before 00047.
	mustExec(t, db, `INSERT INTO agent_mcp_servers(id,org_id,agent_id,name,endpoint_url,enabled,allowed_tools,encrypted_headers,require_write_confirmation,created_at)
		VALUES($1,$3,$4,'crm','https://crm.example.com/mcp',true,'{get_slots}','\x0102'::bytea,true,now()-interval '1 day'),
		      ($2,$3,$5,'crm','https://crm2.example.com/mcp',false,'{get_slots,assign}',NULL,false,now())`, serverOne, serverTwo, orgID, agentOne, agentTwo)
	before := schemaSnapshot(t, db)
	legacyBefore := legacyServers(t, db)

	if err := goose.UpToContext(ctx, db, ".", 47); err != nil {
		t.Fatal(err)
	}
	type connection struct {
		ID, Name, Endpoint string
		Enabled            bool
		Legacy             string
		Headers            []byte
	}
	rows, err := db.QueryContext(ctx, `SELECT id::text,name,endpoint_url,enabled,legacy_agent_id::text,encrypted_headers FROM integration_mcp_connections ORDER BY created_at`)
	if err != nil {
		t.Fatal(err)
	}
	var connections []connection
	for rows.Next() {
		var item connection
		if err := rows.Scan(&item.ID, &item.Name, &item.Endpoint, &item.Enabled, &item.Legacy, &item.Headers); err != nil {
			t.Fatal(err)
		}
		connections = append(connections, item)
	}
	rows.Close()
	if len(connections) != 2 || connections[0].ID != serverOne || connections[0].Name != "crm" || connections[0].Legacy != agentOne ||
		string(connections[0].Headers) != "\x01\x02" || !connections[0].Enabled {
		t.Fatalf("migrated connections = %+v", connections)
	}
	if connections[1].ID != serverTwo || connections[1].Name == "crm" || !strings.HasPrefix(connections[1].Name, "crm-") || connections[1].Enabled || connections[1].Headers != nil {
		t.Fatalf("duplicate name was not made unique: %+v", connections[1])
	}
	var publishedOne, publishedTwo, draftTwo []byte
	if err := db.QueryRowContext(ctx, `SELECT (SELECT mcp_bindings FROM agents WHERE actor_id=$1),(SELECT mcp_bindings FROM agents WHERE actor_id=$2),
		(SELECT mcp_bindings FROM agent_drafts WHERE agent_id=$2)`, agentOne, agentTwo).Scan(&publishedOne, &publishedTwo, &draftTwo); err != nil {
		t.Fatal(err)
	}
	assertBindings(t, publishedOne, []map[string]any{{"connection_id": serverOne, "allowed_tools": []any{"get_slots"}, "require_write_confirmation": true}})
	expectedTwo := []map[string]any{{"connection_id": serverTwo, "allowed_tools": []any{"get_slots", "assign"}, "require_write_confirmation": false}}
	assertBindings(t, publishedTwo, expectedTwo)
	assertBindings(t, draftTwo, expectedTwo)

	// Rows created by the new features must not block Down.
	mustExec(t, db, `INSERT INTO integration_webhooks(id,org_id,name,secret_nonce,secret_ciphertext,secret_hint,created_by,updated_by)
		VALUES('00000000-0000-7000-8000-000000004707',$1,'Учёт','\x000000000000000000000000'::bytea,'\x00000000000000000000000000000000'::bytea,'whs_••••',$2,$2)`, orgID, ownerID)
	mustExec(t, db, `INSERT INTO integration_webhook_deliveries(id,org_id,webhook_id,delivery_id,status) VALUES('00000000-0000-7000-8000-000000004708',$1,'00000000-0000-7000-8000-000000004707','d1','accepted')`, orgID)
	mustExec(t, db, `INSERT INTO agent_triggers(id,org_id,agent_id,type,config) VALUES('00000000-0000-7000-8000-000000004709',$1,$2,'webhook','{"webhook_id":"00000000-0000-7000-8000-000000004707"}')`, orgID, agentOne)
	mustExec(t, db, `INSERT INTO agent_triggers(id,org_id,agent_id,type,config) VALUES('00000000-0000-7000-8000-000000004710',$1,$2,'manual','{}')`, orgID, agentOne)

	if err := goose.DownToContext(ctx, db, ".", 46); err != nil {
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
	if legacy := legacyServers(t, db); !reflect.DeepEqual(legacy, legacyBefore) {
		t.Fatalf("agent_mcp_servers changed: before %v after %v", legacyBefore, legacy)
	}
	var triggers int
	if err := db.QueryRowContext(ctx, `SELECT count(*) FROM agent_triggers WHERE agent_id=$1`, agentOne).Scan(&triggers); err != nil || triggers != 1 {
		t.Fatalf("triggers after Down = %d, err=%v", triggers, err)
	}
	// Up again from the restored state works.
	if err := goose.UpToContext(ctx, db, ".", 47); err != nil {
		t.Fatal(err)
	}
}

func mustExec(t *testing.T, db *sql.DB, query string, args ...any) {
	t.Helper()
	if _, err := db.Exec(query, args...); err != nil {
		t.Fatalf("%v\n%s", err, query)
	}
}

func assertBindings(t *testing.T, raw []byte, expected []map[string]any) {
	t.Helper()
	var actual []map[string]any
	if err := json.Unmarshal(raw, &actual); err != nil {
		t.Fatal(err)
	}
	encodedExpected, _ := json.Marshal(expected)
	var normalized []map[string]any
	_ = json.Unmarshal(encodedExpected, &normalized)
	if !reflect.DeepEqual(actual, normalized) {
		t.Fatalf("bindings = %s, want %s", raw, encodedExpected)
	}
}

func legacyServers(t *testing.T, db *sql.DB) []string {
	t.Helper()
	rows, err := db.Query(`SELECT row_to_json(server)::text FROM agent_mcp_servers server ORDER BY id`)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var result []string
	for rows.Next() {
		var value string
		if err := rows.Scan(&value); err != nil {
			t.Fatal(err)
		}
		result = append(result, value)
	}
	return result
}

// schemaSnapshot captures columns, constraints and indexes of the public
// schema, keyed by object so that a difference names the culprit.
func schemaSnapshot(t *testing.T, db *sql.DB) map[string]string {
	t.Helper()
	queries := []string{
		`SELECT 'column ' || table_name || '.' || column_name, data_type || ' ' || is_nullable || ' ' || COALESCE(column_default,'')
		 FROM information_schema.columns WHERE table_schema='public'`,
		`SELECT 'constraint ' || conrelid::regclass::text || '.' || conname, pg_get_constraintdef(oid)
		 FROM pg_constraint WHERE connamespace='public'::regnamespace`,
		`SELECT 'index ' || indexname, indexdef FROM pg_indexes WHERE schemaname='public'`,
		`SELECT 'function ' || proname, md5(prosrc) FROM pg_proc WHERE pronamespace='public'::regnamespace`,
	}
	result := map[string]string{}
	for _, query := range queries {
		rows, err := db.Query(query)
		if err != nil {
			t.Fatal(err)
		}
		for rows.Next() {
			var key, value string
			if err := rows.Scan(&key, &value); err != nil {
				t.Fatal(err)
			}
			result[key] = value
		}
		rows.Close()
	}
	return result
}
