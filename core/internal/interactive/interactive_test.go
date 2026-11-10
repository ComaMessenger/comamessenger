package interactive_test

import (
	"context"
	"encoding/json"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/comamessenger/comamessenger/core/internal/access"
	"github.com/comamessenger/comamessenger/core/internal/agent"
	"github.com/comamessenger/comamessenger/core/internal/agentmemory"
	"github.com/comamessenger/comamessenger/core/internal/agenttool"
	"github.com/comamessenger/comamessenger/core/internal/chat"
	"github.com/comamessenger/comamessenger/core/internal/files"
	"github.com/comamessenger/comamessenger/core/internal/identity"
	"github.com/comamessenger/comamessenger/core/internal/interactive"
	"github.com/comamessenger/comamessenger/core/internal/message"
	"github.com/comamessenger/comamessenger/core/internal/search"
	"github.com/comamessenger/comamessenger/core/internal/testdb"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

type world struct {
	pool        *pgxpool.Pool
	messages    *message.Service
	interactive *interactive.Service
	executor    *agenttool.Executor
	agents      *agent.Service
	orgID       string
	owner       identity.User
	first       identity.User
	second      identity.User
	outsider    identity.User
	agent       identity.User
	chatID      string
	runID       string
	lease       string
	correlation string
}

var allScopes = []string{"runtime:execute", "messages:read", "messages:write", "messages:interactive", "followups:write"}

func setup(t *testing.T) *world {
	t.Helper()
	pool := testdb.New(t)
	ctx := context.Background()
	w := &world{pool: pool, orgID: uuid.NewString(), chatID: uuid.NewString(), runID: uuid.NewString(), lease: uuid.NewString(), correlation: uuid.NewString()}
	w.owner = identity.User{ActorID: uuid.NewString(), OrgID: w.orgID, OrgRole: "owner"}
	w.first = identity.User{ActorID: uuid.NewString(), OrgID: w.orgID, OrgRole: "member"}
	w.second = identity.User{ActorID: uuid.NewString(), OrgID: w.orgID, OrgRole: "member"}
	w.outsider = identity.User{ActorID: uuid.NewString(), OrgID: w.orgID, OrgRole: "member"}
	w.agent = identity.User{ActorID: uuid.NewString(), OrgID: w.orgID, OrgRole: "member"}
	statements := []struct {
		query string
		args  []any
	}{
		{`INSERT INTO organizations(id,name,slug) VALUES($1,'Interactive','interactive')`, []any{w.orgID}},
		{`INSERT INTO actors(id,org_id,type,org_role,display_name,handle) VALUES
			($2,$1,'user','owner','Owner','owner'),($3,$1,'user','member','First','first'),
			($4,$1,'user','member','Second','second'),($5,$1,'user','member','Outsider','outsider'),
			($6,$1,'agent','member','Control','control')`, []any{w.orgID, w.owner.ActorID, w.first.ActorID, w.second.ActorID, w.outsider.ActorID, w.agent.ActorID}},
		// Quiet hours are evaluated in each person's own timezone.
		{`UPDATE actors SET timezone='UTC' WHERE org_id=$1`, []any{w.orgID}},
		{`INSERT INTO agents(actor_id,org_id,owner_actor_id,kind,enabled,allowed_scopes,published_version,operational_status) VALUES($1,$2,$3,'builtin',true,$4,1,'active')`, []any{w.agent.ActorID, w.orgID, w.owner.ActorID, allScopes}},
		{`INSERT INTO chats(id,org_id,kind,visibility,name,created_by) VALUES($1,$2,'group','private','Instructors',$3)`, []any{w.chatID, w.orgID, w.owner.ActorID}},
		{`INSERT INTO chat_members(chat_id,actor_id,org_id,role) VALUES($1,$2,$6,'owner'),($1,$3,$6,'member'),($1,$4,$6,'member'),($1,$5,$6,'member')`, []any{w.chatID, w.owner.ActorID, w.first.ActorID, w.second.ActorID, w.agent.ActorID, w.orgID}},
		{`INSERT INTO agent_runs(id,org_id,agent_id,chat_id,correlation_id,status,lease_token,lease_expires_at,started_at,timeout_at,agent_version) VALUES($1,$2,$3,$4,$5,'running',$6,now()+interval '5 minutes',now(),now()+interval '10 minutes',1)`, []any{w.runID, w.orgID, w.agent.ActorID, w.chatID, w.correlation, w.lease}},
	}
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	for _, statement := range statements {
		if _, err := tx.Exec(ctx, statement.query, statement.args...); err != nil {
			t.Fatalf("seed %q: %v", statement.query, err)
		}
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	w.messages = message.NewService(pool, 64*1024, 100, nil)
	chats := chat.NewService(pool)
	limits := interactive.DefaultLimits()
	limits.QuietStartMinute, limits.QuietEndMinute = 0, 0
	w.interactive = interactive.NewService(pool, w.messages, chats, nil, limits)
	w.messages.SetActionHook(w.interactive.ActionHook())
	executor, err := agenttool.NewExecutor(pool, agenttool.Services{Chats: chats, Messages: w.messages, Search: &search.Service{}, Files: &files.Service{}, Memory: agentmemory.NewService(pool), Interactive: w.interactive}, true)
	if err != nil {
		t.Fatal(err)
	}
	w.executor = executor
	w.messages.SetConfirmationDecider(executor)
	w.agents = agent.NewService(pool)
	return w
}

func (w *world) invoke(t *testing.T, runID, lease, name string, arguments any) agenttool.InvokeResult {
	t.Helper()
	encoded, err := json.Marshal(arguments)
	if err != nil {
		t.Fatal(err)
	}
	authentication := access.Identity{AuthenticationKind: "api_key", ActorID: w.agent.ActorID, OrgID: w.orgID, KeyID: uuid.NewString(), Scopes: allScopes}
	result, err := w.executor.Invoke(context.Background(), agenttool.Invocation{User: w.agent, Identity: authentication, Name: name, Arguments: encoded,
		RunID: runID, LeaseToken: lease, CorrelationID: w.correlation, ToolCallID: uuid.NewString()})
	if err != nil {
		t.Fatalf("invoke %s: %v", name, err)
	}
	return result
}

func (w *world) count(t *testing.T, query string, args ...any) int {
	t.Helper()
	var value int
	if err := w.pool.QueryRow(context.Background(), query, args...).Scan(&value); err != nil {
		t.Fatalf("count %q: %v", query, err)
	}
	return value
}

func (w *world) postCard(t *testing.T, blocks map[string]any) message.Message {
	t.Helper()
	result := w.invoke(t, w.runID, w.lease, "post_card", map[string]any{"chat_id": w.chatID, "client_msg_id": uuid.NewString(), "blocks": blocks})
	if result.Confirmation != nil {
		t.Fatalf("post_card must not wait for confirmation")
	}
	var created message.Message
	if err := json.Unmarshal(result.Output, &created); err != nil {
		t.Fatal(err)
	}
	return created
}

func TestCardButtonPressedOnceAndOnlyByAllowedMembers(t *testing.T) {
	w := setup(t)
	ctx := context.Background()
	card := w.postCard(t, map[string]any{
		"version": 1,
		"card":    map[string]any{"title": "Slot 14:00", "status": map[string]any{"label": "Open", "tone": "info"}, "fields": []any{map[string]any{"label": "Room", "value": "Hall 1"}}},
		"actions": []any{
			map[string]any{"id": "accept", "label": "I take the slot", "style": "primary", "limit": "single"},
			map[string]any{"id": "can", "label": "Can", "group": "answer", "allowed": map[string]any{"actor_ids": []string{w.first.ActorID}}},
			map[string]any{"id": "cannot", "label": "Cannot", "group": "answer", "allowed": map[string]any{"actor_ids": []string{w.first.ActorID}}},
		},
	})
	if card.Blocks == nil || card.Body == "" || card.Blocks.Actions[0].Limit != "single" {
		t.Fatalf("card must persist blocks and a text fallback: %+v", card)
	}
	if _, err := w.messages.PressAction(ctx, w.outsider, card.ID, "accept"); !errors.Is(err, message.ErrNotFound) {
		t.Fatalf("outsider press error = %v, want not found", err)
	}
	if _, err := w.messages.PressAction(ctx, w.second, card.ID, "can"); !errors.Is(err, message.ErrForbidden) {
		t.Fatalf("not listed member press error = %v, want forbidden", err)
	}
	if _, err := w.messages.PressAction(ctx, w.first, card.ID, "missing"); !errors.Is(err, message.ErrNotFound) {
		t.Fatalf("unknown action error = %v", err)
	}

	pressed, err := w.messages.PressAction(ctx, w.first, card.ID, "accept")
	if err != nil || pressed.Replayed || pressed.Message.Version != card.Version+1 {
		t.Fatalf("first press = %+v err=%v", pressed, err)
	}
	if !pressed.Message.Blocks.Actions[0].Closed || len(pressed.Message.Blocks.Actions[0].Responses) != 1 {
		t.Fatalf("single action must close after the first press: %+v", pressed.Message.Blocks.Actions[0])
	}
	replayed, err := w.messages.PressAction(ctx, w.first, card.ID, "accept")
	if err != nil || !replayed.Replayed || !replayed.Response.RespondedAt.Equal(pressed.Response.RespondedAt) {
		t.Fatalf("second press = %+v err=%v", replayed, err)
	}
	if _, err := w.messages.PressAction(ctx, w.second, card.ID, "accept"); !errors.Is(err, message.ErrActionClosed) {
		t.Fatalf("taken single action error = %v, want closed", err)
	}
	if got := w.count(t, `SELECT count(*) FROM message_action_responses WHERE message_id=$1 AND action_id='accept'`, card.ID); got != 1 {
		t.Fatalf("accept responses = %d", got)
	}
	if got := w.count(t, `SELECT count(*) FROM agent_runs WHERE agent_id=$1 AND input->>'trigger_type'='message_action'`, w.agent.ActorID); got != 1 {
		t.Fatalf("wake runs after one press and one replay = %d, want 1", got)
	}

	const workers = 20
	var wait sync.WaitGroup
	results := make(chan message.ActionResult, workers)
	failures := make(chan error, workers)
	for range workers {
		wait.Add(1)
		go func() {
			defer wait.Done()
			result, err := w.messages.PressAction(ctx, w.first, card.ID, "can")
			if err != nil {
				failures <- err
				return
			}
			results <- result
		}()
	}
	wait.Wait()
	close(results)
	close(failures)
	for err := range failures {
		t.Fatalf("concurrent press failed: %v", err)
	}
	fresh := 0
	for result := range results {
		if !result.Replayed {
			fresh++
		}
	}
	if fresh != 1 {
		t.Fatalf("concurrent presses recorded %d times, want 1", fresh)
	}
	if _, err := w.messages.PressAction(ctx, w.first, card.ID, "cannot"); !errors.Is(err, message.ErrActionConflict) {
		t.Fatalf("second choice in a group error = %v, want conflict", err)
	}
	if got := w.count(t, `SELECT count(*) FROM agent_runs WHERE agent_id=$1 AND input->>'trigger_type'='message_action'`, w.agent.ActorID); got != 2 {
		t.Fatalf("wake runs = %d, want 2", got)
	}
	if got := w.count(t, `SELECT count(*) FROM events WHERE org_id=$1 AND subject_id=$2 AND type='message.updated'`, w.orgID, card.ID); got != 2 {
		t.Fatalf("card update events = %d, want 2", got)
	}

	// Agents keep collected responses when they rewrite the card.
	updated := w.invoke(t, w.runID, w.lease, "update_card", map[string]any{"message_id": card.ID, "blocks": map[string]any{
		"version": 1, "card": map[string]any{"title": "Slot 14:00", "status": map[string]any{"label": "Taken", "tone": "success"}},
		"actions": []any{map[string]any{"id": "accept", "label": "I take the slot", "limit": "single"}},
	}})
	var rewritten message.Message
	if err := json.Unmarshal(updated.Output, &rewritten); err != nil {
		t.Fatal(err)
	}
	if len(rewritten.Blocks.Actions) != 1 || len(rewritten.Blocks.Actions[0].Responses) != 1 || !rewritten.Blocks.Actions[0].Closed {
		t.Fatalf("update_card lost responses: %+v", rewritten.Blocks.Actions)
	}

	// Humans cannot post blocks, and agents cannot forge server bindings.
	if _, _, err := w.messages.Create(ctx, w.first, w.chatID, message.CreateInput{ClientMsgID: uuid.NewString(), Body: "x", Blocks: &message.Blocks{Version: 1, Card: &message.Card{Title: "x"}}}); !errors.Is(err, message.ErrInvalid) {
		t.Fatalf("human blocks error = %v", err)
	}
	encoded, _ := json.Marshal(map[string]any{"chat_id": w.chatID, "client_msg_id": uuid.NewString(), "blocks": map[string]any{"version": 1, "actions": []any{map[string]any{"id": "x", "label": "x", "binding": map[string]any{"kind": "tool_confirmation"}}}}})
	if _, err := w.executor.Invoke(ctx, agenttool.Invocation{User: w.agent, Identity: access.Identity{AuthenticationKind: "api_key", ActorID: w.agent.ActorID, OrgID: w.orgID, KeyID: uuid.NewString(), Scopes: allScopes},
		Name: "post_card", Arguments: encoded, RunID: w.runID, LeaseToken: w.lease, CorrelationID: w.correlation, ToolCallID: uuid.NewString()}); !errors.Is(err, agenttool.ErrInvalid) {
		t.Fatalf("forged binding error = %v", err)
	}
}

func TestDryRunCreatesNoCardsRemindersMessagesOrFollowups(t *testing.T) {
	w := setup(t)
	ctx := context.Background()
	dryRunID, dryLease := uuid.NewString(), uuid.NewString()
	config, _ := json.Marshal(map[string]any{"allowed_scopes": allScopes})
	if _, err := w.pool.Exec(ctx, `INSERT INTO agent_runs(id,org_id,agent_id,chat_id,correlation_id,status,lease_token,lease_expires_at,started_at,timeout_at,dry_run,agent_config) VALUES($1,$2,$3,$4,$5,'running',$6,now()+interval '5 minutes',now(),now()+interval '10 minutes',true,$7)`,
		dryRunID, w.orgID, w.agent.ActorID, w.chatID, uuid.NewString(), dryLease, config); err != nil {
		t.Fatal(err)
	}
	target, _, err := w.messages.Create(ctx, w.owner, w.chatID, message.CreateInput{ClientMsgID: uuid.NewString(), Body: "Please react"})
	if err != nil {
		t.Fatal(err)
	}
	messagesBefore := w.count(t, `SELECT count(*) FROM messages WHERE org_id=$1`, w.orgID)
	calls := []struct {
		name      string
		arguments map[string]any
	}{
		{"post_card", map[string]any{"chat_id": w.chatID, "client_msg_id": uuid.NewString(), "blocks": map[string]any{"version": 1, "card": map[string]any{"title": "Dry"}}}},
		{"start_collection", map[string]any{"message_id": target.ID, "response": "reaction", "expect_all_members": true, "deadline_in_seconds": 3600, "remind_every_seconds": 600, "reminder_text": "Please react"}},
		{"schedule_followup", map[string]any{"delay_seconds": 600, "note": "check again"}},
		{"send_direct_message", map[string]any{"actor_id": w.first.ActorID, "client_msg_id": uuid.NewString(), "body": "Hello"}},
	}
	for _, call := range calls {
		result := w.invoke(t, dryRunID, dryLease, call.name, call.arguments)
		var preview map[string]any
		if result.Confirmation != nil || json.Unmarshal(result.Output, &preview) != nil || preview["dry_run"] != true || preview["would_execute"] != call.name {
			t.Fatalf("%s dry run result = %s confirmation=%v", call.name, result.Output, result.Confirmation)
		}
	}
	for query, want := range map[string]int{
		`SELECT count(*) FROM messages WHERE org_id=$1`:                 messagesBefore,
		`SELECT count(*) FROM agent_collections WHERE org_id=$1`:        0,
		`SELECT count(*) FROM agent_followups WHERE org_id=$1`:          0,
		`SELECT count(*) FROM agent_reminders WHERE org_id=$1`:          0,
		`SELECT count(*) FROM agent_tool_confirmations WHERE org_id=$1`: 0,
		`SELECT count(*) FROM chats WHERE org_id=$1 AND kind='direct'`:  0,
	} {
		if got := w.count(t, query, w.orgID); got != want {
			t.Fatalf("%s = %d, want %d", query, got, want)
		}
	}
}

func TestFollowupSurvivesCoreRestart(t *testing.T) {
	w := setup(t)
	ctx := context.Background()
	result := w.invoke(t, w.runID, w.lease, "schedule_followup", map[string]any{"delay_seconds": 120, "note": "Check whether the slot was accepted", "context": map[string]any{"slot": "14:00"}})
	var scheduled interactive.Followup
	if err := json.Unmarshal(result.Output, &scheduled); err != nil || scheduled.Status != "pending" {
		t.Fatalf("scheduled=%+v err=%v output=%s", scheduled, err, result.Output)
	}
	if err := w.interactive.DispatchFollowups(ctx); err != nil {
		t.Fatal(err)
	}
	if got := w.count(t, `SELECT count(*) FROM agent_runs WHERE input->>'trigger_type'='followup'`); got != 0 {
		t.Fatalf("follow-up dispatched before it was due: %d", got)
	}

	// A new Core process over the same database picks the follow-up up.
	restarted := interactive.NewService(w.pool, message.NewService(w.pool, 64*1024, 100, nil), chat.NewService(w.pool), nil, interactive.DefaultLimits())
	restarted.SetClock(func() time.Time { return time.Now().Add(3 * time.Minute) })
	for range 2 {
		if err := restarted.Tick(ctx); err != nil {
			t.Fatal(err)
		}
	}
	var runInput json.RawMessage
	var runChat string
	if err := w.pool.QueryRow(ctx, `SELECT input, chat_id FROM agent_runs WHERE input->>'trigger_type'='followup'`).Scan(&runInput, &runChat); err != nil {
		t.Fatalf("follow-up run: %v", err)
	}
	var input map[string]any
	_ = json.Unmarshal(runInput, &input)
	if input["followup_id"] != scheduled.ID || input["note"] != "Check whether the slot was accepted" || runChat != w.chatID {
		t.Fatalf("follow-up run input = %s chat=%s", runInput, runChat)
	}
	if got := w.count(t, `SELECT count(*) FROM agent_followups WHERE id=$1 AND status='dispatched' AND run_id IS NOT NULL`, scheduled.ID); got != 1 {
		t.Fatalf("follow-up status not dispatched")
	}
}

func TestPauseCancelsRemindersAndFollowups(t *testing.T) {
	w := setup(t)
	ctx := context.Background()
	target, _, err := w.messages.Create(ctx, w.owner, w.chatID, message.CreateInput{ClientMsgID: uuid.NewString(), Body: "Mark yourself under this message"})
	if err != nil {
		t.Fatal(err)
	}
	start := func() interactive.Collection {
		result := w.invoke(t, w.runID, w.lease, "start_collection", map[string]any{"message_id": target.ID, "response": "reaction", "expect_all_members": true,
			"deadline_in_seconds": 7200, "remind_every_seconds": 600, "max_reminders": 2, "reminder_text": "Please mark yourself"})
		var collection interactive.Collection
		if err := json.Unmarshal(result.Output, &collection); err != nil {
			t.Fatal(err)
		}
		return collection
	}
	active := start()
	if len(active.PendingActorIDs) != 2 {
		t.Fatalf("pending = %v", active.PendingActorIDs)
	}
	clock := time.Now().Add(11 * time.Minute)
	w.interactive.SetClock(func() time.Time { return clock })
	if err := w.interactive.Tick(ctx); err != nil {
		t.Fatal(err)
	}
	if got := w.count(t, `SELECT count(*) FROM agent_reminders WHERE collection_id=$1`, active.ID); got != 2 {
		t.Fatalf("reminders for an active agent = %d, want 2", got)
	}
	if got := w.count(t, `SELECT count(*) FROM messages WHERE thread_root_id=$1 AND actor_id=$2 AND cardinality(mentioned_actor_ids)=2`, target.ID, w.agent.ActorID); got != 1 {
		t.Fatalf("thread reminder messages = %d, want 1", got)
	}

	w.invoke(t, w.runID, w.lease, "schedule_followup", map[string]any{"delay_seconds": 3600})
	if _, err := w.agents.Pause(ctx, w.owner, w.agent.ActorID); err != nil {
		t.Fatalf("pause: %v", err)
	}
	if got := w.count(t, `SELECT count(*) FROM agent_collections WHERE id=$1 AND status='open' AND next_reminder_at IS NULL AND reminders_canceled_at IS NOT NULL`, active.ID); got != 1 {
		t.Fatalf("pause must cancel reminders but keep the collection open")
	}
	if got := w.count(t, `SELECT count(*) FROM agent_followups WHERE agent_id=$1 AND status='canceled' AND reason='agent_paused'`, w.agent.ActorID); got != 1 {
		t.Fatalf("pause must cancel pending follow-ups")
	}
	clock = clock.Add(30 * time.Minute)
	if err := w.interactive.Tick(ctx); err != nil {
		t.Fatal(err)
	}
	if got := w.count(t, `SELECT count(*) FROM agent_reminders WHERE collection_id=$1`, active.ID); got != 2 {
		t.Fatalf("paused agent sent reminders: %d", got)
	}
	// Resuming does not restore canceled reminders. Resume itself needs a
	// configured model, so the state change is applied directly here.
	if _, err := w.pool.Exec(ctx, `UPDATE agents SET enabled=true,operational_status='active' WHERE actor_id=$1`, w.agent.ActorID); err != nil {
		t.Fatal(err)
	}
	clock = clock.Add(30 * time.Minute)
	if err := w.interactive.Tick(ctx); err != nil {
		t.Fatal(err)
	}
	if got := w.count(t, `SELECT count(*) FROM agent_reminders WHERE collection_id=$1`, active.ID); got != 2 {
		t.Fatalf("resume restored canceled reminders: %d", got)
	}
}

func TestCollectionCountsResponsesByReaction(t *testing.T) {
	w := setup(t)
	ctx := context.Background()
	target, _, err := w.messages.Create(ctx, w.owner, w.chatID, message.CreateInput{ClientMsgID: uuid.NewString(), Body: "Everyone read the new rules?"})
	if err != nil {
		t.Fatal(err)
	}
	result := w.invoke(t, w.runID, w.lease, "start_collection", map[string]any{"message_id": target.ID, "response": "reaction", "match": []string{"👍"}, "expect_all_members": true, "deadline_in_seconds": 3600, "note": "rules"})
	var collection interactive.Collection
	if err := json.Unmarshal(result.Output, &collection); err != nil {
		t.Fatal(err)
	}
	if len(collection.ExpectedActorIDs) != 2 || len(collection.Responded) != 0 {
		t.Fatalf("collection = %+v", collection)
	}
	if _, _, err := w.messages.PutReaction(ctx, w.first, target.ID, "👍"); err != nil {
		t.Fatal(err)
	}
	if _, _, err := w.messages.PutReaction(ctx, w.second, target.ID, "👀"); err != nil {
		t.Fatal(err)
	}
	if _, _, err := w.messages.PutReaction(ctx, w.owner, target.ID, "👍"); err != nil {
		t.Fatal(err)
	}
	current, err := w.interactive.GetCollection(ctx, w.agent, collection.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(current.Responded) != 1 || current.Responded[0].ActorID != w.first.ActorID || current.Responded[0].Value != "👍" ||
		len(current.PendingActorIDs) != 1 || current.PendingActorIDs[0] != w.second.ActorID {
		t.Fatalf("counted collection = %+v", current)
	}
	reactions := w.invoke(t, w.runID, w.lease, "get_reactions", map[string]any{"message_id": target.ID})
	var summary struct {
		NotReacted []string `json:"not_reacted_actor_ids"`
	}
	if err := json.Unmarshal(reactions.Output, &summary); err != nil || len(summary.NotReacted) != 0 {
		t.Fatalf("get_reactions = %s err=%v", reactions.Output, err)
	}
	if err := w.interactive.Tick(ctx); err != nil {
		t.Fatal(err)
	}
	if got := w.count(t, `SELECT count(*) FROM agent_collections WHERE id=$1 AND status='open'`, collection.ID); got != 1 {
		t.Fatal("collection closed before everyone answered")
	}
	if _, _, err := w.messages.PutReaction(ctx, w.second, target.ID, "👍"); err != nil {
		t.Fatal(err)
	}
	if err := w.interactive.Tick(ctx); err != nil {
		t.Fatal(err)
	}
	var reportInput json.RawMessage
	if err := w.pool.QueryRow(ctx, `SELECT run.input FROM agent_collections c JOIN agent_runs run ON run.id=c.report_run_id WHERE c.id=$1 AND c.status='completed'`, collection.ID).Scan(&reportInput); err != nil {
		t.Fatalf("completed collection report run: %v", err)
	}
	var report struct {
		TriggerType string   `json:"trigger_type"`
		Reason      string   `json:"reason"`
		Pending     []string `json:"pending_actor_ids"`
		Responded   []any    `json:"responded"`
	}
	if err := json.Unmarshal(reportInput, &report); err != nil || report.TriggerType != "collection" || report.Reason != "completed" || len(report.Pending) != 0 || len(report.Responded) != 2 {
		t.Fatalf("report input = %s err=%v", reportInput, err)
	}
}

func TestToolConfirmationIsDecidedFromChatCard(t *testing.T) {
	w := setup(t)
	ctx := context.Background()
	result := w.invoke(t, w.runID, w.lease, "send_direct_message", map[string]any{"actor_id": w.first.ActorID, "client_msg_id": uuid.NewString(), "body": "Your slot moved to 15:00"})
	if result.Confirmation == nil || result.Confirmation.CardMessageID == nil {
		t.Fatalf("direct message must wait for confirmation with a chat card: %+v", result)
	}
	cardID := *result.Confirmation.CardMessageID
	card, err := w.messages.Get(ctx, w.first, cardID)
	if err != nil || card.Blocks == nil || len(card.Blocks.Card.Fields) != 0 {
		t.Fatalf("confirmation card must not expose direct message content: %+v err=%v", card.Blocks, err)
	}
	if _, err := w.messages.PressAction(ctx, w.first, cardID, "approve"); !errors.Is(err, message.ErrForbidden) {
		t.Fatalf("member without agents.approve error = %v", err)
	}
	approved, err := w.messages.PressAction(ctx, w.owner, cardID, "approve")
	if err != nil {
		t.Fatalf("owner approve: %v", err)
	}
	if approved.Message.Blocks.Card.Status.Label != "Done" || !approved.Message.Blocks.Actions[0].Closed || len(approved.Message.Blocks.Actions[0].Responses) != 1 {
		t.Fatalf("resolved card = %+v", approved.Message.Blocks)
	}
	if got := w.count(t, `SELECT count(*) FROM messages m JOIN chats c ON c.id=m.chat_id AND c.kind='direct' WHERE m.actor_id=$1 AND m.body='Your slot moved to 15:00'`, w.agent.ActorID); got != 1 {
		t.Fatalf("direct messages after approval = %d", got)
	}
	if got := w.count(t, `SELECT count(*) FROM agent_tool_confirmations WHERE id=$1 AND status='completed' AND decided_by=$2`, result.Confirmation.ID, w.owner.ActorID); got != 1 {
		t.Fatal("confirmation must be completed by the card press")
	}
	again, err := w.messages.PressAction(ctx, w.owner, cardID, "approve")
	if err != nil || !again.Replayed {
		t.Fatalf("second approve = %+v err=%v", again, err)
	}
	if _, err := w.messages.PressAction(ctx, w.owner, cardID, "deny"); !errors.Is(err, message.ErrActionClosed) {
		t.Fatalf("deny after approval error = %v", err)
	}
}

func TestCollectionCountsButtonsAndReplies(t *testing.T) {
	w := setup(t)
	ctx := context.Background()
	card := w.postCard(t, map[string]any{"version": 1, "card": map[string]any{"title": "Who can take 16:00?"}, "actions": []any{
		map[string]any{"id": "can", "label": "Can", "group": "answer"}, map[string]any{"id": "cannot", "label": "Cannot", "group": "answer"},
	}})
	result := w.invoke(t, w.runID, w.lease, "start_collection", map[string]any{"message_id": card.ID, "response": "action",
		"expected_actor_ids": []string{w.first.ActorID, w.second.ActorID}, "deadline_in_seconds": 3600})
	var byButton interactive.Collection
	if err := json.Unmarshal(result.Output, &byButton); err != nil {
		t.Fatal(err)
	}
	if _, err := w.messages.PressAction(ctx, w.second, card.ID, "cannot"); err != nil {
		t.Fatal(err)
	}
	current, err := w.interactive.GetCollection(ctx, w.agent, byButton.ID)
	if err != nil || len(current.Responded) != 1 || current.Responded[0].Value != "cannot" || current.PendingActorIDs[0] != w.first.ActorID {
		t.Fatalf("button collection = %+v err=%v", current, err)
	}

	question, _, err := w.messages.Create(ctx, w.owner, w.chatID, message.CreateInput{ClientMsgID: uuid.NewString(), Body: "What is missing in Hall 1?"})
	if err != nil {
		t.Fatal(err)
	}
	result = w.invoke(t, w.runID, w.lease, "start_collection", map[string]any{"message_id": question.ID, "response": "reply", "expect_all_members": true, "deadline_in_seconds": 3600})
	var byReply interactive.Collection
	if err := json.Unmarshal(result.Output, &byReply); err != nil {
		t.Fatal(err)
	}
	if _, _, err := w.messages.Create(ctx, w.first, w.chatID, message.CreateInput{ClientMsgID: uuid.NewString(), Body: "Mats", ThreadRootID: &question.ID}); err != nil {
		t.Fatal(err)
	}
	if _, _, err := w.messages.Create(ctx, w.second, w.chatID, message.CreateInput{ClientMsgID: uuid.NewString(), Body: "Unrelated root message"}); err != nil {
		t.Fatal(err)
	}
	current, err = w.interactive.GetCollection(ctx, w.agent, byReply.ID)
	if err != nil || len(current.Responded) != 1 || current.Responded[0].ActorID != w.first.ActorID || len(current.PendingActorIDs) != 1 {
		t.Fatalf("reply collection = %+v err=%v", current, err)
	}
	if _, err := w.interactive.GetCollection(ctx, w.first, byReply.ID); !errors.Is(err, interactive.ErrNotFound) {
		t.Fatalf("another actor read the agent collection: %v", err)
	}
}
