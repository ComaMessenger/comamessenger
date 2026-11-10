package agenttrigger_test

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"github.com/comamessenger/comamessenger/core/internal/agent"
	"github.com/comamessenger/comamessenger/core/internal/agenttrigger"
	"github.com/comamessenger/comamessenger/core/internal/chat"
	"github.com/comamessenger/comamessenger/core/internal/identity"
	"github.com/comamessenger/comamessenger/core/internal/testdb"
	"github.com/comamessenger/comamessenger/core/internal/userstate"
	"github.com/google/uuid"
)

// TestEventRulesNeverSeePrivateEvents is the security review case: an event
// rule on "draft.updated" must neither be accepted nor fire, an unsent draft
// never reaches run input, and allowlisted events pass only allowlisted
// fields.
func TestEventRulesNeverSeePrivateEvents(t *testing.T) {
	pool := testdb.New(t)
	seedTriggerModel(t, pool)
	owner := identity.User{ActorID: triggerTestOwnerID, OrgID: triggerTestOrgID, OrgRole: "owner"}
	created, err := agent.NewService(pool).Create(t.Context(), owner, agent.CreateInput{
		DisplayName: "Watcher", Handle: "watcher", Kind: "builtin", Enabled: true,
		ChatIDs: []string{triggerTestChatID}, Provider: "openai", Model: "test-model",
	})
	if err != nil {
		t.Fatal(err)
	}
	service := agenttrigger.NewService(pool, nil)
	_, err = service.Create(t.Context(), owner, created.ID, agenttrigger.CreateInput{
		Type: "event", Config: json.RawMessage(`{"event_types":["draft.updated"]}`), Enabled: true,
	})
	if !errors.Is(err, agenttrigger.ErrInvalid) || !strings.Contains(err.Error(), "draft.updated") {
		t.Fatalf("private event rule error = %v", err)
	}
	joined, err := service.Create(t.Context(), owner, created.ID, agenttrigger.CreateInput{
		Type: "event", Config: json.RawMessage(`{"event_types":["member.joined"]}`), Enabled: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	// A rule saved before the allowlist existed keeps its row but never fires.
	if _, err := pool.Exec(t.Context(), `INSERT INTO agent_triggers(id,org_id,agent_id,type,config,enabled,timezone,missed_runs_policy)
		VALUES($1,$2,$3,'event','{"event_types":["draft.updated","read.marked"]}',true,'UTC','skip')`, uuid.NewString(), triggerTestOrgID, created.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(t.Context(), `UPDATE agents SET enabled=true WHERE actor_id=$1`, created.ID); err != nil {
		t.Fatal(err)
	}

	drafts := userstate.NewService(pool, 64*1024, nil)
	if _, _, err := drafts.PutDraft(t.Context(), owner, "", triggerTestChatID, userstate.PutDraftInput{Body: "SECRET unsent draft text"}); err != nil {
		t.Fatal(err)
	}
	newcomer := uuid.NewString()
	if _, err := pool.Exec(t.Context(), `INSERT INTO actors(id,org_id,type,org_role,display_name,handle) VALUES($1,$2,'user','member','Newcomer','newcomer')`, newcomer, triggerTestOrgID); err != nil {
		t.Fatal(err)
	}
	if _, err := chat.NewService(pool).AddMember(t.Context(), owner, triggerTestChatID, chat.MemberInput{ActorID: newcomer, Role: "member"}); err != nil {
		t.Fatal(err)
	}
	if err := service.DispatchEvents(t.Context()); err != nil {
		t.Fatal(err)
	}

	rows, err := pool.Query(t.Context(), `SELECT trigger_id::text,input::text FROM agent_runs WHERE agent_id=$1`, created.ID)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	runs := 0
	for rows.Next() {
		var triggerID, input string
		if err := rows.Scan(&triggerID, &input); err != nil {
			t.Fatal(err)
		}
		runs++
		if strings.Contains(input, "SECRET") || strings.Contains(input, "draft") {
			t.Fatalf("a private draft reached run input: %s", input)
		}
		var decoded struct {
			EventType string         `json:"event_type"`
			EventData map[string]any `json:"event_data"`
		}
		_ = json.Unmarshal([]byte(input), &decoded)
		if triggerID != joined.ID || decoded.EventType != "member.joined" || decoded.EventData["actor_id"] != newcomer || len(decoded.EventData) > 2 {
			t.Fatalf("unexpected run %s: %s", triggerID, input)
		}
	}
	if runs != 1 {
		t.Fatalf("runs = %d, want only the member.joined run", runs)
	}
}
