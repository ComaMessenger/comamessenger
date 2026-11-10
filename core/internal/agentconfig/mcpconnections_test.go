package agentconfig

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/comamessenger/comamessenger/core/internal/access"
	"github.com/comamessenger/comamessenger/core/internal/identity"
	"github.com/comamessenger/comamessenger/core/internal/mcptest"
	"github.com/comamessenger/comamessenger/core/internal/permission"
	"github.com/comamessenger/comamessenger/core/internal/testdb"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

const secretToken = "accounting-super-secret-token-7f3a"

type integrationFixture struct {
	pool                   *pgxpool.Pool
	service                *Service
	orgID, agentID, chatID string
	owner, builder, member identity.User
	runtimeUser            identity.User
	runtimeIdentity        access.Identity
}

func newIntegrationFixture(t *testing.T) integrationFixture {
	t.Helper()
	pool := testdb.New(t)
	f := integrationFixture{pool: pool, orgID: uuid.NewString(), agentID: uuid.NewString(), chatID: uuid.NewString()}
	ownerID, builderID, memberID := uuid.NewString(), uuid.NewString(), uuid.NewString()
	tx, err := pool.Begin(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(t.Context())
	for _, statement := range []struct {
		sql  string
		args []any
	}{
		{`INSERT INTO organizations(id,name,slug) VALUES($1,'Rehab','rehab-integrations')`, []any{f.orgID}},
		{`INSERT INTO actors(id,org_id,type,org_role,display_name,handle) VALUES($1,$5,'user','owner','Owner','owner'),($2,$5,'user','admin','Builder','builder'),
			($3,$5,'user','member','Member','member'),($4,$5,'agent','member','Слоты','slots')`, []any{ownerID, builderID, memberID, f.agentID, f.orgID}},
		{`INSERT INTO agents(actor_id,org_id,owner_actor_id,kind,enabled,allowed_scopes,published_version) VALUES($1,$2,$3,'builtin',true,ARRAY['runtime:execute'],1)`, []any{f.agentID, f.orgID, ownerID}},
		{`INSERT INTO chats(id,org_id,kind,visibility,name,created_by) VALUES($1,$2,'group','private','Администраторы',$3)`, []any{f.chatID, f.orgID, ownerID}},
		{`INSERT INTO chat_members(chat_id,actor_id,org_id,role) VALUES($1,$2,$3,'owner'),($1,$4,$3,'member')`, []any{f.chatID, ownerID, f.orgID, f.agentID}},
	} {
		if _, err := tx.Exec(t.Context(), statement.sql, statement.args...); err != nil {
			t.Fatalf("seed: %v\n%s", err, statement.sql)
		}
	}
	if err := tx.Commit(t.Context()); err != nil {
		t.Fatal(err)
	}
	f.service, err = NewService(pool, "0123456789abcdef0123456789abcdef")
	if err != nil {
		t.Fatal(err)
	}
	f.owner = identity.User{ActorID: ownerID, OrgID: f.orgID, OrgRole: "owner", Permissions: permission.Effective("owner", nil)}
	f.builder = identity.User{ActorID: builderID, OrgID: f.orgID, OrgRole: "admin", Permissions: permission.Effective("admin", []permission.Code{permission.AgentsBuild})}
	f.member = identity.User{ActorID: memberID, OrgID: f.orgID, OrgRole: "member", Permissions: permission.Effective("member", nil)}
	f.runtimeUser = identity.User{ActorID: f.agentID, OrgID: f.orgID, OrgRole: "member"}
	f.runtimeIdentity = access.Identity{ActorID: f.agentID, OrgID: f.orgID, AuthenticationKind: "api_key", KeyID: uuid.NewString(), Scopes: []string{"runtime:execute"}}
	return f
}

func (f integrationFixture) bind(t *testing.T, connectionID string, tools []string, confirm bool) {
	t.Helper()
	encoded, _ := json.Marshal([]mcpBinding{{ConnectionID: connectionID, AllowedTools: tools, RequireWriteConfirmation: confirm}})
	if _, err := f.pool.Exec(t.Context(), `UPDATE agents SET mcp_bindings=$2 WHERE actor_id=$1`, f.agentID, encoded); err != nil {
		t.Fatal(err)
	}
}

func (f integrationFixture) run(t *testing.T, dryRun bool, config map[string]any) string {
	t.Helper()
	runID := uuid.NewString()
	encoded, _ := json.Marshal(config)
	if _, err := f.pool.Exec(t.Context(), `INSERT INTO agent_runs(id,org_id,agent_id,chat_id,correlation_id,status,lease_token,lease_expires_at,started_at,timeout_at,dry_run,agent_config)
		VALUES($1,$2,$3,$4,$5,'running',$6,now()+interval '1 minute',now(),now()+interval '5 minutes',$7,$8)`,
		runID, f.orgID, f.agentID, f.chatID, uuid.NewString(), uuid.NewString(), dryRun, encoded); err != nil {
		t.Fatal(err)
	}
	return runID
}

func TestMCPConnectionSecretNeverLeavesCore(t *testing.T) {
	f := newIntegrationFixture(t)
	server := mcptest.NewSlotsServer()
	defer server.Close()
	server.RequireKey = secretToken
	if _, err := f.service.CreateMCPConnection(t.Context(), f.builder, CreateMCPConnectionInput{Name: "acc", EndpointURL: server.URL, AllowPrivateNetwork: true}); !errors.Is(err, ErrForbidden) {
		t.Fatalf("builder without integrations.manage created a connection: %v", err)
	}
	created, err := f.service.CreateMCPConnection(t.Context(), f.owner, CreateMCPConnectionInput{
		Name: "accounting", Description: "Учёт", EndpointURL: server.URL + "/mcp", AllowPrivateNetwork: true,
		Headers: map[string]string{"Authorization": "Bearer " + secretToken},
	})
	if err != nil {
		t.Fatal(err)
	}
	if !created.HeadersConfigured || created.SecretHint == "" || strings.Contains(created.SecretHint, secretToken) {
		t.Fatalf("created = %+v", created)
	}
	tested, err := f.service.TestMCPConnection(t.Context(), f.owner, created.ID)
	if err != nil || tested.HealthStatus != "healthy" || len(tested.Tools) != 3 || tested.ToolsRefreshedAt == nil {
		t.Fatalf("tested = %+v, err=%v", tested, err)
	}
	if tools := map[string]bool{tested.Tools[0].Name: tested.Tools[0].ReadOnly, tested.Tools[2].Name: tested.Tools[2].ReadOnly}; !tools["get_slots"] || tools["assign_instructor"] {
		t.Fatalf("tool classification = %+v", tested.Tools)
	}
	if server.Calls("get_slots")+server.Calls("assign_instructor") != 0 {
		t.Fatal("connection test called a tool")
	}
	listed, err := f.service.ListMCPConnections(t.Context(), f.builder)
	if err != nil || len(listed) != 1 {
		t.Fatalf("builder list = %+v, err=%v", listed, err)
	}
	if _, err := f.service.ListMCPConnections(t.Context(), f.member); !errors.Is(err, ErrForbidden) {
		t.Fatalf("member list error = %v", err)
	}
	f.bind(t, created.ID, []string{"get_slots"}, true)
	usage, err := f.service.MCPConnectionUsage(t.Context(), f.owner, created.ID)
	if err != nil || len(usage) != 1 || usage[0].AgentID != f.agentID || !usage[0].Published {
		t.Fatalf("usage = %+v, err=%v", usage, err)
	}
	newName := "accounting2"
	updated, err := f.service.UpdateMCPConnection(t.Context(), f.owner, created.ID, UpdateMCPConnectionInput{Name: &newName})
	if err != nil {
		t.Fatal(err)
	}
	for name, value := range map[string]any{"created": created, "tested": tested, "listed": listed, "usage": usage, "updated": updated} {
		encoded, _ := json.Marshal(value)
		if strings.Contains(string(encoded), secretToken) || strings.Contains(string(encoded), "headers\"") {
			t.Fatalf("%s response leaks the secret: %s", name, encoded)
		}
	}
	var stored []byte
	var bindings string
	if err := f.pool.QueryRow(t.Context(), `SELECT encrypted_headers,(SELECT mcp_bindings::text FROM agents WHERE actor_id=$2) FROM integration_mcp_connections WHERE id=$1`, created.ID, f.agentID).Scan(&stored, &bindings); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(stored), secretToken) || strings.Contains(bindings, secretToken) {
		t.Fatal("secret stored in plaintext or copied into the agent row")
	}
	// Only the runtime of a run gets the decrypted headers.
	runID := f.run(t, false, map[string]any{})
	runtime, err := f.service.RuntimeMCPServersForRun(t.Context(), f.runtimeUser, f.runtimeIdentity, f.agentID, runID)
	if err != nil || len(runtime) != 1 || runtime[0].Headers["Authorization"] != "Bearer "+secretToken || !runtime[0].AllowPrivateNetwork ||
		len(runtime[0].AllowedTools) != 1 || !runtime[0].RequireWriteConfirmation {
		t.Fatalf("runtime servers = %+v, err=%v", runtime, err)
	}
	if _, err := f.service.RuntimeMCPServersForRun(t.Context(), f.owner, access.Identity{ActorID: f.owner.ActorID, OrgID: f.orgID, AuthenticationKind: "session"}, f.agentID, runID); !errors.Is(err, ErrForbidden) {
		t.Fatalf("browser session got runtime headers: %v", err)
	}
	// The deployment switch overrides the connection's private network opt-in.
	f.service.SetPrivateNetworksAllowed(false)
	runtime, err = f.service.RuntimeMCPServersForRun(t.Context(), f.runtimeUser, f.runtimeIdentity, f.agentID, runID)
	if err != nil || runtime[0].AllowPrivateNetwork {
		t.Fatalf("runtime private switch = %+v, err=%v", runtime, err)
	}
	if tested, err := f.service.TestMCPConnection(t.Context(), f.owner, created.ID); err != nil || tested.HealthStatus != "unhealthy" || tested.LastErrorCode != "mcp_endpoint_forbidden" {
		t.Fatalf("test under deny policy = %+v, err=%v", tested, err)
	}
}

