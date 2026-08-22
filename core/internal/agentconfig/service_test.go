package agentconfig

import (
	"bytes"
	"errors"
	"reflect"
	"testing"

	"github.com/comamessenger/comamessenger/core/internal/access"
	"github.com/comamessenger/comamessenger/core/internal/identity"
	"github.com/comamessenger/comamessenger/core/internal/testdb"
)

func TestCredentialEncryptionUsesOrganizationAndAgentAAD(t *testing.T) {
	service, err := NewService(nil, "0123456789abcdef0123456789abcdef")
	if err != nil {
		t.Fatal(err)
	}
	nonce, ciphertext, err := service.seal("org-one", "agent-one", "provider-secret")
	if err != nil {
		t.Fatal(err)
	}
	if string(ciphertext) == "provider-secret" {
		t.Fatal("credential was stored as plaintext")
	}
	plain, err := service.open("org-one", "agent-one", nonce, ciphertext)
	if err != nil || plain != "provider-secret" {
		t.Fatalf("round trip = %q, err=%v", plain, err)
	}
	if _, err := service.open("org-two", "agent-one", nonce, ciphertext); err == nil {
		t.Fatal("credential decrypted for another organization")
	}
	if _, err := service.open("org-one", "agent-two", nonce, ciphertext); err == nil {
		t.Fatal("credential decrypted for another agent")
	}
}

func TestMCPHeaderEncryptionUsesServerAAD(t *testing.T) {
	service, err := NewService(nil, "0123456789abcdef0123456789abcdef")
	if err != nil {
		t.Fatal(err)
	}
	headers := map[string]string{"Authorization": "Bearer secret", "X-API-Key": "key"}
	encrypted, err := service.sealMCPHeaders("org-one", "agent-one", "server-one", headers)
	if err != nil {
		t.Fatal(err)
	}
	if string(encrypted) == "Bearer secret" {
		t.Fatal("MCP headers were stored as plaintext")
	}
	plain, err := service.openMCPHeaders("org-one", "agent-one", "server-one", encrypted)
	if err != nil || !reflect.DeepEqual(plain, headers) {
		t.Fatalf("round trip = %#v, err=%v", plain, err)
	}
	if _, err := service.openMCPHeaders("org-one", "agent-one", "server-two", encrypted); err == nil {
		t.Fatal("headers decrypted for another MCP server")
	}
}

func TestMCPConfigurationValidation(t *testing.T) {
	valid := func() bool {
		return validMCPConfig("knowledge", "https://mcp.example.com/rpc", []string{"search", "read_file"}, map[string]string{"Authorization": "Bearer secret"}, 10000, 262144)
	}
	if !valid() {
		t.Fatal("valid MCP configuration was rejected")
	}
	tests := []struct {
		name     string
		endpoint string
		tools    []string
		headers  map[string]string
	}{
		{name: "bad name", endpoint: "https://mcp.example.com", tools: []string{"search"}},
		{name: "valid", endpoint: "file:///etc/passwd", tools: []string{"search"}},
		{name: "valid", endpoint: "http://mcp.example.com/rpc", tools: []string{"search"}},
		{name: "valid", endpoint: "https://127.0.0.1/rpc", tools: []string{"search"}},
		{name: "valid", endpoint: "https://10.0.0.4/rpc", tools: []string{"search"}},
		{name: "valid", endpoint: "https://mcp.local/rpc", tools: []string{"search"}},
		{name: "valid", endpoint: "https://user:pass@mcp.example.com", tools: []string{"search"}},
		{name: "valid", endpoint: "https://mcp.example.com", tools: []string{"bad.tool"}},
		{name: "valid", endpoint: "https://mcp.example.com", tools: []string{"search", "search"}},
		{name: "valid", endpoint: "https://mcp.example.com", tools: []string{"search"}, headers: map[string]string{"X-Test": "ok\r\nInjected: yes"}},
		{name: "valid", endpoint: "https://mcp.example.com", tools: []string{"search"}, headers: map[string]string{"Host": "evil.example"}},
	}
	for _, test := range tests {
		if validMCPConfig(test.name, test.endpoint, test.tools, test.headers, 10000, 262144) {
			t.Fatalf("invalid MCP configuration accepted: %#v", test)
		}
	}
}

func TestLLMConnectionEncryptionUsesConnectionAAD(t *testing.T) {
	service, err := NewService(nil, "0123456789abcdef0123456789abcdef")
	if err != nil {
		t.Fatal(err)
	}
	nonce, ciphertext, err := service.sealLLMConnection("org-one", "connection-one", "provider-secret")
	if err != nil {
		t.Fatal(err)
	}
	if string(ciphertext) == "provider-secret" {
		t.Fatal("connection credential was stored as plaintext")
	}
	plain, err := service.openLLMConnection("org-one", "connection-one", nonce, ciphertext)
	if err != nil || plain != "provider-secret" {
		t.Fatalf("round trip = %q, err=%v", plain, err)
	}
	if _, err := service.openLLMConnection("org-two", "connection-one", nonce, ciphertext); err == nil {
		t.Fatal("credential decrypted for another organization")
	}
	if _, err := service.openLLMConnection("org-one", "connection-two", nonce, ciphertext); err == nil {
		t.Fatal("credential decrypted for another connection")
	}
}

