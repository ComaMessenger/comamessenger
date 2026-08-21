package agent

import (
	"bytes"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"testing"
	"time"

	"github.com/comamessenger/comamessenger/core/internal/identity"
	"github.com/comamessenger/comamessenger/core/internal/permission"
	"github.com/comamessenger/comamessenger/core/internal/testdb"
	"github.com/jackc/pgx/v5/pgxpool"
)

const (
	agentTestOrgID    = "00000000-0000-7000-8000-000000000201"
	agentTestOwnerID  = "00000000-0000-7000-8000-000000000202"
	agentTestMemberID = "00000000-0000-7000-8000-000000000203"
	agentTestChatID   = "00000000-0000-7000-8000-000000000204"
)

func TestAgentModelKeyHashScopesVisibilityAndAudit(t *testing.T) {
	pool := testdb.New(t)
	seedAgentModel(t, pool)
	service := NewService(pool)
	var revokedRealtime []string
	service.SetRevokeSession(func(keyID string) { revokedRealtime = append(revokedRealtime, keyID) })
	owner := identity.User{ActorID: agentTestOwnerID, OrgID: agentTestOrgID, OrgRole: "owner"}
	member := identity.User{ActorID: agentTestMemberID, OrgID: agentTestOrgID, OrgRole: "member"}

	if _, err := service.Create(t.Context(), member, CreateInput{DisplayName: "Forbidden", Handle: "forbidden", Kind: "builtin"}); !errors.Is(err, ErrForbidden) {
		t.Fatalf("member create error = %v", err)
	}
	created, err := service.Create(t.Context(), owner, CreateInput{
		DisplayName: "History helper", Handle: "history-helper", Kind: "external",
		Description: "Answers from workspace history", Enabled: true,
		AllowedScopes: []Scope{ScopeSearchRead, ScopeMessagesWrite, ScopeMessagesRead, ScopeSearchRead},
		EndpointURL:   "https://agents.example.test/runtime", ChatIDs: []string{agentTestChatID, agentTestChatID},
	})
	if err != nil {
		t.Fatal(err)
	}
	if created.ID == "" || created.OwnerActorID != owner.ActorID || len(created.ChatIDs) != 1 || len(created.AllowedScopes) != 3 {
		t.Fatalf("created agent = %+v", created)
	}
	visible, err := service.List(t.Context(), member)
	if err != nil || len(visible) != 1 || visible[0].EndpointURL != "" {
		t.Fatalf("member-visible agents = %+v, err=%v", visible, err)
	}

	expiresAt := time.Now().UTC().Add(time.Hour)
	key, err := service.CreateKey(t.Context(), owner, created.ID, CreateKeyInput{
		Name: "runtime", Scopes: []Scope{ScopeMessagesRead, ScopeMessagesWrite}, RateLimitPerMinute: 30, ExpiresAt: &expiresAt,
	})
	if err != nil {
		t.Fatal(err)
	}
	if key.Secret == "" || key.Prefix == "" || key.Secret[:len(key.Prefix)] != key.Prefix {
		t.Fatalf("created API key = %+v", key)
	}
	if _, err := service.CreateKey(t.Context(), owner, created.ID, CreateKeyInput{
		Name: "too broad", Scopes: []Scope{ScopeFilesRead}, RateLimitPerMinute: 10,
	}); !errors.Is(err, ErrInvalid) {
		t.Fatalf("over-scoped key error = %v", err)
	}
	keys, err := service.ListKeys(t.Context(), owner, created.ID)
	if err != nil || len(keys) != 1 || keys[0].ID != key.ID {
		t.Fatalf("listed keys = %+v, err=%v", keys, err)
	}
	authenticatedUser, authenticatedIdentity, err := service.AuthenticateKey(t.Context(), key.Secret)
	if err != nil || authenticatedUser.ActorID != created.ID || authenticatedIdentity.AuthenticationKind != "api_key" || authenticatedIdentity.KeyID != key.ID {
		t.Fatalf("authenticated agent = %+v identity=%+v err=%v", authenticatedUser, authenticatedIdentity, err)
	}
	narrowed := []Scope{ScopeSearchRead}
	updated, err := service.Update(t.Context(), owner, created.ID, UpdateInput{AllowedScopes: &narrowed})
	if err != nil || len(updated.AllowedScopes) != 1 || updated.AllowedScopes[0] != ScopeSearchRead {
		t.Fatalf("updated agent = %+v, err=%v", updated, err)
	}
	if _, _, err := service.AuthenticateKey(t.Context(), key.Secret); !errors.Is(err, identity.ErrUnauthorized) {
		t.Fatalf("over-scoped key remained usable: %v", err)
	}
	if len(revokedRealtime) != 1 || revokedRealtime[0] != key.ID {
		t.Fatalf("realtime revocations = %v", revokedRealtime)
	}
	var storedHash []byte
	if err := pool.QueryRow(t.Context(), `SELECT key_hash FROM agent_api_keys WHERE id=$1`, key.ID).Scan(&storedHash); err != nil {
		t.Fatal(err)
	}
	wantHash := sha256.Sum256([]byte(key.Secret))
	if !bytes.Equal(storedHash, wantHash[:]) || bytes.Contains(storedHash, []byte(key.Secret)) {
		t.Fatalf("stored key material is not a SHA-256 digest")
	}
	publicJSON, err := json.Marshal(key.APIKey)
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(publicJSON, []byte(key.Secret)) || bytes.Contains(publicJSON, storedHash) {
		t.Fatalf("key listing model leaked secret material: %s", publicJSON)
	}
	if err := service.RevokeKey(t.Context(), owner, created.ID, key.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("automatically revoked key revoke error = %v", err)
	}
	var revoked bool
	if err := pool.QueryRow(t.Context(), `SELECT revoked_at IS NOT NULL FROM agent_api_keys WHERE id=$1`, key.ID).Scan(&revoked); err != nil || !revoked {
		t.Fatalf("revoked=%v err=%v", revoked, err)
	}
	var auditActions []string
	rows, err := pool.Query(t.Context(), `SELECT action FROM audit_log WHERE target_id=$1 ORDER BY created_at`, created.ID)
	if err != nil {
		t.Fatal(err)
	}
	for rows.Next() {
		var action string
		if err := rows.Scan(&action); err != nil {
			t.Fatal(err)
		}
		auditActions = append(auditActions, action)
	}
	rows.Close()
	if len(auditActions) != 3 || auditActions[0] != "agent.create" || auditActions[1] != "agent.key.create" || auditActions[2] != "agent.update" {
		t.Fatalf("agent audit actions = %v", auditActions)
	}
}

