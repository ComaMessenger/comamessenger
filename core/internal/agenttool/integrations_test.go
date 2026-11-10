package agenttool

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/comamessenger/comamessenger/core/internal/access"
	"github.com/comamessenger/comamessenger/core/internal/agent"
	"github.com/comamessenger/comamessenger/core/internal/agentconfig"
	"github.com/comamessenger/comamessenger/core/internal/agentmemory"
	"github.com/comamessenger/comamessenger/core/internal/agentrun"
	"github.com/comamessenger/comamessenger/core/internal/chat"
	"github.com/comamessenger/comamessenger/core/internal/files"
	"github.com/comamessenger/comamessenger/core/internal/identity"
	"github.com/comamessenger/comamessenger/core/internal/knowledge"
	"github.com/comamessenger/comamessenger/core/internal/mcptest"
	"github.com/comamessenger/comamessenger/core/internal/message"
	"github.com/comamessenger/comamessenger/core/internal/netguard"
	"github.com/comamessenger/comamessenger/core/internal/permission"
	"github.com/comamessenger/comamessenger/core/internal/search"
	"github.com/comamessenger/comamessenger/core/internal/storage"
	"github.com/comamessenger/comamessenger/core/internal/testdb"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

// slotsRecipe is the unchanged catalog instruction of the "Слоты" agent in
// both scenarios below. It names the question, not the data source.
var slotsRecipe = func() string {
	recipe, _ := agent.RecipeByID("slots", "ru")
	return recipe.Instructions
}()

const slotsSchedule = "Слот;Дата;Начало;Конец;Зал;Инструктор;Статус\n" +
	"s-1;2026-11-12;09:00;10:00;Зал 1;Иванова;занят\n" +
	"s-2;2026-11-12;10:00;11:00;Зал 1;;свободен\n" +
	"s-3;2026-11-12;11:00;12:00;Зал 2;Петров;занят\n" +
	"s-4;2026-11-13;09:00;10:00;Зал 1;;свободен\n"

type slotsWorld struct {
	pool           *pgxpool.Pool
	executor       *Executor
	runs           *agentrun.Service
	connections    *agentconfig.Service
	knowledge      *knowledge.Service
	orgID, chatID  string
	agentID        string
	owner          identity.User
	agentUser      identity.User
	authentication access.Identity
}