func TestMCPConnectionRejectsUnsafeDestinations(t *testing.T) {
	f := newIntegrationFixture(t)
	for _, input := range []CreateMCPConnectionInput{
		{Name: "loopback", EndpointURL: "https://127.0.0.1/mcp"},
		{Name: "private", EndpointURL: "https://10.0.0.8/mcp"},
		{Name: "plain", EndpointURL: "http://mcp.example.com/mcp"},
		{Name: "metadata", EndpointURL: "http://169.254.169.254/latest", AllowPrivateNetwork: true},
		{Name: "gcp", EndpointURL: "http://metadata.google.internal/", AllowPrivateNetwork: true},
		{Name: "local", EndpointURL: "https://erp.local/mcp"},
		{Name: "creds", EndpointURL: "https://user:pass@mcp.example.com/"},
		{Name: "Bad Name", EndpointURL: "https://mcp.example.com/"},
	} {
		if _, err := f.service.CreateMCPConnection(t.Context(), f.owner, input); !errors.Is(err, ErrInvalid) {
			t.Fatalf("unsafe connection accepted: %+v (%v)", input, err)
		}
	}
	if _, err := f.service.CreateMCPConnection(t.Context(), f.owner, CreateMCPConnectionInput{Name: "erp", EndpointURL: "http://10.0.0.8:8080/mcp", AllowPrivateNetwork: true}); err != nil {
		t.Fatalf("trusted internal address rejected: %v", err)
	}
	f.service.SetPrivateNetworksAllowed(false)
	if _, err := f.service.CreateMCPConnection(t.Context(), f.owner, CreateMCPConnectionInput{Name: "erp2", EndpointURL: "http://10.0.0.9:8080/mcp", AllowPrivateNetwork: true}); !errors.Is(err, ErrInvalid) {
		t.Fatalf("private network accepted although the deployment forbids it: %v", err)
	}
	// A public-looking endpoint that redirects inward is refused at test time.
	f.service.SetPrivateNetworksAllowed(true)
	redirector := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, "http://169.254.169.254/latest/meta-data", http.StatusTemporaryRedirect)
	}))
	defer redirector.Close()
	created, err := f.service.CreateMCPConnection(t.Context(), f.owner, CreateMCPConnectionInput{Name: "redirect", EndpointURL: redirector.URL, AllowPrivateNetwork: true})
	if err != nil {
		t.Fatal(err)
	}
	tested, err := f.service.TestMCPConnection(t.Context(), f.owner, created.ID)
	if err != nil || tested.HealthStatus != "unhealthy" || tested.LastErrorCode != "mcp_redirect_refused" {
		t.Fatalf("redirect test = %+v, err=%v", tested, err)
	}
	// Without the private switch the loopback test server is unreachable even
	// though the connection was created when the switch was on.
	off := false
	if _, err := f.service.UpdateMCPConnection(t.Context(), f.owner, created.ID, UpdateMCPConnectionInput{AllowPrivateNetwork: &off}); !errors.Is(err, ErrInvalid) {
		t.Fatalf("plain HTTP loopback kept after disabling the private switch: %v", err)
	}
}

