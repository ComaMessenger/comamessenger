package agent_test

import (
	"encoding/json"
	"errors"
	"slices"
	"strings"
	"testing"

	"github.com/comamessenger/comamessenger/core/internal/agent"
	"github.com/comamessenger/comamessenger/core/internal/agentconfig"
	"github.com/comamessenger/comamessenger/core/internal/agentrun"
	"github.com/comamessenger/comamessenger/core/internal/agenttrigger"
	"github.com/comamessenger/comamessenger/core/internal/chat"
	"github.com/comamessenger/comamessenger/core/internal/identity"
	"github.com/comamessenger/comamessenger/core/internal/testdb"
)

const (
	systemOrgID     = "00000000-0000-7000-8000-000000000c01"
	systemOwnerID   = "00000000-0000-7000-8000-000000000c02"
	systemChatID    = "00000000-0000-7000-8000-000000000c03"
	systemArchitect = "00000000-0000-7000-8000-000000000c04"
	systemNoVersion = "00000000-0000-7000-8000-000000000c05"
)

// TestSystemAgentsAreNotProductAgents covers every system role (the
// installation runtime worker and the Architect): no product API may
// change, delete, publish, key or trigger them, and they never show up as
// people to find, mention or add to a chat.
func TestSystemAgentsAreNotProductAgents(t *testing.T) {
	pool := testdb.New(t)
	ctx := t.Context()
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	for _, statement := range []string{
		`INSERT INTO organizations(id,name,slug) VALUES('` + systemOrgID + `','System agents','system-agents')`,
		`INSERT INTO actors(id,org_id,type,org_role,display_name,handle) VALUES('` + systemOwnerID + `','` + systemOrgID + `','user','owner','Owner','owner')`,
		`INSERT INTO users(actor_id,org_id,email,password_hash) VALUES('` + systemOwnerID + `','` + systemOrgID + `','owner@example.test','hash')`,
		`INSERT INTO chats(id,org_id,kind,visibility,name,created_by) VALUES('` + systemChatID + `','` + systemOrgID + `','group','private','Зал 1','` + systemOwnerID + `')`,
		`INSERT INTO chat_members(chat_id,actor_id,org_id,role) VALUES('` + systemChatID + `','` + systemOwnerID + `','` + systemOrgID + `','owner')`,
		`INSERT INTO actors(id,org_id,type,org_role,display_name,handle) VALUES('` + systemArchitect + `','` + systemOrgID + `','agent','member','Architect','coma_architect')`,
		`INSERT INTO agents(actor_id,org_id,owner_actor_id,kind,enabled,allowed_scopes,operational_status,system_role,daily_cost_limit)
			VALUES('` + systemArchitect + `','` + systemOrgID + `','` + systemOwnerID + `','builtin',false,ARRAY[]::text[],'draft','architect',5)`,
	} {
		if _, err := tx.Exec(ctx, statement); err != nil {
			t.Fatalf("%v\n%s", err, statement)
		}
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	agents := agent.NewService(pool)
	if ready, err := agents.EnsureRuntimeWorker(ctx, "coma_agent_"+strings.Repeat("w", 43)); err != nil || !ready {
		t.Fatalf("runtime worker ready=%v err=%v", ready, err)
	}
	var workerID string
	if err := pool.QueryRow(ctx, `SELECT actor_id FROM agents WHERE org_id=$1 AND system_role='runtime_worker'`, systemOrgID).Scan(&workerID); err != nil {
		t.Fatal(err)
	}
	owner := identity.User{ActorID: systemOwnerID, OrgID: systemOrgID, OrgRole: "owner"}
	config, err := agentconfig.NewService(pool, "0123456789abcdef0123456789abcdef")
	if err != nil {
		t.Fatal(err)
	}
	triggers := agenttrigger.NewService(pool, nil)
	runs := agentrun.NewService(pool)
	chats := chat.NewService(pool)

	page, err := chats.ListActors(ctx, owner, "", "", 100)
	if err != nil {
		t.Fatal(err)
	}
	for _, actor := range page.Actors {
		if actor.ID == workerID || actor.ID == systemArchitect {
			t.Errorf("people search shows system agent %s (%s)", actor.ID, actor.Handle)
		}
	}
	if found, err := chats.ListActors(ctx, owner, "architect", "", 100); err != nil || len(found.Actors) != 0 {
		t.Errorf("search by handle finds the Architect: %+v err=%v", found.Actors, err)
	}

	for role, systemID := range map[string]string{"runtime_worker": workerID, "architect": systemArchitect} {
		name := "Renamed"
		notFound := func(operation string, err error) {
			t.Helper()
			if !errors.Is(err, agent.ErrNotFound) && !errors.Is(err, agenttrigger.ErrNotFound) && !errors.Is(err, agentconfig.ErrNotFound) && !errors.Is(err, agentrun.ErrNotFound) {
				t.Errorf("%s %s error = %v, want not found", role, operation, err)
			}
		}
		_, err := agents.Update(ctx, owner, systemID, agent.UpdateInput{DisplayName: &name})
		notFound("update", err)
		_, err = agents.Publish(ctx, owner, systemID, agent.PublishOptions{})
		notFound("publish", err)
		_, err = agents.Pause(ctx, owner, systemID)
		notFound("pause", err)
		_, err = agents.Resume(ctx, owner, systemID)
		notFound("resume", err)
		_, err = agents.ResetRecipe(ctx, owner, systemID)
		notFound("reset recipe", err)
		_, err = agents.Rollback(ctx, owner, systemID, systemNoVersion)
		notFound("rollback", err)
		_, err = agents.Duplicate(ctx, owner, systemID, agent.DuplicateInput{DisplayName: "Copy", Handle: "copy_" + role})
		notFound("duplicate", err)
		_, err = agents.CreateKey(ctx, owner, systemID, agent.CreateKeyInput{Name: "stolen", Scopes: []agent.Scope{agent.ScopeMessagesRead}, RateLimitPerMinute: 10})
		notFound("create key", err)
		_, err = agents.ListKeys(ctx, owner, systemID)
		notFound("list keys", err)
		notFound("revoke key", agents.RevokeKey(ctx, owner, systemID, systemNoVersion))
		_, err = agents.Usage(ctx, owner, systemID)
		notFound("usage", err)
		_, err = agents.Versions(ctx, owner, systemID)
		notFound("versions", err)
		_, err = triggers.Create(ctx, owner, systemID, agenttrigger.CreateInput{Type: "manual", Config: json.RawMessage(`{}`)})
		notFound("create trigger", err)
		_, err = triggers.List(ctx, owner, systemID)
		notFound("list triggers", err)
		_, err = config.Credential(ctx, owner, systemID)
		notFound("credential", err)
		_, err = config.ListMCPServers(ctx, owner, systemID)
		notFound("mcp servers", err)
		_, err = runs.List(ctx, owner, systemID)
		notFound("runs", err)

		if _, err := chats.AddMember(ctx, owner, systemChatID, chat.MemberInput{ActorID: systemID, Role: "member"}); err == nil {
			t.Errorf("%s was added to a chat", role)
		}
		if _, err := chats.Create(ctx, owner, chat.CreateInput{Kind: "group", Visibility: "private", Name: "With " + role, MemberIDs: []string{systemID}}); err == nil {
			t.Errorf("a chat was created with %s", role)
		}
		if _, err := chats.Create(ctx, owner, chat.CreateInput{Kind: "direct", MemberIDs: []string{systemID}}); err == nil {
			t.Errorf("a direct chat was opened with %s", role)
		}
		notFound("delete", agents.Delete(ctx, owner, systemID))
	}

	// Both system agents are intact: not deleted, not renamed, limits kept.
	var intact int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM agents agent JOIN actors actor ON actor.id=agent.actor_id
		WHERE agent.actor_id=ANY($1::uuid[]) AND agent.deleted_at IS NULL AND actor.display_name<>'Renamed'
		AND (agent.system_role<>'architect' OR agent.daily_cost_limit=5)`, []string{workerID, systemArchitect}).Scan(&intact); err != nil || intact != 2 {
		t.Fatalf("intact system agents = %d, err=%v", intact, err)
	}
	var keys int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM agent_api_keys WHERE agent_id=ANY($1::uuid[]) AND name='stolen'`, []string{workerID, systemArchitect}).Scan(&keys); err != nil || keys != 0 {
		t.Fatalf("keys issued to system agents = %d, err=%v", keys, err)
	}
	var members []string
	rows, err := pool.Query(ctx, `SELECT actor_id::text FROM chat_members WHERE org_id=$1`, systemOrgID)
	if err != nil {
		t.Fatal(err)
	}
	for rows.Next() {
		var id string
		_ = rows.Scan(&id)
		members = append(members, id)
	}
	rows.Close()
	if slices.Contains(members, workerID) || slices.Contains(members, systemArchitect) {
		t.Fatalf("system agents are chat members: %v", members)
	}
}
