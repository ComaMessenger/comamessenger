package agenttool

import (
	"encoding/json"
	"errors"
	"testing"
	"time"

	"github.com/comamessenger/comamessenger/core/internal/access"
	"github.com/comamessenger/comamessenger/core/internal/agentmemory"
	"github.com/comamessenger/comamessenger/core/internal/chat"
	"github.com/comamessenger/comamessenger/core/internal/files"
	"github.com/comamessenger/comamessenger/core/internal/identity"
	"github.com/comamessenger/comamessenger/core/internal/message"
	"github.com/comamessenger/comamessenger/core/internal/search"
	"github.com/comamessenger/comamessenger/core/internal/testdb"
	"github.com/google/uuid"
)

func TestWriteToolRequiresServerConfirmation(t *testing.T) {
	pool := testdb.New(t)
	orgID, ownerID, agentID, runID, leaseToken, correlationID := uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString()
	tx, err := pool.Begin(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(t.Context())
	if _, err := tx.Exec(t.Context(), `INSERT INTO organizations(id,name,slug) VALUES($1::uuid,'Confirmation','confirmation-' || substr($1::text,1,8))`, orgID); err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(t.Context(), `INSERT INTO actors(id,org_id,type,org_role,display_name,handle) VALUES
		($1::uuid,$3::uuid,'user','owner','Owner','owner_' || substr($1::text,1,8)),
		($2::uuid,$3::uuid,'agent','member','Agent','agent_' || substr($2::text,1,8))`, ownerID, agentID, orgID); err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(t.Context(), `INSERT INTO agents(actor_id,org_id,owner_actor_id,kind,enabled,allowed_scopes) VALUES($1,$2,$3,'builtin',true,ARRAY['memory:write','runtime:execute'])`, agentID, orgID, ownerID); err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(t.Context(), `INSERT INTO agent_runs(id,org_id,agent_id,correlation_id,status,lease_token,lease_expires_at,started_at,timeout_at) VALUES($1,$2,$3,$4,'running',$5,now()+interval '1 minute',now(),now()+interval '5 minutes')`, runID, orgID, agentID, correlationID, leaseToken); err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(t.Context()); err != nil {
		t.Fatal(err)
	}
	executor, err := NewExecutor(pool, Services{Chats: &chat.Service{}, Messages: &message.Service{}, Search: &search.Service{}, Files: &files.Service{}, Memory: agentmemory.NewService(pool)}, true)
	if err != nil {
		t.Fatal(err)
	}
	agentUser := identity.User{ActorID: agentID, OrgID: orgID}
	authentication := access.Identity{AuthenticationKind: "api_key", ActorID: agentID, OrgID: orgID, KeyID: uuid.NewString(), Scopes: []string{"runtime:execute", "memory:write"}}
	arguments := json.RawMessage(`{"namespace":"test","key":"decision","value":{"approved":true}}`)
	result, err := executor.Invoke(t.Context(), Invocation{User: agentUser, Identity: authentication, Name: "remember", Arguments: arguments, RunID: runID, LeaseToken: leaseToken, CorrelationID: correlationID, ToolCallID: uuid.NewString()})
	if err != nil || result.Confirmation == nil || result.Output != nil {
		t.Fatalf("invoke result=%+v err=%v", result, err)
	}
	var memoryCount int
	if err := pool.QueryRow(t.Context(), `SELECT count(*) FROM agent_memory WHERE agent_id=$1`, agentID).Scan(&memoryCount); err != nil || memoryCount != 0 {
		t.Fatalf("write executed before confirmation: count=%d err=%v", memoryCount, err)
	}
	owner := identity.User{ActorID: ownerID, OrgID: orgID, OrgRole: "owner"}
	pending, err := executor.ListConfirmations(t.Context(), owner, "pending")
	if err != nil || len(pending) != 1 || pending[0].ID != result.Confirmation.ID {
		t.Fatalf("pending=%+v err=%v", pending, err)
	}
	approved, err := executor.DecideConfirmation(t.Context(), owner, result.Confirmation.ID, true)
	if err != nil || approved.Status != "completed" || approved.CompletedAt == nil || approved.CompletedAt.After(time.Now().Add(time.Second)) {
		t.Fatalf("approved=%+v err=%v", approved, err)
	}
	if err := pool.QueryRow(t.Context(), `SELECT count(*) FROM agent_memory WHERE agent_id=$1 AND namespace='test' AND key='decision'`, agentID).Scan(&memoryCount); err != nil || memoryCount != 1 {
		t.Fatalf("approved write count=%d err=%v", memoryCount, err)
	}
	if _, err := executor.DecideConfirmation(t.Context(), owner, result.Confirmation.ID, true); !errors.Is(err, ErrConfirmationConflict) {
		t.Fatalf("second decision error=%v", err)
	}
}
