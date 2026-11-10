package interactive_test

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
	"time"

	"github.com/comamessenger/comamessenger/core/internal/access"
	"github.com/comamessenger/comamessenger/core/internal/agentmemory"
	"github.com/comamessenger/comamessenger/core/internal/agenttool"
	"github.com/comamessenger/comamessenger/core/internal/chat"
	"github.com/comamessenger/comamessenger/core/internal/files"
	"github.com/comamessenger/comamessenger/core/internal/identity"
	"github.com/comamessenger/comamessenger/core/internal/interactive"
	"github.com/comamessenger/comamessenger/core/internal/message"
	"github.com/comamessenger/comamessenger/core/internal/search"
	"github.com/google/uuid"
)

// Security review of phase 5.3 J: private agent cards must be at least as
// guarded as direct messages. These tests drive the interactive service and
// the tool executor the runtime calls.

func directCard(title string) interactive.DirectCardInput {
	return interactive.DirectCardInput{ClientMsgID: uuid.NewString(), Body: title,
		Blocks: &message.Blocks{Version: message.BlocksVersion, Card: &message.Card{Title: title}}}
}

func (w *world) service(limits interactive.Limits, now time.Time) *interactive.Service {
	service := interactive.NewService(w.pool, w.messages, chat.NewService(w.pool), nil, limits)
	service.SetClock(func() time.Time { return now })
	return service
}

// addAgent adds a second agent to the chat with its own running run.
func (w *world) addAgent(t *testing.T, handle string) (identity.User, string) {
	t.Helper()
	other := identity.User{ActorID: uuid.NewString(), OrgID: w.orgID, OrgRole: "member"}
	runID := uuid.NewString()
	for _, statement := range []struct {
		query string
		args  []any
	}{
		{`INSERT INTO actors(id,org_id,type,org_role,display_name,handle) VALUES($1,$2,'agent','member',$3,$4)`, []any{other.ActorID, w.orgID, handle, handle}},
		{`INSERT INTO agents(actor_id,org_id,owner_actor_id,kind,enabled,allowed_scopes,published_version,operational_status) VALUES($1,$2,$3,'builtin',true,$4,1,'active')`, []any{other.ActorID, w.orgID, w.owner.ActorID, allScopes}},
		{`INSERT INTO chat_members(chat_id,actor_id,org_id,role) VALUES($1,$2,$3,'member')`, []any{w.chatID, other.ActorID, w.orgID}},
		{`INSERT INTO agent_runs(id,org_id,agent_id,chat_id,correlation_id,status,lease_token,lease_expires_at,started_at,timeout_at,agent_version) VALUES($1,$2,$3,$4,$5,'running',$6,now()+interval '5 minutes',now(),now()+interval '10 minutes',1)`, []any{runID, w.orgID, other.ActorID, w.chatID, uuid.NewString(), uuid.NewString()}},
	} {
		if _, err := w.pool.Exec(context.Background(), statement.query, statement.args...); err != nil {
			t.Fatalf("%v: %s", err, statement.query)
		}
	}
	return other, runID
}

// TestInteractiveScopeCannotReachPeoplePrivately: an agent with only
// messages:interactive (every published agent with the «cards» skill) cannot
// deliver a card privately, by post_card or otherwise.
func TestInteractiveScopeCannotReachPeoplePrivately(t *testing.T) {
	w := setup(t)
	authentication := access.Identity{AuthenticationKind: "api_key", ActorID: w.agent.ActorID, OrgID: w.orgID, KeyID: uuid.NewString(),
		Scopes: []string{"runtime:execute", "messages:interactive"}}
	for _, call := range []struct {
		name      string
		arguments map[string]any
	}{
		{"post_card", map[string]any{"direct_actor_id": w.first.ActorID, "client_msg_id": uuid.NewString(), "blocks": map[string]any{"version": 1, "card": map[string]any{"title": "x"}}}},
		{"send_direct_card", map[string]any{"actor_id": w.first.ActorID, "client_msg_id": uuid.NewString(), "blocks": map[string]any{"version": 1, "card": map[string]any{"title": "x"}}}},
	} {
		encoded, _ := json.Marshal(call.arguments)
		result, err := w.executor.Invoke(context.Background(), agenttool.Invocation{User: w.agent, Identity: authentication, Name: call.name, Arguments: encoded,
			RunID: w.runID, LeaseToken: w.lease, CorrelationID: w.correlation, ToolCallID: uuid.NewString()})
		if err == nil && result.Confirmation == nil {
			t.Fatalf("%s delivered privately with messages:interactive only", call.name)
		}
	}
	if got := w.count(t, `SELECT count(*) FROM chats WHERE org_id=$1 AND kind='direct'`, w.orgID); got != 0 {
		t.Fatalf("direct chats created: %d", got)
	}
}

// TestDirectCardsRespectQuietHours: nothing private at night, unless the
// person asked for it in this very run.
func TestDirectCardsRespectQuietHours(t *testing.T) {
	w := setup(t)
	now := time.Now().UTC()
	limits := interactive.DefaultLimits()
	minute := now.Hour()*60 + now.Minute()
	limits.QuietStartMinute, limits.QuietEndMinute = (minute+1440-60)%1440, (minute+60)%1440
	night := w.service(limits, now)
	input := directCard("Ночная карточка")
	input.ActorID = w.first.ActorID
	if _, err := night.SendDirectCard(context.Background(), w.agent, w.runID, input); !errors.Is(err, interactive.ErrLimit) {
		t.Fatalf("a direct card was delivered in quiet hours: %v", err)
	}
	asked := uuid.NewString()
	if _, err := w.pool.Exec(context.Background(), `INSERT INTO agent_runs(id,org_id,agent_id,chat_id,correlation_id,status,lease_token,lease_expires_at,started_at,timeout_at,agent_version,requested_by)
		VALUES($1,$2,$3,$4,$5,'running',$6,now()+interval '5 minutes',now(),now()+interval '10 minutes',1,$7)`, asked, w.orgID, w.agent.ActorID, w.chatID, uuid.NewString(), uuid.NewString(), w.first.ActorID); err != nil {
		t.Fatal(err)
	}
	input = directCard("Ответ на вашу просьбу")
	input.ActorID = w.first.ActorID
	if _, err := night.SendDirectCard(context.Background(), w.agent, asked, input); err != nil {
		t.Fatalf("the requester's own answer was refused at night: %v", err)
	}
}

