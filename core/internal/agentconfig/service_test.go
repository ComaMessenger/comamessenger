package agentconfig

import (
	"reflect"
	"testing"
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
