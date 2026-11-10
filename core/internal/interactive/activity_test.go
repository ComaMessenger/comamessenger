package interactive_test

import (
	"context"
	"encoding/json"
	"errors"
	"testing"

	"github.com/comamessenger/comamessenger/core/internal/agentrun"
	"github.com/comamessenger/comamessenger/core/internal/identity"
	"github.com/comamessenger/comamessenger/core/internal/interactive"
	"github.com/comamessenger/comamessenger/core/internal/message"
	"github.com/google/uuid"
)

// The activity view reads collections and follow-ups across agents with
// counts only; filters and statuses are validated.
func TestObserverListsCollectionsAndFollowups(t *testing.T) {
	w := setup(t)
	ctx := context.Background()
	target, _, err := w.messages.Create(ctx, w.owner, w.chatID, message.CreateInput{ClientMsgID: uuid.NewString(), Body: "Mark yourself"})
	if err != nil {
		t.Fatal(err)
	}
	w.invoke(t, w.runID, w.lease, "start_collection", map[string]any{"message_id": target.ID, "response": "reaction", "expect_all_members": true, "deadline_in_seconds": 3600, "note": "entry rules"})
	if _, _, err := w.messages.PutReaction(ctx, w.first, target.ID, "👍"); err != nil {
		t.Fatal(err)
	}
	w.invoke(t, w.runID, w.lease, "schedule_followup", map[string]any{"delay_seconds": 600, "note": "check the slot", "context": map[string]any{"secret": "kept"}})

	collections, err := w.interactive.ListCollections(ctx, w.orgID, "", "open")
	if err != nil {
		t.Fatal(err)
	}
	if len(collections) != 1 || collections[0].ExpectedCount != 2 || collections[0].RespondedCount != 1 || collections[0].Note != "entry rules" || collections[0].AgentID != w.agent.ActorID {
		t.Fatalf("collections = %+v", collections)
	}
	if other, err := w.interactive.ListCollections(ctx, w.orgID, uuid.NewString(), ""); err != nil || len(other) != 0 {
		t.Fatalf("filtered collections = %+v err=%v", other, err)
	}
	if foreign, err := w.interactive.ListCollections(ctx, uuid.NewString(), "", "all"); err != nil || len(foreign) != 0 {
		t.Fatalf("collections of another organization = %+v err=%v", foreign, err)
	}
	if _, err := w.interactive.ListCollections(ctx, w.orgID, "", "running"); !errors.Is(err, interactive.ErrInvalid) {
		t.Fatalf("unsupported status error = %v", err)
	}

	followups, err := w.interactive.ListOrganizationFollowups(ctx, w.orgID, w.agent.ActorID, "pending")
	if err != nil {
		t.Fatal(err)
	}
	if len(followups) != 1 || followups[0].Note != "check the slot" || followups[0].ChatID != w.chatID || followups[0].Status != "pending" {
		t.Fatalf("followups = %+v", followups)
	}
	encoded, _ := json.Marshal(followups[0])
	if json.Valid(encoded) && containsKey(encoded, "context") {
		t.Fatalf("follow-up summary leaks stored context: %s", encoded)
	}
	if _, err := w.interactive.ListOrganizationFollowups(ctx, w.orgID, "not-a-uuid", ""); !errors.Is(err, interactive.ErrInvalid) {
		t.Fatalf("invalid agent filter error = %v", err)
	}
}

// Dry-run write steps are recorded as previews so the check trace can say
// what the agent would have done, while nothing is written.
func TestDryRunRecordsPreviewSteps(t *testing.T) {
	w := setup(t)
	ctx := context.Background()
	dryRunID, dryLease := uuid.NewString(), uuid.NewString()
	config, _ := json.Marshal(map[string]any{"allowed_scopes": allScopes})
	if _, err := w.pool.Exec(ctx, `INSERT INTO agent_runs(id,org_id,agent_id,chat_id,correlation_id,status,lease_token,lease_expires_at,started_at,timeout_at,dry_run,agent_config) VALUES($1,$2,$3,$4,$5,'running',$6,now()+interval '5 minutes',now(),now()+interval '10 minutes',true,$7)`,
		dryRunID, w.orgID, w.agent.ActorID, w.chatID, uuid.NewString(), dryLease, config); err != nil {
		t.Fatal(err)
	}
	w.invoke(t, dryRunID, dryLease, "get_chat_messages", map[string]any{"chat_id": w.chatID})
	w.invoke(t, dryRunID, dryLease, "post_message", map[string]any{"chat_id": w.chatID, "client_msg_id": uuid.NewString(), "body": "Hello"})

	runs := agentrun.NewService(w.pool)
	steps, err := runs.ToolCalls(ctx, w.owner, dryRunID)
	if err != nil {
		t.Fatal(err)
	}
	if len(steps) != 2 || steps[0].ToolName != "get_chat_messages" || steps[0].DryRun || steps[1].ToolName != "post_message" || !steps[1].DryRun || steps[1].Status != "completed" || steps[1].FinishedAt == nil {
		t.Fatalf("steps = %+v", steps)
	}
	if got := w.count(t, `SELECT count(*) FROM agent_tool_confirmations WHERE run_id=$1`, dryRunID); got != 0 {
		t.Fatalf("dry run requested %d confirmations", got)
	}
	if _, err := runs.ToolCalls(ctx, w.first, dryRunID); !errors.Is(err, agentrun.ErrForbidden) {
		t.Fatalf("member without agent rights error = %v", err)
	}
	other := identity.User{ActorID: w.owner.ActorID, OrgID: uuid.NewString(), OrgRole: "owner"}
	if _, err := runs.ToolCalls(ctx, other, dryRunID); !errors.Is(err, agentrun.ErrNotFound) {
		t.Fatalf("run of another organization error = %v", err)
	}
}

func containsKey(document []byte, key string) bool {
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(document, &fields); err != nil {
		return false
	}
	_, ok := fields[key]
	return ok
}
