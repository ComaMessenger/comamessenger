package agent

import (
	"encoding/json"
	"errors"
	"slices"
	"strings"
	"testing"

	"github.com/comamessenger/comamessenger/core/internal/identity"
	"github.com/comamessenger/comamessenger/core/internal/permission"
	"github.com/comamessenger/comamessenger/core/internal/testdb"
)

const agentTestHallChatID = "00000000-0000-7000-8000-000000000205"

// TestConfirmationToneAndChatRolesFollowDraftPublishAndRollback checks the
// builder contracts of phase 5.3: per-tool confirmation with safe defaults
// and a server floor, the tone line and read/write chat roles are part of the
// version, change the live agent only on publish, are audited and come back
// on rollback; versions published before them restore the old behaviour.
func TestConfirmationToneAndChatRolesFollowDraftPublishAndRollback(t *testing.T) {
	pool := testdb.New(t)
	seedAgentModel(t, pool)
	tx, err := pool.Begin(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(t.Context())
	if _, err := tx.Exec(t.Context(), `INSERT INTO chats(id,org_id,kind,visibility,name,created_by) VALUES($1,$2,'group','private','Hall 1',$3)`, agentTestHallChatID, agentTestOrgID, agentTestOwnerID); err != nil {
		t.Fatal(err)
	}
	// The member builds agents in the hall chat they belong to.
	if _, err := tx.Exec(t.Context(), `INSERT INTO chat_members(chat_id,actor_id,org_id,role) VALUES($1,$2,$3,'owner'),($1,$4,$3,'member')`, agentTestHallChatID, agentTestOwnerID, agentTestOrgID, agentTestMemberID); err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(t.Context()); err != nil {
		t.Fatal(err)
	}
	service := NewService(pool)
	service.SetConfirmationFloor(map[string]bool{"add_reaction": true})
	owner := identity.User{ActorID: agentTestOwnerID, OrgID: agentTestOrgID, OrgRole: "owner"}

	created, err := service.Create(t.Context(), owner, CreateInput{DisplayName: "Handover", Handle: "handover", Kind: "external",
		EndpointURL: "https://agents.example.test/runtime", AllowedScopes: []Scope{ScopeMessagesRead}, ChatIDs: []string{agentTestChatID}})
	if err != nil {
		t.Fatal(err)
	}
	if created.ConfirmationPolicy["post_message"] != ConfirmationAuto || created.ConfirmationPolicy["post_card"] != ConfirmationAuto ||
		created.ConfirmationPolicy["send_direct_message"] != ConfirmationConfirm || created.ConfirmationPolicy["add_reaction"] != ConfirmationConfirm ||
		!slices.Equal(created.ConfirmationLocked, []string{"add_reaction"}) || created.Tone != "" ||
		!slices.Equal(created.ReadChatIDs, []string{agentTestChatID}) || !slices.Equal(created.WriteChatIDs, []string{agentTestChatID}) {
		t.Fatalf("created defaults = %+v", created)
	}
	if _, err := service.Update(t.Context(), owner, created.ID, UpdateInput{ConfirmationPolicy: map[string]string{"add_reaction": "auto"}}); !errors.Is(err, ErrInvalid) {
		t.Fatalf("loosening a server-confirmed tool error = %v", err)
	}
	if _, err := service.Update(t.Context(), owner, created.ID, UpdateInput{ConfirmationPolicy: map[string]string{"get_chat_messages": "confirm"}}); !errors.Is(err, ErrInvalid) {
		t.Fatalf("policy for a read tool error = %v", err)
	}
	rude := "rude"
	if _, err := service.Update(t.Context(), owner, created.ID, UpdateInput{Tone: &rude}); !errors.Is(err, ErrInvalid) {
		t.Fatalf("unknown tone error = %v", err)
	}
	if _, err := service.CreateKey(t.Context(), owner, created.ID, CreateKeyInput{Name: "runtime", Scopes: []Scope{ScopeMessagesRead}, RateLimitPerMinute: 10}); err != nil {
		t.Fatal(err)
	}
	if _, err := service.Publish(t.Context(), owner, created.ID, PublishOptions{}); err != nil {
		t.Fatal(err)
	}

	// A builder edits the draft but cannot put it in force through Update.
	builder := identity.User{ActorID: agentTestMemberID, OrgID: agentTestOrgID, OrgRole: "admin", Permissions: []permission.Code{permission.AgentsBuild}}
	enable := true
	if _, err := service.Update(t.Context(), builder, created.ID, UpdateInput{Enabled: &enable, ConfirmationPolicy: map[string]string{"send_direct_message": "auto"}}); !errors.Is(err, ErrForbidden) {
		t.Fatalf("builder publishing through update error = %v", err)
	}
	read, write, tone := []string{agentTestChatID, agentTestHallChatID}, []string{agentTestChatID}, "concise"
	draft, err := service.Update(t.Context(), builder, created.ID, UpdateInput{ReadChatIDs: &read, WriteChatIDs: &write, Tone: &tone,
		ConfirmationPolicy: map[string]string{"send_direct_message": "auto", "post_message": "confirm"}})
	if err != nil {
		t.Fatal(err)
	}
	expectedChats := []string{agentTestChatID, agentTestHallChatID}
	if !slices.Equal(draft.ChatIDs, expectedChats) || !slices.Equal(draft.ReadChatIDs, expectedChats) || !slices.Equal(draft.WriteChatIDs, []string{agentTestChatID}) ||
		draft.ConfirmationPolicy["send_direct_message"] != ConfirmationAuto || draft.ConfirmationPolicy["post_message"] != ConfirmationConfirm ||
		!strings.Contains(draft.Instructions, "Tone: answer briefly") || !strings.Contains(draft.Instructions, "only read and never post to: "+agentTestHallChatID) {
		t.Fatalf("draft = %+v", draft)
	}
	var liveTone, liveDirect string
	var liveReadOnly []string
	if err := pool.QueryRow(t.Context(), `SELECT tone,confirmation_policy->>'send_direct_message',read_only_chat_ids::text[] FROM agents WHERE actor_id=$1`, created.ID).Scan(&liveTone, &liveDirect, &liveReadOnly); err != nil ||
		liveTone != "" || liveDirect != ConfirmationConfirm || len(liveReadOnly) != 0 {
		t.Fatalf("live agent before publish tone=%q direct=%q readOnly=%v err=%v", liveTone, liveDirect, liveReadOnly, err)
	}
	// An external system whose writes the binding lets run by themselves.
	connection := "00000000-0000-7000-8000-000000000241"
	if _, err := pool.Exec(t.Context(), `INSERT INTO integration_mcp_connections(id,org_id,name,endpoint_url,created_by,updated_by,agent_use_allowed,writes_require_confirmation,tools,tools_refreshed_at)
		VALUES($1,$2,'accounting','https://mcp.example.test/rpc',$3,$3,true,false,'[{"name":"get_slots","read_only":true},{"name":"assign_instructor","read_only":false}]',now())`, connection, agentTestOrgID, agentTestOwnerID); err != nil {
		t.Fatal(err)
	}
	bindings := []MCPBinding{{ConnectionID: connection, AllowedTools: []string{"get_slots", "assign_instructor"}, RequireWriteConfirmation: true, ConfirmationPolicy: map[string]string{"assign_instructor": "auto"}}}
	if _, err := service.Update(t.Context(), owner, created.ID, UpdateInput{MCPBindings: &bindings}); err != nil {
		t.Fatal(err)
	}
	// Finding 7a: what stops waiting for a person — built-in and external —
	// must be acknowledged by the person publishing.
	var loosening *LooseningError
	if _, err := service.Publish(t.Context(), owner, created.ID, PublishOptions{}); !errors.As(err, &loosening) ||
		!slices.Equal(loosening.Loosened, []string{"send_direct_message", "mcp:accounting/assign_instructor"}) {
		t.Fatalf("publish without acknowledging error = %v", err)
	}
	if _, err := service.Publish(t.Context(), owner, created.ID, PublishOptions{AcknowledgeLoosened: true}); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(t.Context(), `SELECT tone,confirmation_policy->>'send_direct_message',read_only_chat_ids::text[] FROM agents WHERE actor_id=$1`, created.ID).Scan(&liveTone, &liveDirect, &liveReadOnly); err != nil ||
		liveTone != "concise" || liveDirect != ConfirmationAuto || !slices.Equal(liveReadOnly, []string{agentTestHallChatID}) {
		t.Fatalf("live agent after publish tone=%q direct=%q readOnly=%v err=%v", liveTone, liveDirect, liveReadOnly, err)
	}
	var auditRaw []byte
	if err := pool.QueryRow(t.Context(), `SELECT metadata FROM audit_log WHERE target_id=$1 AND action='agent.confirmation_policy.publish' ORDER BY created_at DESC LIMIT 1`, created.ID).Scan(&auditRaw); err != nil {
		t.Fatal(err)
	}
	var audit struct {
		Version      int      `json:"version"`
		Loosened     []string `json:"loosened"`
		Acknowledged bool     `json:"acknowledged"`
	}
	if err := json.Unmarshal(auditRaw, &audit); err != nil || audit.Version != 2 || !audit.Acknowledged ||
		!slices.Equal(audit.Loosened, []string{"send_direct_message", "mcp:accounting/assign_instructor"}) {
		t.Fatalf("publish audit = %s, err=%v", auditRaw, err)
	}

	// A member sees the task and tone, never chat identifiers.
	member := identity.User{ActorID: agentTestMemberID, OrgID: agentTestOrgID, OrgRole: "member"}
	visible, err := service.Get(t.Context(), member, created.ID)
	if err != nil || !strings.Contains(visible.Instructions, "Tone:") || strings.Contains(visible.Instructions, agentTestHallChatID) || len(visible.ReadChatIDs) != 0 {
		t.Fatalf("member view = %+v, err=%v", visible, err)
	}
	// The agent itself receives the full instructions for its runtime.
	self, err := service.Get(t.Context(), identity.User{ActorID: created.ID, OrgID: agentTestOrgID, OrgRole: "member"}, created.ID)
	if err != nil || !strings.Contains(self.Instructions, agentTestHallChatID) {
		t.Fatalf("agent view = %+v, err=%v", self, err)
	}

	// Changing only chat_ids keeps the roles of remaining chats.
	only := []string{agentTestChatID, agentTestHallChatID}
	kept, err := service.Update(t.Context(), owner, created.ID, UpdateInput{ChatIDs: &only})
	if err != nil || !slices.Equal(kept.WriteChatIDs, []string{agentTestChatID}) {
		t.Fatalf("chat_ids update = %+v, err=%v", kept, err)
	}

	versions, err := service.Versions(t.Context(), owner, created.ID)
	if err != nil {
		t.Fatal(err)
	}
	var firstVersionID string
	for _, version := range versions {
		if version.Version == 1 {
			firstVersionID = version.ID
		}
	}
	rolledBack, err := service.Rollback(t.Context(), owner, created.ID, firstVersionID)
	if err != nil || rolledBack.Tone != "" || rolledBack.ConfirmationPolicy["send_direct_message"] != ConfirmationConfirm ||
		!slices.Equal(rolledBack.WriteChatIDs, []string{agentTestChatID}) || !slices.Equal(rolledBack.ReadChatIDs, []string{agentTestChatID}) {
		t.Fatalf("rolled back draft = %+v, err=%v", rolledBack, err)
	}
	// A version published before the policy existed comes back with the
	// confirmations Core enforced then.
	if _, err := pool.Exec(t.Context(), `UPDATE agent_versions SET config=config-'confirmation_policy'-'tone'-'read_only_chat_ids'-'write_only_chat_ids' WHERE id=$1`, firstVersionID); err != nil {
		t.Fatal(err)
	}
	legacy, err := service.Rollback(t.Context(), owner, created.ID, firstVersionID)
	if err != nil || legacy.ConfirmationPolicy["post_message"] != ConfirmationConfirm || legacy.ConfirmationPolicy["post_card"] != ConfirmationAuto {
		t.Fatalf("legacy rollback = %+v, err=%v", legacy.ConfirmationPolicy, err)
	}
}

func TestInstructionsAndChatRoles(t *testing.T) {
	if got := Instructions("Answer questions.", "", nil, nil); got != "Answer questions." {
		t.Fatalf("plain instructions = %q", got)
	}
	got := Instructions("Answer.", "formal", []string{"a"}, []string{"b"})
	if !strings.Contains(got, "formal") || !strings.Contains(got, "never post to: a") || !strings.Contains(got, "never read: b") {
		t.Fatalf("instructions = %q", got)
	}
	chats, readOnly, writeOnly := chatRoles([]string{"b", "a"}, []string{"c", "a"})
	if !slices.Equal(chats, []string{"a", "b", "c"}) || !slices.Equal(readOnly, []string{"b"}) || !slices.Equal(writeOnly, []string{"c"}) {
		t.Fatalf("roles = %v %v %v", chats, readOnly, writeOnly)
	}
	if _, err := ParseConfirmationFloor("send_direct_message, post_message"); err != nil {
		t.Fatal(err)
	}
	if _, err := ParseConfirmationFloor("get_chat_messages"); err == nil {
		t.Fatal("floor accepted a read tool")
	}
}

// TestBuilderBindsOnlyChatsAndCollectionsTheyCanSee covers review finding 9:
// a builder adds the agent only to chats they belong to and binds only
// knowledge collections they may read; existing bindings stay untouched
// until someone changes them.
func TestBuilderBindsOnlyChatsAndCollectionsTheyCanSee(t *testing.T) {
	pool := testdb.New(t)
	seedAgentModel(t, pool)
	hidden := "00000000-0000-7000-8000-000000000231"
	tx, err := pool.Begin(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(t.Context())
	for _, statement := range []struct {
		query string
		args  []any
	}{
		{`INSERT INTO chats(id,org_id,kind,visibility,name,created_by) VALUES($1,$2,'group','private','Hall 1',$3)`, []any{agentTestHallChatID, agentTestOrgID, agentTestOwnerID}},
		{`INSERT INTO chat_members(chat_id,actor_id,org_id,role) VALUES($1,$3,$2,'owner')`, []any{agentTestHallChatID, agentTestOrgID, agentTestOwnerID}},
		{`INSERT INTO knowledge_collections(id,org_id,name,access,created_by,updated_by) VALUES($3,$1,'Хирургия','chats',$2,$2)`, []any{agentTestOrgID, agentTestOwnerID, hidden}},
		{`INSERT INTO knowledge_collection_chats(org_id,collection_id,chat_id) VALUES($1,$2,$3)`, []any{agentTestOrgID, hidden, agentTestHallChatID}},
	} {
		if _, err := tx.Exec(t.Context(), statement.query, statement.args...); err != nil {
			t.Fatalf("%s: %v", statement.query, err)
		}
	}
	if err := tx.Commit(t.Context()); err != nil {
		t.Fatal(err)
	}
	service := NewService(pool)
	owner := identity.User{ActorID: agentTestOwnerID, OrgID: agentTestOrgID, OrgRole: "owner"}
	builder := identity.User{ActorID: agentTestMemberID, OrgID: agentTestOrgID, OrgRole: "admin", Permissions: []permission.Code{permission.AgentsBuild}}
	if _, err := pool.Exec(t.Context(), `INSERT INTO chat_members(chat_id,actor_id,org_id,role) VALUES($1,$2,$3,'member')`, agentTestChatID, agentTestMemberID, agentTestOrgID); err != nil {
		t.Fatal(err)
	}
	created, err := service.Create(t.Context(), builder, CreateInput{DisplayName: "Reach", Handle: "reach", Kind: "external",
		EndpointURL: "https://agents.example.test/runtime", ChatIDs: []string{agentTestChatID}})
	if err != nil {
		t.Fatal(err)
	}
	chats := []string{agentTestChatID, agentTestHallChatID}
	if _, err := service.Update(t.Context(), builder, created.ID, UpdateInput{ChatIDs: &chats}); !errors.Is(err, ErrForbidden) {
		t.Fatalf("chat the builder is not in error = %v", err)
	}
	collections := []string{hidden}
	if _, err := service.Update(t.Context(), builder, created.ID, UpdateInput{KnowledgeCollectionIDs: &collections}); !errors.Is(err, ErrForbidden) {
		t.Fatalf("collection the builder cannot read error = %v", err)
	}
	if _, err := service.Create(t.Context(), builder, CreateInput{DisplayName: "Reach 2", Handle: "reach-2", Kind: "external",
		EndpointURL: "https://agents.example.test/runtime", ChatIDs: []string{agentTestHallChatID}}); !errors.Is(err, ErrForbidden) {
		t.Fatalf("create in a chat the builder is not in error = %v", err)
	}
	// The owner binds both; the builder may still edit other fields.
	if _, err := service.Update(t.Context(), owner, created.ID, UpdateInput{ChatIDs: &chats, KnowledgeCollectionIDs: &collections}); err != nil {
		t.Fatal(err)
	}
	description := "Отвечает по регламентам"
	if _, err := service.Update(t.Context(), builder, created.ID, UpdateInput{Description: &description}); err != nil {
		t.Fatalf("editing an agent with existing bindings: %v", err)
	}
}
