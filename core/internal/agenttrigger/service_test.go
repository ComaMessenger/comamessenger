package agenttrigger_test

import (
	"encoding/json"
	"errors"
	"testing"
	"time"

	"github.com/comamessenger/comamessenger/core/internal/agent"
	"github.com/comamessenger/comamessenger/core/internal/agenttrigger"
	"github.com/comamessenger/comamessenger/core/internal/id"
	"github.com/comamessenger/comamessenger/core/internal/identity"
	"github.com/comamessenger/comamessenger/core/internal/message"
	"github.com/comamessenger/comamessenger/core/internal/testdb"
	"github.com/jackc/pgx/v5/pgxpool"
)

const (
	triggerTestOrgID   = "00000000-0000-7000-8000-000000000271"
	triggerTestOwnerID = "00000000-0000-7000-8000-000000000272"
	triggerTestChatID  = "00000000-0000-7000-8000-000000000273"
)

func TestDurableEventAndScheduleDispatch(t *testing.T) {
	pool := testdb.New(t)
	seedTriggerModel(t, pool)
	owner := identity.User{ActorID: triggerTestOwnerID, OrgID: triggerTestOrgID, OrgRole: "owner"}
	agentService := agent.NewService(pool)
	createdAgent, err := agentService.Create(t.Context(), owner, agent.CreateInput{
		DisplayName: "Trigger agent", Handle: "trigger-agent", Kind: "builtin", Enabled: true,
		ChatIDs: []string{triggerTestChatID}, Provider: "test", Model: "test-model",
	})
	if err != nil {
		t.Fatal(err)
	}
	service := agenttrigger.NewService(pool, nil)
	everyMessage, err := service.Create(t.Context(), owner, createdAgent.ID, agenttrigger.CreateInput{
		Type: "every_message", Config: json.RawMessage(`{}`), Enabled: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := service.Create(t.Context(), owner, createdAgent.ID, agenttrigger.CreateInput{
		Type: "command", Config: json.RawMessage(`{"command":"bad command"}`), Enabled: true,
	}); !errors.Is(err, agenttrigger.ErrInvalid) {
		t.Fatalf("invalid command error = %v", err)
	}

	messageService := message.NewService(pool, 64*1024, 100, nil)
	clientID := mustTriggerID(t)
	if _, _, err := messageService.Create(t.Context(), owner, triggerTestChatID, message.CreateInput{
		ClientMsgID: clientID, Body: "hello trigger", BodyFormat: "plain",
	}); err != nil {
		t.Fatal(err)
	}
	if err := service.DispatchEvents(t.Context()); err != nil {
		t.Fatal(err)
	}
	if err := service.DispatchEvents(t.Context()); err != nil {
		t.Fatal(err)
	}
	assertTriggerRuns(t, pool, everyMessage.ID, 1)
	var eventInput map[string]any
	var eventTimeout time.Time
	if err := pool.QueryRow(t.Context(), `SELECT input,timeout_at FROM agent_runs WHERE trigger_id=$1`, everyMessage.ID).Scan(&eventInput, &eventTimeout); err != nil {
		t.Fatal(err)
	}
	if eventInput["message_body"] != "hello trigger" || eventInput["trigger_type"] != "every_message" {
		t.Fatalf("event run input = %#v", eventInput)
	}
	if remaining := time.Until(eventTimeout); remaining < 9*time.Minute || remaining > 11*time.Minute {
		t.Fatalf("event timeout remaining = %v, want configured 10 minutes", remaining)
	}

	agentUser := identity.User{ActorID: createdAgent.ID, OrgID: triggerTestOrgID, OrgRole: "member"}
	runID := mustTriggerID(t)
	correlationID := mustTriggerID(t)
	if _, err := pool.Exec(t.Context(), `INSERT INTO agent_runs(id,org_id,agent_id,chat_id,correlation_id,chain_depth,provider,model)
		VALUES($1,$2,$3,$4,$5,2,'test','test-model')`, runID, triggerTestOrgID, createdAgent.ID, triggerTestChatID, correlationID); err != nil {
		t.Fatal(err)
	}
	agentMessage, _, err := messageService.CreateForAgentRun(t.Context(), agentUser, triggerTestChatID, message.CreateInput{
		ClientMsgID: mustTriggerID(t), Body: "my own output", BodyFormat: "plain",
	}, message.AgentProvenance{RunID: runID})
	if err != nil {
		t.Fatal(err)
	}
	var recordedDepth int
	if err := pool.QueryRow(t.Context(), `SELECT chain_depth FROM message_agent_provenance WHERE message_id=$1 AND run_id=$2`, agentMessage.ID, runID).Scan(&recordedDepth); err != nil {
		t.Fatal(err)
	}
	if recordedDepth != 2 {
		t.Fatalf("recorded chain depth = %d, want 2", recordedDepth)
	}
	if err := service.DispatchEvents(t.Context()); err != nil {
		t.Fatal(err)
	}
	assertTriggerRuns(t, pool, everyMessage.ID, 1)

	schedule, err := service.Create(t.Context(), owner, createdAgent.ID, agenttrigger.CreateInput{
		Type: "schedule", Enabled: true, MissedRunsPolicy: "latest", Timezone: "Asia/Yekaterinburg",
		Config: json.RawMessage(`{"chat_id":"` + triggerTestChatID + `","hour":12,"minute":30,"days_of_week":[1,1,3]}`),
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(t.Context(), `UPDATE agent_triggers SET next_run_at=now()-interval '10 minutes' WHERE id=$1`, schedule.ID); err != nil {
		t.Fatal(err)
	}
	if err := service.DispatchSchedules(t.Context()); err != nil {
		t.Fatal(err)
	}
	if err := service.DispatchSchedules(t.Context()); err != nil {
		t.Fatal(err)
	}
	assertTriggerRuns(t, pool, schedule.ID, 1)
	var scheduleInput map[string]any
	if err := pool.QueryRow(t.Context(), `SELECT input FROM agent_runs WHERE trigger_id=$1`, schedule.ID).Scan(&scheduleInput); err != nil {
		t.Fatal(err)
	}
	if scheduleInput["chat_id"] != triggerTestChatID || scheduleInput["timezone"] != "Asia/Yekaterinburg" {
		t.Fatalf("schedule run input = %#v", scheduleInput)
	}

	disabled := false
	updated, err := service.Update(t.Context(), owner, createdAgent.ID, everyMessage.ID, agenttrigger.UpdateInput{Enabled: &disabled})
	if err != nil || updated.Enabled {
		t.Fatalf("updated trigger = %+v, err=%v", updated, err)
	}
	if err := service.Delete(t.Context(), owner, createdAgent.ID, everyMessage.ID); !errors.Is(err, agenttrigger.ErrConflict) {
		t.Fatalf("delete trigger with run history error = %v", err)
	}
	var auditCount int
	if err := pool.QueryRow(t.Context(), `SELECT count(*) FROM audit_log WHERE target_id=$1 AND action LIKE 'agent.trigger.%'`, createdAgent.ID).Scan(&auditCount); err != nil {
		t.Fatal(err)
	}
	if auditCount != 3 {
		t.Fatalf("trigger audit count = %d, want 3", auditCount)
	}
}

func seedTriggerModel(t *testing.T, pool *pgxpool.Pool) {
	t.Helper()
	tx, err := pool.Begin(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(t.Context())
	if _, err := tx.Exec(t.Context(), `INSERT INTO organizations(id,name,slug) VALUES($1,'Trigger model','trigger-model')`, triggerTestOrgID); err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(t.Context(), `INSERT INTO actors(id,org_id,type,org_role,display_name,handle)
		VALUES($1,$2,'user','owner','Owner','owner')`, triggerTestOwnerID, triggerTestOrgID); err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(t.Context(), `INSERT INTO users(actor_id,org_id,email,password_hash)
		VALUES($1,$2,'trigger-owner@example.test','hash')`, triggerTestOwnerID, triggerTestOrgID); err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(t.Context(), `INSERT INTO chats(id,org_id,kind,visibility,name,created_by)
		VALUES($1,$2,'group','private','Trigger chat',$3)`, triggerTestChatID, triggerTestOrgID, triggerTestOwnerID); err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(t.Context(), `INSERT INTO chat_members(chat_id,actor_id,org_id,role)
		VALUES($1,$2,$3,'owner')`, triggerTestChatID, triggerTestOwnerID, triggerTestOrgID); err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(t.Context()); err != nil {
		t.Fatal(err)
	}
}

func assertTriggerRuns(t *testing.T, pool *pgxpool.Pool, triggerID string, want int) {
	t.Helper()
	var count int
	if err := pool.QueryRow(t.Context(), `SELECT count(*) FROM agent_runs WHERE trigger_id=$1`, triggerID).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != want {
		t.Fatalf("trigger runs = %d, want %d", count, want)
	}
}

func mustTriggerID(t *testing.T) string {
	t.Helper()
	value, err := id.New()
	if err != nil {
		t.Fatal(err)
	}
	return value
}
