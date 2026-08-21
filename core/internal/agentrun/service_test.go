package agentrun_test

import (
	"bytes"
	"encoding/json"
	"errors"
	"testing"

	"github.com/comamessenger/comamessenger/core/internal/access"
	"github.com/comamessenger/comamessenger/core/internal/agent"
	"github.com/comamessenger/comamessenger/core/internal/agentrun"
	"github.com/comamessenger/comamessenger/core/internal/id"
	"github.com/comamessenger/comamessenger/core/internal/identity"
	"github.com/comamessenger/comamessenger/core/internal/testdb"
	"github.com/jackc/pgx/v5/pgxpool"
)

const (
	runTestOrgID   = "00000000-0000-7000-8000-000000000281"
	runTestOwnerID = "00000000-0000-7000-8000-000000000282"
	runTestChatID  = "00000000-0000-7000-8000-000000000283"
)

func TestAgentWorkerLeaseAndCheckpointContract(t *testing.T) {
	pool := testdb.New(t)
	seedRunWorkerModel(t, pool)
	owner := identity.User{ActorID: runTestOwnerID, OrgID: runTestOrgID, OrgRole: "owner"}
	agents := agent.NewService(pool)
	created, err := agents.Create(t.Context(), owner, agent.CreateInput{
		DisplayName: "Runtime", Handle: "runtime", Kind: "builtin", Enabled: true,
		AllowedScopes: []agent.Scope{agent.ScopeMessagesRead, agent.ScopeMessagesWrite}, ChatIDs: []string{runTestChatID},
		Provider: "openai", Model: "test", ExternalDataSharingApproved: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	key, err := agents.CreateKey(t.Context(), owner, created.ID, agent.CreateKeyInput{
		Name: "worker", Scopes: []agent.Scope{agent.ScopeMessagesRead, agent.ScopeMessagesWrite}, RateLimitPerMinute: 100,
	})
	if err != nil {
		t.Fatal(err)
	}
	agentUser, authentication, err := agents.AuthenticateKey(t.Context(), key.Secret)
	if err != nil {
		t.Fatal(err)
	}
	service := agentrun.NewService(pool)
	invoked, err := service.Invoke(t.Context(), owner, created.ID, agentrun.InvokeInput{
		ChatID: runTestChatID, ClientRunID: mustRunID(t), Input: json.RawMessage(`{"prompt":"hello"}`),
	})
	if err != nil {
		t.Fatal(err)
	}
	workerID := mustRunID(t)
	claimed, err := service.ClaimForAgent(t.Context(), agentUser, authentication, agentrun.ClaimInput{WorkerID: workerID, LeaseSeconds: 30})
	if err != nil {
		t.Fatal(err)
	}
	if claimed.ID != invoked.ID || claimed.LeaseToken == "" || claimed.AgentID != created.ID {
		t.Fatalf("claimed run = %+v", claimed)
	}
	adminJSON, err := json.Marshal(claimed.Run)
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(adminJSON, []byte(claimed.LeaseToken)) || bytes.Contains(adminJSON, []byte("lease_token")) {
		t.Fatalf("ordinary run leaked lease capability: %s", adminJSON)
	}
	if _, err := service.HeartbeatForAgent(t.Context(), agentUser, authentication, invoked.ID, agentrun.LeaseInput{
		LeaseToken: claimed.LeaseToken, LeaseSeconds: 45,
	}); err != nil {
		t.Fatal(err)
	}
	completed, err := service.CompleteForAgent(t.Context(), agentUser, authentication, invoked.ID, agentrun.RuntimeCompletion{
		LeaseToken: claimed.LeaseToken, InputTokens: 10, OutputTokens: 5, Cost: "0.01000000", Currency: "USD",
		ResultSummary: json.RawMessage(`{"message_id":"00000000-0000-7000-8000-000000000299"}`), PriceSource: "provider",
	})
	if err != nil || completed.Status != "completed" {
		t.Fatalf("completed run = %+v, err=%v", completed, err)
	}
	var usageCount int
	if err := pool.QueryRow(t.Context(), `SELECT count(*) FROM agent_usage WHERE run_id=$1 AND price_source='provider'`, invoked.ID).Scan(&usageCount); err != nil || usageCount != 1 {
		t.Fatalf("usage count = %d, err=%v", usageCount, err)
	}
	if _, err := service.ClaimForAgent(t.Context(), owner, access.Identity{}, agentrun.ClaimInput{WorkerID: workerID}); !errors.Is(err, agentrun.ErrForbidden) {
		t.Fatalf("human worker claim error = %v", err)
	}

	checkpoint, err := service.GetRuntimeCheckpoint(t.Context(), agentUser, authentication, "builtin-runtime")
	if err != nil || checkpoint.LastEventSeq != 0 {
		t.Fatalf("initial checkpoint = %+v, err=%v", checkpoint, err)
	}
	if _, err := pool.Exec(t.Context(), `UPDATE organizations SET event_seq=5 WHERE id=$1`, runTestOrgID); err != nil {
		t.Fatal(err)
	}
	checkpoint, err = service.UpdateRuntimeCheckpoint(t.Context(), agentUser, authentication, "builtin-runtime", agentrun.UpdateRuntimeCheckpoint{LastEventSeq: 3})
	if err != nil || checkpoint.LastEventSeq != 3 {
		t.Fatalf("updated checkpoint = %+v, err=%v", checkpoint, err)
	}
	checkpoint, err = service.UpdateRuntimeCheckpoint(t.Context(), agentUser, authentication, "builtin-runtime", agentrun.UpdateRuntimeCheckpoint{LastEventSeq: 2})
	if err != nil || checkpoint.LastEventSeq != 3 {
		t.Fatalf("rewound checkpoint = %+v, err=%v", checkpoint, err)
	}
	if _, err := service.UpdateRuntimeCheckpoint(t.Context(), agentUser, authentication, "builtin-runtime", agentrun.UpdateRuntimeCheckpoint{LastEventSeq: 6}); !errors.Is(err, agentrun.ErrInvalid) {
		t.Fatalf("future checkpoint error = %v", err)
	}
}

func seedRunWorkerModel(t *testing.T, pool *pgxpool.Pool) {
	t.Helper()
	tx, err := pool.Begin(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(t.Context())
	if _, err := tx.Exec(t.Context(), `INSERT INTO organizations(id,name,slug) VALUES($1,'Runtime model','runtime-model')`, runTestOrgID); err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(t.Context(), `INSERT INTO actors(id,org_id,type,org_role,display_name,handle)
		VALUES($1,$2,'user','owner','Owner','owner')`, runTestOwnerID, runTestOrgID); err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(t.Context(), `INSERT INTO users(actor_id,org_id,email,password_hash)
		VALUES($1,$2,'runtime-owner@example.test','hash')`, runTestOwnerID, runTestOrgID); err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(t.Context(), `INSERT INTO chats(id,org_id,kind,visibility,name,created_by)
		VALUES($1,$2,'group','private','Runtime chat',$3)`, runTestChatID, runTestOrgID, runTestOwnerID); err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(t.Context(), `INSERT INTO chat_members(chat_id,actor_id,org_id,role)
		VALUES($1,$2,$3,'owner')`, runTestChatID, runTestOwnerID, runTestOrgID); err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(t.Context()); err != nil {
		t.Fatal(err)
	}
}

func mustRunID(t *testing.T) string {
	t.Helper()
	value, err := id.New()
	if err != nil {
		t.Fatal(err)
	}
	return value
}