// TestDirectCardsNeedASharedGroupChat: a direct chat with the agent is not a
// shared chat; leaving every group chat stops private delivery.
func TestDirectCardsNeedASharedGroupChat(t *testing.T) {
	w := setup(t)
	limits := interactive.DefaultLimits()
	limits.QuietStartMinute, limits.QuietEndMinute = 0, 0
	service := w.service(limits, time.Now())
	first := directCard("Первая")
	first.ActorID = w.first.ActorID
	if _, err := service.SendDirectCard(context.Background(), w.agent, w.runID, first); err != nil {
		t.Fatal(err)
	}
	if _, err := w.pool.Exec(context.Background(), `DELETE FROM chat_members WHERE chat_id=$1 AND actor_id=$2`, w.chatID, w.first.ActorID); err != nil {
		t.Fatal(err)
	}
	second := directCard("Вторая")
	second.ActorID = w.first.ActorID
	if _, err := service.SendDirectCard(context.Background(), w.agent, w.runID, second); !errors.Is(err, interactive.ErrForbidden) {
		t.Fatalf("delivered to a person who left every shared chat: %v", err)
	}
}

// TestEditingADirectCardCountsAsDelivery: update_card on a private card is a
// new delivery under the same daily cap.
func TestEditingADirectCardCountsAsDelivery(t *testing.T) {
	w := setup(t)
	limits := interactive.DefaultLimits()
	limits.QuietStartMinute, limits.QuietEndMinute = 0, 0
	limits.MaxDirectMessagesPerPersonPerDay = 1
	service := w.service(limits, time.Now())
	executor, err := agenttool.NewExecutor(w.pool, agenttool.Services{Chats: chat.NewService(w.pool), Messages: w.messages, Search: &search.Service{}, Files: &files.Service{}, Memory: agentmemory.NewService(w.pool), Interactive: service}, true)
	if err != nil {
		t.Fatal(err)
	}
	input := directCard("Отчёт")
	input.ActorID = w.first.ActorID
	sent, err := service.SendDirectCard(context.Background(), w.agent, w.runID, input)
	if err != nil {
		t.Fatal(err)
	}
	scopes := append([]string{"messages:direct_cards"}, allScopes...)
	if _, err := w.pool.Exec(context.Background(), `UPDATE agents SET allowed_scopes=$2 WHERE actor_id=$1`, w.agent.ActorID, scopes); err != nil {
		t.Fatal(err)
	}
	authentication := access.Identity{AuthenticationKind: "api_key", ActorID: w.agent.ActorID, OrgID: w.orgID, KeyID: uuid.NewString(), Scopes: scopes}
	encoded, _ := json.Marshal(map[string]any{"message_id": sent.ID, "blocks": map[string]any{"version": 1, "card": map[string]any{"title": "Совсем другой текст"}}})
	_, err = executor.Invoke(context.Background(), agenttool.Invocation{User: w.agent, Identity: authentication, Name: "update_card", Arguments: encoded,
		RunID: w.runID, LeaseToken: w.lease, CorrelationID: w.correlation, ToolCallID: uuid.NewString()})
	if !errors.Is(err, interactive.ErrLimit) {
		t.Fatalf("editing a private card bypassed the daily cap: %v", err)
	}
}

// TestPrivateDeliveriesShareOnePerPersonCap (review item 3): several agents
// in one chat together cannot exceed the per-person daily cap, which is
// below the sum of their per-agent caps.
func TestPrivateDeliveriesShareOnePerPersonCap(t *testing.T) {
	w := setup(t)
	limits := interactive.DefaultLimits()
	limits.QuietStartMinute, limits.QuietEndMinute = 0, 0
	service := w.service(limits, time.Now())
	second, secondRun := w.addAgent(t, "second-agent")
	delivered := 0
	for _, sender := range []struct {
		agent identity.User
		run   string
	}{{w.agent, w.runID}, {second, secondRun}} {
		for range limits.MaxDirectMessagesPerPersonPerDay {
			input := directCard("Карточка")
			input.ActorID = w.first.ActorID
			if _, err := service.SendDirectCard(context.Background(), sender.agent, sender.run, input); err == nil {
				delivered++
			} else if !errors.Is(err, interactive.ErrLimit) {
				t.Fatal(err)
			}
		}
	}
	if total := 2 * limits.MaxDirectMessagesPerPersonPerDay; delivered >= total {
		t.Fatalf("two agents delivered %d private cards to one person; per-agent caps alone allow %d", delivered, total)
	}
	var fromAll int
	if err := w.pool.QueryRow(context.Background(), `SELECT count(*) FROM messages m JOIN chats c ON c.id=m.chat_id AND c.kind='direct'
		JOIN chat_members member ON member.chat_id=c.id AND member.actor_id=$1 WHERE m.actor_id<>$1`, w.first.ActorID).Scan(&fromAll); err != nil {
		t.Fatal(err)
	}
	if fromAll != delivered {
		t.Fatalf("delivered %d, messages %d", delivered, fromAll)
	}
}
