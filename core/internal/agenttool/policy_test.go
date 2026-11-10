package agenttool

import (
	"encoding/json"
	"errors"
	"testing"

	"github.com/comamessenger/comamessenger/core/internal/access"
	"github.com/comamessenger/comamessenger/core/internal/agentmemory"
	"github.com/comamessenger/comamessenger/core/internal/chat"
	"github.com/comamessenger/comamessenger/core/internal/files"
	"github.com/comamessenger/comamessenger/core/internal/identity"
	"github.com/comamessenger/comamessenger/core/internal/interactive"
	"github.com/comamessenger/comamessenger/core/internal/message"
	"github.com/comamessenger/comamessenger/core/internal/search"
	"github.com/comamessenger/comamessenger/core/internal/testdb"
	"github.com/google/uuid"
)

// TestAgentVersionDecidesConfirmationAndChatRoles covers the per-agent
// confirmation policy (auto, confirm, server floor), the continuation run
// that carries an approved result back to the agent, and the read-only and
// write-only chat roles checked on every tool call.
func TestAgentVersionDecidesConfirmationAndChatRoles(t *testing.T) {
	pool := testdb.New(t)
	orgID, ownerID, agentID, runID, leaseToken, correlationID := uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString()
	readChat, writeChat := uuid.NewString(), uuid.NewString()
	statements := []struct {
		query string
		args  []any
	}{
		{`INSERT INTO organizations(id,name,slug) VALUES($1::uuid,'Policy','policy-' || substr($1::text,1,8))`, []any{orgID}},
		{`INSERT INTO actors(id,org_id,type,org_role,display_name,handle) VALUES
			($1::uuid,$3::uuid,'user','owner','Owner','owner_' || substr($1::text,1,8)),
			($2::uuid,$3::uuid,'agent','member','Agent','agent_' || substr($2::text,1,8))`, []any{ownerID, agentID, orgID}},
		{`INSERT INTO chats(id,org_id,kind,visibility,name,created_by) VALUES($1,$3,'group','private','Hall',$4),($2,$3,'group','private','Admins',$4)`, []any{readChat, writeChat, orgID, ownerID}},
		{`INSERT INTO chat_members(chat_id,actor_id,org_id,role) VALUES($1,$3,$4,'member'),($2,$3,$4,'member'),($1,$5,$4,'owner'),($2,$5,$4,'owner')`, []any{readChat, writeChat, agentID, orgID, ownerID}},
		// remember runs by itself, reactions are on the server floor.
		{`INSERT INTO agents(actor_id,org_id,owner_actor_id,kind,enabled,allowed_scopes,published_version,confirmation_policy,read_only_chat_ids,write_only_chat_ids)
			VALUES($1,$2,$3,'builtin',true,ARRAY['memory:write','messages:read','messages:write','reactions:write','runtime:execute'],1,
			'{"remember":"auto","add_reaction":"auto"}',ARRAY[$4::uuid],ARRAY[$5::uuid])`, []any{agentID, orgID, ownerID, readChat, writeChat}},
		{`INSERT INTO agent_runs(id,org_id,agent_id,correlation_id,status,lease_token,lease_expires_at,started_at,timeout_at,chat_id)
			VALUES($1,$2,$3,$4,'running',$5,now()+interval '1 minute',now(),now()+interval '5 minutes',$6)`, []any{runID, orgID, agentID, correlationID, leaseToken, writeChat}},
	}
	tx, err := pool.Begin(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	for _, statement := range statements {
		if _, err := tx.Exec(t.Context(), statement.query, statement.args...); err != nil {
			t.Fatal(err)
		}
	}
	if err := tx.Commit(t.Context()); err != nil {
		t.Fatal(err)
	}
	executor, err := NewExecutor(pool, Services{Chats: &chat.Service{}, Messages: &message.Service{}, Search: &search.Service{}, Files: &files.Service{},
		Memory: agentmemory.NewService(pool), Interactive: interactive.NewService(pool, nil, nil, nil, interactive.DefaultLimits())}, true)
	if err != nil {
		t.Fatal(err)
	}
	executor.SetConfirmationFloor(map[string]bool{"add_reaction": true})
	agentUser := identity.User{ActorID: agentID, OrgID: orgID}
	authentication := access.Identity{AuthenticationKind: "api_key", ActorID: agentID, OrgID: orgID, KeyID: uuid.NewString(), Scopes: []string{"runtime:execute", "memory:write", "messages:read", "messages:write", "reactions:write"}}
	invoke := func(name, arguments string) (InvokeResult, error) {
		return executor.Invoke(t.Context(), Invocation{User: agentUser, Identity: authentication, Name: name, Arguments: json.RawMessage(arguments),
			RunID: runID, LeaseToken: leaseToken, CorrelationID: correlationID, ToolCallID: uuid.NewString()})
	}

	// "auto": the write runs without a person.
	result, err := invoke("remember", `{"namespace":"slots","key":"hall","value":{"ok":true}}`)
	if err != nil || result.Confirmation != nil || result.Output == nil {
		t.Fatalf("auto remember result=%+v err=%v", result, err)
	}
	// The server floor wins over the agent's "auto".
	var messageID string
	if err := pool.QueryRow(t.Context(), `INSERT INTO messages(id,org_id,chat_id,actor_id,client_msg_id,create_fingerprint,body,created_seq)
		VALUES(gen_random_uuid(),$1,$2,$3,gen_random_uuid(),decode(repeat('00', 32), 'hex'),'hi',1) RETURNING id::text`, orgID, writeChat, ownerID).Scan(&messageID); err != nil {
		t.Fatal(err)
	}
	result, err = invoke("add_reaction", `{"message_id":"`+messageID+`","emoji":"👍"}`)
	if err != nil || result.Confirmation == nil {
		t.Fatalf("floor reaction result=%+v err=%v", result, err)
	}

	// Chat roles: no posting where the agent only reads, no reading where it
	// only writes.
	clientID := uuid.NewString()
	if _, err := invoke("post_message", `{"chat_id":"`+readChat+`","client_msg_id":"`+clientID+`","body":"x"}`); !errors.Is(err, ErrForbidden) {
		t.Fatalf("post to read-only chat error = %v", err)
	}
	if _, err := invoke("get_chat_messages", `{"chat_id":"`+writeChat+`"}`); !errors.Is(err, ErrForbidden) {
		t.Fatalf("read of write-only chat error = %v", err)
	}
	if _, err := invoke("get_thread", `{"message_id":"`+messageID+`"}`); !errors.Is(err, ErrForbidden) {
		t.Fatalf("thread of write-only chat error = %v", err)
	}

	// "confirm" (the stored policy changes, so the next call waits); the
	// approved result comes back to the agent as a continuation run.
	if _, err := pool.Exec(t.Context(), `UPDATE agents SET confirmation_policy='{"remember":"confirm"}' WHERE actor_id=$1`, agentID); err != nil {
		t.Fatal(err)
	}
	result, err = invoke("remember", `{"namespace":"slots","key":"decision","value":{"assigned":"Igor"}}`)
	if err != nil || result.Confirmation == nil {
		t.Fatalf("confirm remember result=%+v err=%v", result, err)
	}
	owner := identity.User{ActorID: ownerID, OrgID: orgID, OrgRole: "owner"}
	approved, err := executor.DecideConfirmation(t.Context(), owner, result.Confirmation.ID, true)
	if err != nil || approved.Status != "completed" {
		t.Fatalf("approved=%+v err=%v", approved, err)
	}
	var input map[string]any
	var chatID string
	if err := pool.QueryRow(t.Context(), `SELECT input,chat_id::text FROM agent_runs WHERE agent_id=$1 AND input->>'trigger_type'='confirmation'`, agentID).Scan(&input, &chatID); err != nil {
		t.Fatalf("continuation run: %v", err)
	}
	if input["confirmation_id"] != approved.ID || input["status"] != "completed" || input["tool_name"] != "remember" || input["result_summary"] == nil || input["result"] != nil || chatID != writeChat || input["original_run_id"] != runID {
		t.Fatalf("continuation input=%v chat=%s", input, chatID)
	}
}