func TestUsedMCPConnectionCannotBeDeletedOnlyDetached(t *testing.T) {
	f := newIntegrationFixture(t)
	created, err := f.service.CreateMCPConnection(t.Context(), f.owner, CreateMCPConnectionInput{Name: "accounting", EndpointURL: "https://mcp.example.com/rpc"})
	if err != nil {
		t.Fatal(err)
	}
	f.bind(t, created.ID, []string{"get_slots"}, true)
	if _, err := f.pool.Exec(t.Context(), `INSERT INTO agent_drafts(org_id,agent_id,version,recipe,max_output_tokens,max_tool_iterations,max_chain_depth,per_chat_concurrency,
		rate_limit_per_minute,provider_rate_limit_per_minute,execution_timeout_seconds,created_by,mcp_bindings)
		SELECT org_id,actor_id,2,'custom',1000,4,1,1,60,60,120,owner_actor_id,mcp_bindings FROM agents WHERE actor_id=$1`, f.agentID); err != nil {
		t.Fatal(err)
	}
	if err := f.service.DeleteMCPConnection(t.Context(), f.owner, created.ID); !errors.Is(err, ErrConflict) {
		t.Fatalf("delete of used connection = %v", err)
	}
	if _, err := f.service.DetachMCPConnection(t.Context(), f.owner, created.ID, DetachMCPConnectionInput{}); !errors.Is(err, ErrUsageChanged) {
		t.Fatalf("detach without confirming impact = %v", err)
	}
	detached, err := f.service.DetachMCPConnection(t.Context(), f.owner, created.ID, DetachMCPConnectionInput{AgentIDs: []string{f.agentID}})
	if err != nil || len(detached) != 1 || !detached[0].Draft || !detached[0].Published {
		t.Fatalf("detach = %+v, err=%v", detached, err)
	}
	var published, draft string
	if err := f.pool.QueryRow(t.Context(), `SELECT agent.mcp_bindings::text,draft.mcp_bindings::text FROM agents agent JOIN agent_drafts draft ON draft.agent_id=agent.actor_id WHERE agent.actor_id=$1`, f.agentID).Scan(&published, &draft); err != nil {
		t.Fatal(err)
	}
	if published != "[]" || draft != "[]" {
		t.Fatalf("bindings after detach: published=%s draft=%s", published, draft)
	}
	if err := f.service.DeleteMCPConnection(t.Context(), f.owner, created.ID); err != nil {
		t.Fatal(err)
	}
	var actions []string
	rows, err := f.pool.Query(t.Context(), `SELECT action FROM audit_log WHERE target_id=$1 ORDER BY created_at,action`, created.ID)
	if err != nil {
		t.Fatal(err)
	}
	for rows.Next() {
		var action string
		_ = rows.Scan(&action)
		actions = append(actions, action)
	}
	rows.Close()
	if strings.Join(actions, ",") != "integration.mcp_connection.create,integration.mcp_connection.detach,integration.mcp_connection.delete" {
		t.Fatalf("audit = %v", actions)
	}
}