func TestAgentCreateValidationAndManagerPermission(t *testing.T) {
	pool := testdb.New(t)
	seedAgentModel(t, pool)
	service := NewService(pool)
	manager := identity.User{ActorID: agentTestMemberID, OrgID: agentTestOrgID, OrgRole: "admin", Permissions: []permission.Code{permission.AgentsManage}}
	invalid, err := pool.Begin(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	if _, err := invalid.Exec(t.Context(), `INSERT INTO agents(actor_id,org_id,owner_actor_id,kind) VALUES($1,$2,$3,'builtin')`, agentTestMemberID, agentTestOrgID, agentTestOwnerID); err != nil {
		t.Fatal(err)
	}
	if err := invalid.Commit(t.Context()); err == nil {
		t.Fatal("database accepted an agents row backed by a user actor")
	}

	if _, err := service.Create(t.Context(), manager, CreateInput{DisplayName: "Unsafe", Handle: "unsafe", Kind: "external", EndpointURL: "https://user:secret@example.test"}); !errors.Is(err, ErrInvalid) {
		t.Fatalf("credential-bearing URL error = %v", err)
	}
	if _, err := service.Create(t.Context(), manager, CreateInput{DisplayName: "Bad scope", Handle: "bad-scope", Kind: "builtin", AllowedScopes: []Scope{"organization:admin"}}); !errors.Is(err, ErrInvalid) {
		t.Fatalf("unknown scope error = %v", err)
	}
	created, err := service.Create(t.Context(), manager, CreateInput{DisplayName: "Disabled", Handle: "disabled-agent", Kind: "builtin", Enabled: false})
	if err != nil {
		t.Fatal(err)
	}
	ordinary := identity.User{ActorID: agentTestOwnerID, OrgID: agentTestOrgID, OrgRole: "member"}
	if _, err := service.Get(t.Context(), ordinary, created.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("disabled agent disclosure error = %v", err)
	}
}

func seedAgentModel(t *testing.T, pool *pgxpool.Pool) {
	t.Helper()
	tx, err := pool.Begin(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(t.Context())
	if _, err := tx.Exec(t.Context(), `INSERT INTO organizations(id,name,slug) VALUES($1,'Agent model','agent-model')`, agentTestOrgID); err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(t.Context(), `
		INSERT INTO actors(id,org_id,type,org_role,display_name,handle) VALUES
		($1,$3,'user','owner','Owner','owner'),($2,$3,'user','member','Member','member')`, agentTestOwnerID, agentTestMemberID, agentTestOrgID); err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(t.Context(), `INSERT INTO users(actor_id,org_id,email,password_hash) VALUES($1,$3,'owner@example.test','hash'),($2,$3,'member@example.test','hash')`, agentTestOwnerID, agentTestMemberID, agentTestOrgID); err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(t.Context(), `INSERT INTO chats(id,org_id,kind,visibility,name,created_by) VALUES($1,$2,'group','private','Agent chat',$3)`, agentTestChatID, agentTestOrgID, agentTestOwnerID); err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(t.Context(), `INSERT INTO chat_members(chat_id,actor_id,org_id,role) VALUES($1,$2,$3,'owner')`, agentTestChatID, agentTestOwnerID, agentTestOrgID); err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(t.Context()); err != nil {
		t.Fatal(err)
	}
}