func newSlotsWorld(t *testing.T) slotsWorld {
	t.Helper()
	pool := testdb.New(t)
	w := slotsWorld{pool: pool, orgID: uuid.NewString(), chatID: uuid.NewString(), agentID: uuid.NewString()}
	ownerID := uuid.NewString()
	tx, err := pool.Begin(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(t.Context())
	for _, statement := range []struct {
		sql  string
		args []any
	}{
		{`INSERT INTO organizations(id,name,slug) VALUES($1,'Rehab','rehab-slots')`, []any{w.orgID}},
		{`INSERT INTO actors(id,org_id,type,org_role,display_name,handle) VALUES($1,$3,'user','owner','Owner','owner'),($2,$3,'agent','member','Слоты','slots')`, []any{ownerID, w.agentID, w.orgID}},
		{`INSERT INTO agents(actor_id,org_id,owner_actor_id,kind,enabled,description,allowed_scopes,published_version)
			VALUES($1,$2,$3,'builtin',true,$4,ARRAY['runtime:execute','tables:read'],1)`, []any{w.agentID, w.orgID, ownerID, slotsRecipe}},
		{`INSERT INTO chats(id,org_id,kind,visibility,name,created_by) VALUES($1,$2,'group','private','Администраторы',$3)`, []any{w.chatID, w.orgID, ownerID}},
		{`INSERT INTO chat_members(chat_id,actor_id,org_id,role) VALUES($1,$2,$3,'owner'),($1,$4,$3,'member')`, []any{w.chatID, ownerID, w.orgID, w.agentID}},
	} {
		if _, err := tx.Exec(t.Context(), statement.sql, statement.args...); err != nil {
			t.Fatalf("seed: %v\n%s", err, statement.sql)
		}
	}
	if err := tx.Commit(t.Context()); err != nil {
		t.Fatal(err)
	}
	store, err := storage.NewLocalBlobStore(t.TempDir(), 0)
	if err != nil {
		t.Fatal(err)
	}
	fileService, err := files.NewService(pool, store, "", 16<<20, 8<<20, 4<<20, time.Hour, time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	w.knowledge = knowledge.NewService(pool, fileService, nil, nil)
	if _, err := knowledge.NewIndexingClient(pool, w.knowledge, slog.New(slog.NewTextHandler(io.Discard, nil))); err != nil {
		t.Fatal(err)
	}
	w.connections, err = agentconfig.NewService(pool, "0123456789abcdef0123456789abcdef")
	if err != nil {
		t.Fatal(err)
	}
	loopback, err := netguard.ParseTargets("127.0.0.1/32")
	if err != nil {
		t.Fatal(err)
	}
	w.connections.SetPrivateTargets(loopback)
	noop := func(string, int64) {}
	w.executor, err = NewExecutor(pool, Services{Chats: chat.NewService(pool, noop), Messages: message.NewService(pool, 65536, 100, noop), Search: search.NewService(pool),
		Files: fileService, Memory: agentmemory.NewService(pool), Knowledge: w.knowledge, MCP: w.connections}, true)
	if err != nil {
		t.Fatal(err)
	}
	w.runs = agentrun.NewService(pool)
	w.owner = identity.User{ActorID: ownerID, OrgID: w.orgID, OrgRole: "owner", Permissions: permission.Effective("owner", nil)}
	w.agentUser = identity.User{ActorID: w.agentID, OrgID: w.orgID, OrgRole: "member"}
	w.authentication = access.Identity{AuthenticationKind: "api_key", ActorID: w.agentID, OrgID: w.orgID, KeyID: uuid.NewString(), Scopes: []string{"runtime:execute", "tables:read"}}

	// The table source: a CSV schedule in a knowledge collection.
	upload, err := fileService.CreateUpload(t.Context(), w.owner, files.CreateUploadInput{Name: "slots.csv", MIME: "text/csv", Size: int64(len(slotsSchedule))})
	if err != nil {
		t.Fatal(err)
	}
	file, err := fileService.PutContent(t.Context(), w.owner, upload.ID, bytes.NewReader([]byte(slotsSchedule)))
	if err != nil {
		t.Fatal(err)
	}
	collection, err := w.knowledge.CreateCollection(t.Context(), w.owner, knowledge.CreateCollectionInput{Name: "Расписание"})
	if err != nil {
		t.Fatal(err)
	}
	document, err := w.knowledge.CreateDocument(t.Context(), w.owner, collection.ID, knowledge.CreateDocumentInput{Kind: "file", FileID: file.ID, Title: "Слоты"})
	if err != nil {
		t.Fatal(err)
	}
	if err := w.knowledge.IndexDocument(t.Context(), document.ID, document.ContentVersion); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(t.Context(), `UPDATE agents SET knowledge_collection_ids=ARRAY[$2::uuid] WHERE actor_id=$1`, w.agentID, collection.ID); err != nil {
		t.Fatal(err)
	}
	return w
}

func (w slotsWorld) startRun(t *testing.T, dryRun bool) (string, string, string) {
	t.Helper()
	runID, leaseToken, correlationID := uuid.NewString(), uuid.NewString(), uuid.NewString()
	config := `{}`
	if dryRun {
		// A dry run snapshots the draft; here the draft equals the published state.
		if err := w.pool.QueryRow(t.Context(), `SELECT jsonb_build_object('mcp_bindings',mcp_bindings,'knowledge_collection_ids',to_jsonb(knowledge_collection_ids),'description',description)::text FROM agents WHERE actor_id=$1`, w.agentID).Scan(&config); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := w.pool.Exec(t.Context(), `INSERT INTO agent_runs(id,org_id,agent_id,chat_id,correlation_id,status,lease_token,lease_expires_at,started_at,timeout_at,dry_run,agent_config)
		VALUES($1,$2,$3,$4,$5,'running',$6,now()+interval '1 minute',now(),now()+interval '5 minutes',$7,$8::jsonb)`,
		runID, w.orgID, w.agentID, w.chatID, correlationID, leaseToken, dryRun, config); err != nil {
		t.Fatal(err)
	}
	return runID, leaseToken, correlationID
}

func (w slotsWorld) recipe(t *testing.T) string {
	t.Helper()
	var description string
	if err := w.pool.QueryRow(t.Context(), `SELECT description FROM agents WHERE actor_id=$1`, w.agentID).Scan(&description); err != nil {
		t.Fatal(err)
	}
	return description
}

// callMCPLikeRuntime performs what apps/agent-runtime does with a runtime MCP
// configuration: initialize, then tools/call with the configured headers.
func callMCPLikeRuntime(t *testing.T, server agentconfig.RuntimeMCPServer, tool string, arguments map[string]any) map[string]any {
	t.Helper()
	post := func(payload map[string]any) []byte {
		body, _ := json.Marshal(payload)
		request, _ := http.NewRequest(http.MethodPost, server.EndpointURL, bytes.NewReader(body))
		for name, value := range server.Headers {
			request.Header.Set(name, value)
		}
		request.Header.Set("Content-Type", "application/json")
		response, err := http.DefaultClient.Do(request)
		if err != nil {
			t.Fatal(err)
		}
		defer response.Body.Close()
		data, _ := io.ReadAll(response.Body)
		if response.StatusCode >= 300 {
			t.Fatalf("MCP status %d: %s", response.StatusCode, data)
		}
		return data
	}
	post(map[string]any{"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": map[string]any{}})
	var decoded struct {
		Result struct {
			StructuredContent map[string]any `json:"structuredContent"`
		} `json:"result"`
	}
	if err := json.Unmarshal(post(map[string]any{"jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": map[string]any{"name": tool, "arguments": arguments}}), &decoded); err != nil {
		t.Fatal(err)
	}
	return decoded.Result.StructuredContent
}

// TestSlotsRecipeWorksOnTableAndOnMCPAdapter is the phase acceptance check:
// the same agent recipe gets the free slot first from the spreadsheet source
// and then, with only the data binding changed, from an MCP adapter of an
// accounting system. Writing back requires a person's approval and a dry run
// never reaches the external system.
func TestSlotsRecipeWorksOnTableAndOnMCPAdapter(t *testing.T) {
	w := newSlotsWorld(t)
	recipe := w.recipe(t)

	// 1. Table source.
	runID, leaseToken, correlationID := w.startRun(t, false)
	invoke := func(arguments string) map[string]any {
		t.Helper()
		result, err := w.executor.Invoke(t.Context(), Invocation{User: w.agentUser, Identity: w.authentication, Name: "query_table", Arguments: json.RawMessage(arguments),
			RunID: runID, LeaseToken: leaseToken, CorrelationID: correlationID, ToolCallID: uuid.NewString()})
		if err != nil {
			t.Fatal(err)
		}
		var output map[string]any
		_ = json.Unmarshal(result.Output, &output)
		return output
	}
	catalog := invoke(`{}`)
	tables, _ := catalog["tables"].([]any)
	if len(tables) != 1 {
		t.Fatalf("catalog = %v", catalog)
	}
	documentID := tables[0].(map[string]any)["document_id"].(string)
	free := invoke(`{"document_id":"` + documentID + `","filters":[{"column":"Дата","value":"2026-11-12"},{"column":"Статус","value":"свободен"}]}`)
	rows, _ := free["rows"].([]any)
	if len(rows) != 1 || rows[0].(map[string]any)["values"].(map[string]any)["Слот"] != "s-2" {
		t.Fatalf("free slots from table = %v", free)
	}

	// 2. The accounting system through an MCP adapter; same recipe.
	server := mcptest.NewSlotsServer()
	defer server.Close()
	server.RequireKey = "accounting-token"
	connection, err := w.connections.CreateMCPConnection(t.Context(), w.owner, agentconfig.CreateMCPConnectionInput{
		Name: "accounting", EndpointURL: server.URL, AllowPrivateNetwork: true, AgentUseAllowed: true, Headers: map[string]string{"Authorization": "Bearer accounting-token"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if tested, err := w.connections.TestMCPConnection(t.Context(), w.owner, connection.ID); err != nil || tested.HealthStatus != "healthy" {
		t.Fatalf("connection test = %+v, err=%v", tested, err)
	}
	bindings, _ := json.Marshal([]map[string]any{{"connection_id": connection.ID, "allowed_tools": []string{"get_slots", "find_free_instructors", "assign_instructor"}, "require_write_confirmation": true}})
	if _, err := w.pool.Exec(t.Context(), `UPDATE agents SET mcp_bindings=$2,knowledge_collection_ids='{}' WHERE actor_id=$1`, w.agentID, bindings); err != nil {
		t.Fatal(err)
	}
	if w.recipe(t) != recipe {
		t.Fatal("the recipe changed between data sources")
	}
	runID, leaseToken, correlationID = w.startRun(t, false)
	if catalog := invoke(`{}`); len(catalog["tables"].([]any)) != 0 {
		t.Fatalf("table still visible after unbinding: %v", catalog)
	}
	servers, err := w.connections.RuntimeMCPServersForRun(t.Context(), w.agentUser, w.authentication, w.agentID, runID)
	if err != nil || len(servers) != 1 {
		t.Fatalf("runtime servers = %+v, err=%v", servers, err)
	}
	read, err := w.runs.StartMCPToolCall(t.Context(), w.agentUser, w.authentication, agentrun.StartMCPToolCallInput{CallID: uuid.NewString(), RunID: runID, LeaseToken: leaseToken,
		ServerID: connection.ID, ToolName: "get_slots", Mode: "read"})
	if err != nil || read.ConfirmationRequired || read.Preview || read.ToolName != "mcp__accounting__get_slots" {
		t.Fatalf("read call = %+v, err=%v", read, err)
	}
	slots := callMCPLikeRuntime(t, servers[0], "get_slots", map[string]any{"date": "2026-11-12"})
	var freeSlot string
	for _, item := range slots["slots"].([]any) {
		if slot := item.(map[string]any); slot["status"] == "свободен" {
			freeSlot = slot["id"].(string)
		}
	}
	if freeSlot != "s-2" {
		t.Fatalf("free slot from MCP = %q (%v)", freeSlot, slots)
	}

	// A runtime claiming "read" for a write tool is overruled by Core's catalog.
	if _, err := w.runs.StartMCPToolCall(t.Context(), w.agentUser, w.authentication, agentrun.StartMCPToolCallInput{CallID: uuid.NewString(), RunID: runID, LeaseToken: leaseToken,
		ServerID: connection.ID, ToolName: "not_allowlisted", Mode: "read"}); !errors.Is(err, agentrun.ErrForbidden) {
		t.Fatalf("not allowlisted tool error = %v", err)
	}
	// Core reclassifies the claimed read as a write that needs approval, so a
	// call without arguments is refused instead of being approved empty.
	if _, err := w.runs.StartMCPToolCall(t.Context(), w.agentUser, w.authentication, agentrun.StartMCPToolCallInput{CallID: uuid.NewString(), RunID: runID, LeaseToken: leaseToken,
		ServerID: connection.ID, ToolName: "assign_instructor", Mode: "read"}); !errors.Is(err, agentrun.ErrInvalid) {
		t.Fatalf("reclassified write without arguments = %v", err)
	}
	callID := uuid.NewString()
	arguments := json.RawMessage(`{"slot_id":"s-2","instructor_id":"i-3"}`)
	write, err := w.runs.StartMCPToolCall(t.Context(), w.agentUser, w.authentication, agentrun.StartMCPToolCallInput{CallID: callID, RunID: runID, LeaseToken: leaseToken,
		ServerID: connection.ID, ToolName: "assign_instructor", Mode: "read", Arguments: arguments})
	if err != nil || !write.ConfirmationRequired || write.Mode != "write" {
		t.Fatalf("write call = %+v, err=%v", write, err)
	}
	confirmation, err := w.executor.RequestMCPConfirmation(t.Context(), w.orgID, write.AgentID, runID, callID, write.CorrelationID, write.ConnectionID, write.ToolName, arguments)
	if err != nil || confirmation.Status != "pending" || string(confirmation.RequiredScope) != "mcp:"+connection.ID {
		t.Fatalf("confirmation = %+v, err=%v", confirmation, err)
	}
	if server.Calls("assign_instructor") != 0 {
		t.Fatal("the schedule changed before a person decided")
	}
	decided, err := w.executor.DecideConfirmation(t.Context(), w.owner, confirmation.ID, true)
	if err != nil || decided.Status != "completed" || !strings.Contains(string(decided.Result), `"assigned":true`) {
		t.Fatalf("decided = %+v (%s), err=%v", decided, decided.Result, err)
	}
	if server.Calls("assign_instructor") != 1 || server.Slots()[1].Instructor != "Смирнова" {
		t.Fatalf("assignment not applied: %+v", server.Slots())
	}
	var recorded int
	if err := w.pool.QueryRow(t.Context(), `SELECT count(*) FROM agent_tool_calls WHERE run_id=$1 AND tool_name='mcp__accounting__assign_instructor' AND status='completed'`, runID).Scan(&recorded); err != nil || recorded != 1 {
		t.Fatalf("recorded approved call = %d, err=%v", recorded, err)
	}

	// 3. A dry run previews the write and never calls the external system.
	dryRunID, dryLease, _ := w.startRun(t, true)
	preview, err := w.runs.StartMCPToolCall(t.Context(), w.agentUser, w.authentication, agentrun.StartMCPToolCallInput{CallID: uuid.NewString(), RunID: dryRunID, LeaseToken: dryLease,
		ServerID: connection.ID, ToolName: "assign_instructor", Mode: "write", Arguments: json.RawMessage(`{"slot_id":"s-4","instructor_id":"i-1"}`)})
	if err != nil || !preview.Preview || preview.ConfirmationRequired {
		t.Fatalf("dry-run write = %+v, err=%v", preview, err)
	}
	var pending int
	if err := w.pool.QueryRow(t.Context(), `SELECT count(*) FROM agent_tool_confirmations WHERE run_id=$1`, dryRunID).Scan(&pending); err != nil || pending != 0 {
		t.Fatalf("dry run created confirmations: %d, err=%v", pending, err)
	}
	if server.Calls("assign_instructor") != 1 {
		t.Fatal("dry run reached the external system")
	}
}

// cancelingMCP cancels the approver's request context in the middle of the
// external call, as a closed browser tab does, and reports whether its own
// context survived.
type cancelingMCP struct {
	cancel   func()
	survived bool
}

func (fake *cancelingMCP) ExecuteConfirmedMCPCall(ctx context.Context, _, _, _, _ string, _ json.RawMessage) (json.RawMessage, error) {
	fake.cancel()
	time.Sleep(20 * time.Millisecond)
	fake.survived = ctx.Err() == nil
	if !fake.survived {
		return nil, ctx.Err()
	}
	return json.RawMessage(`{"assigned":true}`), nil
}

func TestApprovedMCPCallSurvivesApproverDisconnect(t *testing.T) {
	w := newSlotsWorld(t)
	runID, _, correlationID := w.startRun(t, false)
	connectionID := uuid.NewString()
	confirmation, err := w.executor.RequestMCPConfirmation(t.Context(), w.orgID, w.agentID, runID, uuid.NewString(), correlationID, connectionID,
		"mcp__accounting__assign_instructor", json.RawMessage(`{"slot_id":"s-2"}`))
	if err != nil {
		t.Fatal(err)
	}
	requestContext, cancel := context.WithCancel(t.Context())
	fake := &cancelingMCP{cancel: cancel}
	w.executor.services.MCP = fake
	decided, err := w.executor.DecideConfirmation(requestContext, w.owner, confirmation.ID, true)
	if err != nil || !fake.survived || decided.Status != "completed" {
		t.Fatalf("decided = %+v, survived=%v, err=%v", decided, fake.survived, err)
	}
	var status string
	if err := w.pool.QueryRow(t.Context(), `SELECT status FROM agent_tool_confirmations WHERE id=$1`, confirmation.ID).Scan(&status); err != nil || status != "completed" {
		t.Fatalf("stored status = %q, err=%v", status, err)
	}
}