func TestMigratedConnectionKeepsLegacyHeadersWorking(t *testing.T) {
	f := newIntegrationFixture(t)
	server := mcptest.NewSlotsServer()
	defer server.Close()
	server.RequireKey = secretToken
	// A row as 00047 copies it from agent_mcp_servers: same id, headers still
	// sealed with the per-agent associated data.
	connectionID := uuid.NewString()
	sealed, err := f.service.sealMCPHeaders(f.orgID, f.agentID, connectionID, map[string]string{"Authorization": "Bearer " + secretToken})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.pool.Exec(t.Context(), `INSERT INTO integration_mcp_connections(id,org_id,name,endpoint_url,allow_private_network,encrypted_headers,legacy_agent_id,created_by,updated_by)
		VALUES($1,$2,'legacy',$3,true,$4,$5,$6,$6)`, connectionID, f.orgID, server.URL, sealed, f.agentID, f.owner.ActorID); err != nil {
		t.Fatal(err)
	}
	f.bind(t, connectionID, []string{"get_slots", "assign_instructor"}, true)
	runtime, err := f.service.RuntimeMCPServersForRun(t.Context(), f.runtimeUser, f.runtimeIdentity, f.agentID, f.run(t, false, map[string]any{}))
	if err != nil || len(runtime) != 1 || runtime[0].Headers["Authorization"] != "Bearer "+secretToken {
		t.Fatalf("legacy runtime = %+v, err=%v", runtime, err)
	}
	if tested, err := f.service.TestMCPConnection(t.Context(), f.owner, connectionID); err != nil || tested.HealthStatus != "healthy" {
		t.Fatalf("legacy connection test = %+v, err=%v", tested, err)
	}
	// Replacing the headers re-seals them with the workspace associated data.
	replacement := map[string]string{"Authorization": "Bearer " + secretToken}
	if _, err := f.service.UpdateMCPConnection(t.Context(), f.owner, connectionID, UpdateMCPConnectionInput{Headers: &replacement}); err != nil {
		t.Fatal(err)
	}
	var legacy *string
	if err := f.pool.QueryRow(t.Context(), `SELECT legacy_agent_id::text FROM integration_mcp_connections WHERE id=$1`, connectionID).Scan(&legacy); err != nil || legacy != nil {
		t.Fatalf("legacy marker = %v, err=%v", legacy, err)
	}
	runtime, err = f.service.RuntimeMCPServersForRun(t.Context(), f.runtimeUser, f.runtimeIdentity, f.agentID, f.run(t, false, map[string]any{}))
	if err != nil || runtime[0].Headers["Authorization"] != "Bearer "+secretToken {
		t.Fatalf("re-sealed runtime = %+v, err=%v", runtime, err)
	}
	// The per-agent compatibility API still lists the server.
	servers, err := f.service.ListMCPServers(t.Context(), f.owner, f.agentID)
	if err != nil || len(servers) != 1 || servers[0].ID != connectionID || len(servers[0].AllowedTools) != 2 || !servers[0].HeadersConfigured {
		t.Fatalf("legacy list = %+v, err=%v", servers, err)
	}
	// Confirmed execution goes through the connection with the stored secret.
	output, err := f.service.ExecuteConfirmedMCPCall(t.Context(), f.orgID, f.agentID, connectionID, "mcp__legacy__assign_instructor", json.RawMessage(`{"slot_id":"s-2","instructor_id":"i-3"}`))
	if err != nil || !strings.Contains(string(output), `"assigned":true`) || server.Calls("assign_instructor") != 1 {
		t.Fatalf("confirmed call = %s, err=%v", output, err)
	}
	if _, err := f.service.ExecuteConfirmedMCPCall(t.Context(), f.orgID, f.agentID, connectionID, "mcp__legacy__find_free_instructors", json.RawMessage(`{}`)); MCPErrorCode(err) != "mcp_tool_not_allowed" {
		t.Fatalf("not allowlisted tool executed: %v", err)
	}
}