func TestLLMConnectionValidation(t *testing.T) {
	valid := []struct {
		provider string
		endpoint string
	}{
		{provider: "openai"},
		{provider: "anthropic"},
		{provider: "openai-compatible", endpoint: "https://llm.example.com/v1"},
		{provider: "openai-compatible", endpoint: "http://ollama.internal:11434/v1"},
	}
	for _, test := range valid {
		if !validLLMConnection("Основное подключение", test.provider, test.endpoint, "model", "secret") {
			t.Fatalf("valid connection rejected: %#v", test)
		}
	}
	invalid := []struct {
		provider string
		endpoint string
	}{
		{provider: "unknown"},
		{provider: "openai", endpoint: "https://api.openai.com"},
		{provider: "openai-compatible"},
		{provider: "openai-compatible", endpoint: "file:///etc/passwd"},
		{provider: "openai-compatible", endpoint: "https://user:pass@llm.example.com"},
		{provider: "openai-compatible", endpoint: "https://llm.example.com/#fragment"},
	}
	for _, test := range invalid {
		if validLLMConnection("Основное подключение", test.provider, test.endpoint, "model", "secret") {
			t.Fatalf("invalid connection accepted: %#v", test)
		}
	}
}

func TestWorkspaceLLMConnectionLifecycle(t *testing.T) {
	pool := testdb.New(t)
	const (
		orgID    = "00000000-0000-7000-8000-000000000381"
		ownerID  = "00000000-0000-7000-8000-000000000382"
		memberID = "00000000-0000-7000-8000-000000000383"
		agentID  = "00000000-0000-7000-8000-000000000384"
	)
	tx, err := pool.Begin(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(t.Context())
	if _, err := tx.Exec(t.Context(), `INSERT INTO organizations(id,name,slug) VALUES($1,'Connection model','connection-model')`, orgID); err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(t.Context(), `INSERT INTO actors(id,org_id,type,org_role,display_name,handle) VALUES
		($1,$4,'user','owner','Owner','connection-owner'),
		($2,$4,'user','member','Member','connection-member'),
		($3,$4,'agent','member','Agent','connection-agent')`, ownerID, memberID, agentID, orgID); err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(t.Context()); err != nil {
		t.Fatal(err)
	}
	service, err := NewService(pool, "0123456789abcdef0123456789abcdef")
	if err != nil {
		t.Fatal(err)
	}
	owner := identity.User{ActorID: ownerID, OrgID: orgID, OrgRole: "owner"}
	member := identity.User{ActorID: memberID, OrgID: orgID, OrgRole: "member"}
	if _, err := service.CreateLLMConnection(t.Context(), member, CreateLLMConnectionInput{Name: "Forbidden", Provider: "openai", APIKey: "secret"}); !errors.Is(err, ErrForbidden) {
		t.Fatalf("member create error = %v", err)
	}
	created, err := service.CreateLLMConnection(t.Context(), owner, CreateLLMConnectionInput{
		Name: "Основное", Provider: "openai-compatible", EndpointURL: "http://ollama.internal:11434/v1", DefaultModel: "qwen3", APIKey: "provider-secret-value",
	})
	if err != nil {
		t.Fatal(err)
	}
	if created.ID == "" || created.KeyHint == "provider-secret-value" || created.HealthStatus != "untested" || !created.Enabled {
		t.Fatalf("created connection = %+v", created)
	}
	var ciphertext []byte
	if err := pool.QueryRow(t.Context(), `SELECT ciphertext FROM agent_llm_connections WHERE id=$1`, created.ID).Scan(&ciphertext); err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(ciphertext, []byte("provider-secret-value")) {
		t.Fatal("LLM connection credential persisted as plaintext")
	}
	listed, err := service.ListLLMConnections(t.Context(), owner)
	if err != nil || len(listed) != 1 || listed[0].ID != created.ID {
		t.Fatalf("connections = %+v, err=%v", listed, err)
	}
	updatedName := "Резервное"
	updatedKey := "replacement-secret"
	updated, err := service.UpdateLLMConnection(t.Context(), owner, created.ID, UpdateLLMConnectionInput{Name: &updatedName, APIKey: &updatedKey})
	if err != nil || updated.Name != updatedName || updated.KeyHint == created.KeyHint {
		t.Fatalf("updated connection = %+v, err=%v", updated, err)
	}
	if _, err := pool.Exec(t.Context(), `INSERT INTO agents(actor_id,org_id,owner_actor_id,kind,llm_connection_id) VALUES($1,$2,$3,'builtin',$4)`, agentID, orgID, ownerID, created.ID); err != nil {
		t.Fatal(err)
	}
	runtimeUser := identity.User{ActorID: agentID, OrgID: orgID, OrgRole: "member"}
	runtimeIdentity := access.Identity{ActorID: agentID, OrgID: orgID, AuthenticationKind: "api_key", KeyID: "runtime-key", Scopes: []string{"runtime:execute"}}
	runtimeCredential, err := service.RuntimeCredentialForAgent(t.Context(), runtimeUser, runtimeIdentity, agentID)
	if err != nil || runtimeCredential.APIKey != updatedKey {
		t.Fatalf("runtime connection credential = %+v, err=%v", runtimeCredential, err)
	}
	if err := service.DeleteLLMConnection(t.Context(), owner, created.ID); !errors.Is(err, ErrConflict) {
		t.Fatalf("delete in-use connection error = %v", err)
	}
	if _, err := pool.Exec(t.Context(), `UPDATE agents SET llm_connection_id=NULL WHERE actor_id=$1`, agentID); err != nil {
		t.Fatal(err)
	}
	if err := service.DeleteLLMConnection(t.Context(), owner, created.ID); err != nil {
		t.Fatal(err)
	}
	var auditCount int
	if err := pool.QueryRow(t.Context(), `SELECT count(*) FROM audit_log WHERE target_id=$1 AND action LIKE 'agent.llm_connection.%'`, created.ID).Scan(&auditCount); err != nil || auditCount != 3 {
		t.Fatalf("audit count = %d, err=%v", auditCount, err)
	}
}
