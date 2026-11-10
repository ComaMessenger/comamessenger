package database

import (
	"context"
	"database/sql"
	"fmt"
	"io/fs"
	"net/url"
	"os"
	"reflect"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/comamessenger/comamessenger/core/internal/database/migrations"
	"github.com/jackc/pgx/v5"
	"github.com/pressly/goose/v3"
)

// builderContractsVersion is the number of the builder contracts migration;
// the test runs against whatever migration precedes it in the tree.
const builderContractsVersion = 49

// previousMigration is the newest migration before version.
func previousMigration(t *testing.T, version int64) int64 {
	t.Helper()
	entries, err := fs.ReadDir(migrations.Files, ".")
	if err != nil {
		t.Fatal(err)
	}
	var previous int64
	for _, entry := range entries {
		number, _, found := strings.Cut(entry.Name(), "_")
		parsed, err := strconv.ParseInt(number, 10, 64)
		if !found || err != nil || !strings.HasSuffix(entry.Name(), ".sql") {
			continue
		}
		if parsed < version && parsed > previous {
			previous = parsed
		}
	}
	return previous
}

// TestBuilderContractsMigration applies every migration before the builder
// contracts with agents, drafts, versions, runs and keys, upgrades, checks that existing agents
// keep the confirmations Core enforced before and gain no chat restriction,
// then verifies that its Down restores the previous schema exactly with rows
// using the new columns present.
func TestBuilderContractsMigration(t *testing.T) {
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
	name := fmt.Sprintf("coma_migration48_%d", time.Now().UnixNano())
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
	previous := previousMigration(t, builderContractsVersion)
	if err := goose.UpToContext(ctx, db, ".", previous); err != nil {
		t.Fatal(err)
	}
	const (
		orgID   = "00000000-0000-7000-8000-000000004801"
		ownerID = "00000000-0000-7000-8000-000000004802"
		agentID = "00000000-0000-7000-8000-000000004803"
		chatID  = "00000000-0000-7000-8000-000000004804"
		runID   = "00000000-0000-7000-8000-000000004805"
		keyID   = "00000000-0000-7000-8000-000000004806"
		hallID  = "00000000-0000-7000-8000-000000004807"
	)
	seed, err := db.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	mustExecTx(t, seed, `INSERT INTO organizations(id,name,slug) VALUES($1,'Migration','migration-48')`, orgID)
	mustExecTx(t, seed, `INSERT INTO actors(id,org_id,type,org_role,display_name,handle) VALUES
		($1,$3,'user','owner','Owner','m48-owner'),($2,$3,'agent','member','Agent','m48-agent')`, ownerID, agentID, orgID)
	mustExecTx(t, seed, `INSERT INTO chats(id,org_id,kind,visibility,name,created_by) VALUES($1,$3,'group','private','Admins',$2),($4,$3,'group','private','Hall',$2)`, chatID, ownerID, orgID, hallID)
	mustExecTx(t, seed, `INSERT INTO agents(actor_id,org_id,owner_actor_id,kind,enabled,allowed_scopes,published_version) VALUES($1,$2,$3,'builtin',true,ARRAY['messages:write'],1)`, agentID, orgID, ownerID)
	mustExecTx(t, seed, `INSERT INTO chat_members(chat_id,actor_id,org_id,role) VALUES($1,$2,$3,'member'),($4,$2,$3,'member'),($1,$5,$3,'owner'),($4,$5,$3,'owner')`, chatID, agentID, orgID, hallID, ownerID)
	mustExecTx(t, seed, `INSERT INTO agent_versions(id,org_id,agent_id,version,config,created_by) VALUES(gen_random_uuid(),$1,$2,1,'{"recipe":"custom"}',$3)`, orgID, agentID, ownerID)
	mustExecTx(t, seed, `INSERT INTO agent_drafts(org_id,agent_id,version,recipe,max_output_tokens,max_tool_iterations,max_chain_depth,per_chat_concurrency,rate_limit_per_minute,provider_rate_limit_per_minute,execution_timeout_seconds,chat_ids,created_by)
		VALUES($1,$2,2,'custom',2048,8,3,1,60,300,600,ARRAY[$3::uuid],$4)`, orgID, agentID, chatID, ownerID)
	mustExecTx(t, seed, `INSERT INTO agent_runs(id,org_id,agent_id,correlation_id,chat_id) VALUES($1,$2,$3,gen_random_uuid(),$4)`, runID, orgID, agentID, chatID)
	mustExecTx(t, seed, `INSERT INTO agent_api_keys(id,org_id,agent_id,name,key_hash,key_prefix,scopes,rate_limit_per_minute,created_by)
		VALUES($1,$2,$3,'runtime',sha256('m48'::bytea),'coma_agent_prefix_48',ARRAY['messages:write'],10,$4)`, keyID, orgID, agentID, ownerID)
	if err := seed.Commit(); err != nil {
		t.Fatal(err)
	}
	before := schemaSnapshot(t, db)

	if err := goose.UpToContext(ctx, db, ".", builderContractsVersion); err != nil {
		t.Fatal(err)
	}
	var postMessage, postCard, tone string
	var readOnly, writeOnly int
	if err := db.QueryRow(`SELECT confirmation_policy->>'post_message',confirmation_policy->>'post_card',tone,cardinality(read_only_chat_ids),cardinality(write_only_chat_ids) FROM agents WHERE actor_id=$1`, agentID).Scan(&postMessage, &postCard, &tone, &readOnly, &writeOnly); err != nil {
		t.Fatal(err)
	}
	if postMessage != "confirm" || postCard != "auto" || tone != "" || readOnly != 0 || writeOnly != 0 {
		t.Fatalf("existing agent after Up: post_message=%s post_card=%s tone=%q readOnly=%d writeOnly=%d", postMessage, postCard, tone, readOnly, writeOnly)
	}
	if err := db.QueryRow(`SELECT confirmation_policy->>'post_message' FROM agent_drafts WHERE agent_id=$1`, agentID).Scan(&postMessage); err != nil || postMessage != "confirm" {
		t.Fatalf("existing draft after Up: post_message=%s err=%v", postMessage, err)
	}
	// Rows using the new columns must not block Down.
	mustExec(t, db, `UPDATE agents SET confirmation_policy='{"post_message":"auto"}',tone='formal',read_only_chat_ids=ARRAY[$2::uuid] WHERE actor_id=$1`, agentID, hallID)
	mustExec(t, db, `UPDATE agent_drafts SET tone='friendly',write_only_chat_ids=ARRAY[$2::uuid] WHERE agent_id=$1`, agentID, chatID)
	mustExec(t, db, `INSERT INTO agent_versions(id,org_id,agent_id,version,config,created_by) VALUES(gen_random_uuid(),$1,$2,2,'{"recipe":"custom","tone":"formal","confirmation_policy":{"post_message":"auto"}}',$3)`, orgID, agentID, ownerID)

	if err := goose.DownToContext(ctx, db, ".", previous); err != nil {
		t.Fatal(err)
	}
	after := schemaSnapshot(t, db)
	if !reflect.DeepEqual(before, after) {
		for key, value := range before {
			if after[key] != value {
				t.Errorf("schema object changed after Down: %s: %q -> %q", key, value, after[key])
			}
		}
		for key, value := range after {
			if _, exists := before[key]; !exists {
				t.Errorf("schema object left after Down: %s %s", key, value)
			}
		}
	}
	var agents, versions, runs, keys int
	if err := db.QueryRow(`SELECT (SELECT count(*) FROM agents),(SELECT count(*) FROM agent_versions),(SELECT count(*) FROM agent_runs),(SELECT count(*) FROM agent_api_keys)`).Scan(&agents, &versions, &runs, &keys); err != nil {
		t.Fatal(err)
	}
	if agents != 1 || versions != 2 || runs != 1 || keys != 1 {
		t.Fatalf("rows after Down agents=%d versions=%d runs=%d keys=%d", agents, versions, runs, keys)
	}
	// An agent restricted to reading some chats would write everywhere under
	// the older schema: Down pauses it instead.
	var enabled bool
	var status string
	if err := db.QueryRow(`SELECT enabled,operational_status FROM agents WHERE actor_id=$1`, agentID).Scan(&enabled, &status); err != nil || enabled || status != "paused" {
		t.Fatalf("restricted agent after Down enabled=%v status=%s err=%v", enabled, status, err)
	}
	if err := goose.UpToContext(ctx, db, ".", builderContractsVersion); err != nil {
		t.Fatalf("Up again after Down: %v", err)
	}
}

func mustExecTx(t *testing.T, tx *sql.Tx, query string, args ...any) {
	t.Helper()
	if _, err := tx.Exec(query, args...); err != nil {
		t.Fatal(err)
	}
}
