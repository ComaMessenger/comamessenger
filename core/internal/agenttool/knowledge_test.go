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
	"github.com/comamessenger/comamessenger/core/internal/knowledge"
	"github.com/comamessenger/comamessenger/core/internal/message"
	"github.com/comamessenger/comamessenger/core/internal/search"
	"github.com/comamessenger/comamessenger/core/internal/testdb"
	"github.com/google/uuid"
)

func TestSearchKnowledgeRequiresScopeAndRecordsIssuedFragments(t *testing.T) {
	pool := testdb.New(t)
	orgID, ownerID, agentID, runID, leaseToken := uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString()
	tx, err := pool.Begin(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(t.Context())
	for _, statement := range []struct {
		sql  string
		args []any
	}{
		{`INSERT INTO organizations(id,name,slug) VALUES($1,'Knowledge','knowledge')`, []any{orgID}},
		{`INSERT INTO actors(id,org_id,type,org_role,display_name,handle) VALUES($1,$3,'user','owner','Owner','owner'),($2,$3,'agent','member','Agent','agent')`, []any{ownerID, agentID, orgID}},
		{`INSERT INTO agents(actor_id,org_id,owner_actor_id,kind,enabled,allowed_scopes) VALUES($1,$2,$3,'builtin',true,ARRAY['runtime:execute'])`, []any{agentID, orgID, ownerID}},
		{`INSERT INTO agent_runs(id,org_id,agent_id,correlation_id,status,lease_token,lease_expires_at,started_at,timeout_at) VALUES($1,$2,$3,$4,'running',$5,now()+interval '1 minute',now(),now()+interval '5 minutes')`, []any{runID, orgID, agentID, uuid.NewString(), leaseToken}},
	} {
		if _, err := tx.Exec(t.Context(), statement.sql, statement.args...); err != nil {
			t.Fatal(err)
		}
	}
	if err := tx.Commit(t.Context()); err != nil {
		t.Fatal(err)
	}
	knowledgeService := knowledge.NewService(pool, nil, nil, nil)
	owner := identity.User{ActorID: ownerID, OrgID: orgID, OrgRole: "owner"}
	collection, err := knowledgeService.CreateCollection(t.Context(), owner, knowledge.CreateCollectionInput{Name: "Регламенты"})
	if err != nil {
		t.Fatal(err)
	}
	document, err := knowledgeService.CreateDocument(t.Context(), owner, collection.ID, knowledge.CreateDocumentInput{Kind: "page", Title: "Пропуска", Body: "# Пропуска\n\nПропуск выдаёт администратор."})
	if err != nil {
		t.Fatal(err)
	}
	if err := knowledgeService.IndexDocument(t.Context(), document.ID, 1); err != nil {
		t.Fatal(err)
	}
	executor, err := NewExecutor(pool, Services{Chats: &chat.Service{}, Messages: &message.Service{}, Search: &search.Service{}, Files: &files.Service{}, Memory: agentmemory.NewService(pool), Knowledge: knowledgeService}, true)
	if err != nil {
		t.Fatal(err)
	}
	invocation := Invocation{
		User:     identity.User{ActorID: agentID, OrgID: orgID},
		Identity: access.Identity{AuthenticationKind: "api_key", ActorID: agentID, OrgID: orgID, KeyID: uuid.NewString(), Scopes: []string{"runtime:execute", "knowledge:read"}},
		Name:     "search_knowledge", Arguments: json.RawMessage(`{"query":"пропуск"}`),
		RunID: runID, LeaseToken: leaseToken, CorrelationID: uuid.NewString(), ToolCallID: uuid.NewString(),
	}
	if _, err := executor.Invoke(t.Context(), invocation); !errors.Is(err, ErrForbidden) {
		t.Fatalf("invoke without knowledge:read on the agent = %v", err)
	}
	if _, err := pool.Exec(t.Context(), `UPDATE agents SET allowed_scopes=ARRAY['runtime:execute','knowledge:read'],knowledge_collection_ids=ARRAY[$2::uuid] WHERE actor_id=$1`, agentID, collection.ID); err != nil {
		t.Fatal(err)
	}
	result, err := executor.Invoke(t.Context(), invocation)
	if err != nil || result.Confirmation != nil {
		t.Fatalf("invoke result = %+v, err = %v", result, err)
	}
	var output struct {
		Found     bool `json:"found"`
		Fragments []struct {
			ChunkID       string `json:"chunk_id"`
			DocumentTitle string `json:"document_title"`
			Section       string `json:"section"`
			Text          string `json:"text"`
		} `json:"fragments"`
	}
	if err := json.Unmarshal(result.Output, &output); err != nil || !output.Found || len(output.Fragments) != 1 ||
		output.Fragments[0].DocumentTitle != "Пропуска" || output.Fragments[0].Section != "Пропуска" || output.Fragments[0].Text != "Пропуск выдаёт администратор." {
		t.Fatalf("output = %s, err = %v", result.Output, err)
	}
	var recorded int
	if err := pool.QueryRow(t.Context(), `SELECT count(*) FROM agent_run_knowledge_chunks issued
		JOIN agent_tool_calls call ON call.id=issued.tool_call_id AND call.tool_name='search_knowledge' AND call.status='completed'
		WHERE issued.run_id=$1 AND issued.chunk_id=$2`, runID, output.Fragments[0].ChunkID).Scan(&recorded); err != nil || recorded != 1 {
		t.Fatalf("recorded fragments = %d, err = %v", recorded, err)
	}
}
