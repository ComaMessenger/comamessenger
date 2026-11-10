package agenttool

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/comamessenger/comamessenger/core/internal/access"
	"github.com/comamessenger/comamessenger/core/internal/agentmemory"
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

// newAgentDefaults is the policy of an agent created with today's defaults.
const newAgentDefaults = `{"post_message":"auto","reply_in_thread":"auto","add_reaction":"auto","post_card":"auto","update_card":"auto",
	"start_collection":"auto","schedule_followup":"auto","remember":"auto","send_direct_message":"confirm"}`

type directWorld struct {
	pool                     *pgxpool.Pool
	executor                 *Executor
	messages                 *message.Service
	interactive              *interactive.Service
	orgID, ownerID, veraID   string
	agentID                  string
	groupChat, otherChat, dm string
	groupMessage             string
	agentUser                identity.User
	authentication           access.Identity
}

func newDirectWorld(t *testing.T, limits interactive.Limits, clock time.Time) directWorld {
	t.Helper()
	pool := testdb.New(t)
	w := directWorld{pool: pool, orgID: uuid.NewString(), ownerID: uuid.NewString(), veraID: uuid.NewString(), agentID: uuid.NewString(),
		groupChat: uuid.NewString(), otherChat: uuid.NewString(), groupMessage: uuid.NewString()}
	tx, err := pool.Begin(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(t.Context())
	for _, statement := range []struct {
		sql  string
		args []any
	}{
		{`INSERT INTO organizations(id,name,slug) VALUES($1::uuid,'Direct','direct-' || substr($1::text,1,8))`, []any{w.orgID}},
		{`INSERT INTO actors(id,org_id,type,org_role,display_name,handle) VALUES
			($1,$4,'user','owner','Owner','owner'),($2,$4,'user','member','Вера','vera'),($3,$4,'agent','member','Передача','handover')`, []any{w.ownerID, w.veraID, w.agentID, w.orgID}},
		{`INSERT INTO agents(actor_id,org_id,owner_actor_id,kind,enabled,allowed_scopes,published_version,confirmation_policy)
			VALUES($1,$2,$3,'builtin',true,ARRAY['messages:read','messages:write','messages:interactive','followups:write','memory:write','runtime:execute'],1,$4)`, []any{w.agentID, w.orgID, w.ownerID, newAgentDefaults}},
		{`INSERT INTO chats(id,org_id,kind,visibility,name,created_by) VALUES($1,$3,'group','private','Зал 1',$4),($2,$3,'group','private','Администраторы',$4)`, []any{w.groupChat, w.otherChat, w.orgID, w.ownerID}},
		{`INSERT INTO chat_members(chat_id,actor_id,org_id,role) VALUES($1,$3,$5,'owner'),($1,$4,$5,'member'),($1,$6,$5,'member'),($2,$3,$5,'owner'),($2,$6,$5,'member')`,
			[]any{w.groupChat, w.otherChat, w.ownerID, w.veraID, w.orgID, w.agentID}},
		{`INSERT INTO messages(id,org_id,chat_id,actor_id,client_msg_id,create_fingerprint,body,created_seq) VALUES($1,$2,$3,$4,gen_random_uuid(),decode(repeat('00',32),'hex'),'Отметьтесь',1)`,
			[]any{w.groupMessage, w.orgID, w.groupChat, w.ownerID}},
	} {
		if _, err := tx.Exec(t.Context(), statement.sql, statement.args...); err != nil {
			t.Fatalf("seed: %v\n%s", err, statement.sql)
		}
	}
	if err := tx.Commit(t.Context()); err != nil {
		t.Fatal(err)
	}
	noop := func(string, int64) {}
	chats := chat.NewService(pool, noop)
	w.messages = message.NewService(pool, 65536, 100, noop)
	w.interactive = interactive.NewService(pool, w.messages, chats, nil, limits)
	w.interactive.SetClock(func() time.Time { return clock })
	w.executor, err = NewExecutor(pool, Services{Chats: chats, Messages: w.messages, Search: search.NewService(pool), Files: &files.Service{},
		Memory: agentmemory.NewService(pool), Interactive: w.interactive}, true)
	if err != nil {
		t.Fatal(err)
	}
	w.agentUser = identity.User{ActorID: w.agentID, OrgID: w.orgID, OrgRole: "member"}
	w.authentication = access.Identity{AuthenticationKind: "api_key", ActorID: w.agentID, OrgID: w.orgID, KeyID: uuid.NewString(),
		Scopes: []string{"messages:read", "messages:write", "messages:interactive", "followups:write", "memory:write", "runtime:execute"}}
	// The direct chat between the agent and Vera already exists, opened by
	// an earlier approved message.
	direct, err := chats.Create(t.Context(), w.agentUser, chat.CreateInput{Kind: "direct", Visibility: "private", MemberIDs: []string{w.veraID}})
	if err != nil {
		t.Fatal(err)
	}
	w.dm = direct.ID
	return w
}

func (w directWorld) run(t *testing.T, chatID, requestedBy string) (string, string, string) {
	t.Helper()
	runID, leaseToken, correlationID := uuid.NewString(), uuid.NewString(), uuid.NewString()
	var requester any
	if requestedBy != "" {
		requester = requestedBy
	}
	if _, err := w.pool.Exec(t.Context(), `INSERT INTO agent_runs(id,org_id,agent_id,chat_id,requested_by,correlation_id,status,lease_token,lease_expires_at,started_at,timeout_at,input)
		VALUES($1,$2,$3,$4,$5,$6,'running',$7,now()+interval '1 minute',now(),now()+interval '5 minutes','{"trigger_type":"schedule"}')`,
		runID, w.orgID, w.agentID, chatID, requester, correlationID, leaseToken); err != nil {
		t.Fatal(err)
	}
	return runID, leaseToken, correlationID
}

func (w directWorld) invoke(t *testing.T, run [3]string, name, arguments string) (InvokeResult, error) {
	t.Helper()
	return w.executor.Invoke(t.Context(), Invocation{User: w.agentUser, Identity: w.authentication, Name: name, Arguments: json.RawMessage(arguments),
		RunID: run[0], LeaseToken: run[1], CorrelationID: run[2], ToolCallID: uuid.NewString()})
}

func (w directWorld) dmMessages(t *testing.T) int {
	t.Helper()
	var count int
	// Confirmation cards in the run chat are not the agent's own writing.
	if err := w.pool.QueryRow(t.Context(), `SELECT count(*) FROM messages WHERE chat_id=$1 AND blocks IS NULL`, w.dm).Scan(&count); err != nil {
		t.Fatal(err)
	}
	return count
}

// TestWritingToAPersonDirectlyNeedsApprovalWhateverTheTool covers review
// findings 1, 2 and 8: the confirmation mode follows where and to whom the
// agent writes. Any write into a direct chat — a message, a thread reply, a
// card, a follow-up publishing there, a collection with direct reminders —
// is «writes to people directly» (send_direct_message, after approval by
// default), checked by the executor and again by the message service. Cards
// outside the run chat, cards with many mentions and large collections wait
// for approval too.
func TestWritingToAPersonDirectlyNeedsApprovalWhateverTheTool(t *testing.T) {
	noon := time.Date(2026, 11, 12, 12, 0, 0, 0, time.UTC)
	w := newDirectWorld(t, interactive.DefaultLimits(), noon)
	scheduled := func() [3]string {
		runID, lease, correlation := w.run(t, w.groupChat, "")
		return [3]string{runID, lease, correlation}
	}
	for name, arguments := range map[string]string{
		"post_message":      `{"chat_id":"` + w.dm + `","client_msg_id":"` + uuid.NewString() + `","body":"Вера, срочно"}`,
		"reply_in_thread":   `{"chat_id":"` + w.dm + `","client_msg_id":"` + uuid.NewString() + `","body":"x","thread_root_id":"` + uuid.NewString() + `"}`,
		"post_card":         `{"chat_id":"` + w.dm + `","client_msg_id":"` + uuid.NewString() + `","blocks":{"version":1,"card":{"title":"Слот"}}}`,
		"schedule_followup": `{"delay_seconds":600,"chat_id":"` + w.dm + `","note":"напомнить"}`,
		"start_collection":  `{"message_id":"` + w.groupMessage + `","response":"reaction","expected_actor_ids":["` + w.veraID + `"],"deadline_in_seconds":3600,"remind_every_seconds":600,"reminder_channel":"direct","reminder_text":"Отметьтесь"}`,
	} {
		result, err := w.invoke(t, scheduled(), name, arguments)
		if err != nil || result.Confirmation == nil {
			t.Fatalf("%s into a direct chat: confirmation=%v err=%v", name, result.Confirmation, err)
		}
		if result.Confirmation.ToolName != name {
			t.Fatalf("%s confirmation tool = %s", name, result.Confirmation.ToolName)
		}
	}
	if count := w.dmMessages(t); count != 0 {
		t.Fatalf("messages reached the direct chat before approval: %d", count)
	}

	// Cards: another chat follows post_message; many mentions or many
	// people to wait for always need approval.
	if _, err := w.pool.Exec(t.Context(), `UPDATE agents SET confirmation_policy=confirmation_policy || '{"post_message":"confirm"}' WHERE actor_id=$1`, w.agentID); err != nil {
		t.Fatal(err)
	}
	result, err := w.invoke(t, scheduled(), "post_card", `{"chat_id":"`+w.otherChat+`","client_msg_id":"`+uuid.NewString()+`","blocks":{"version":1,"card":{"title":"Итог"}}}`)
	if err != nil || result.Confirmation == nil {
		t.Fatalf("card in another chat: %+v err=%v", result, err)
	}
	mentions := make([]string, 11)
	for index := range mentions {
		mentions[index] = `"` + uuid.NewString() + `"`
	}
	result, err = w.invoke(t, scheduled(), "post_card", `{"chat_id":"`+w.groupChat+`","client_msg_id":"`+uuid.NewString()+`","mentioned_actor_ids":[`+strings.Join(mentions, ",")+`],"blocks":{"version":1,"card":{"title":"Все"}}}`)
	if err != nil || result.Confirmation == nil {
		t.Fatalf("card with 11 mentions: %+v err=%v", result, err)
	}
	people := make([]string, 51)
	for index := range people {
		people[index] = `"` + uuid.NewString() + `"`
	}
	result, err = w.invoke(t, scheduled(), "start_collection", `{"message_id":"`+w.groupMessage+`","response":"reaction","expected_actor_ids":[`+strings.Join(people, ",")+`],"deadline_in_seconds":3600}`)
	if err != nil || result.Confirmation == nil {
		t.Fatalf("collection of 51 people: %+v err=%v", result, err)
	}
	// A card in the run chat with a few mentions still runs by itself.
	result, err = w.invoke(t, scheduled(), "post_card", `{"chat_id":"`+w.groupChat+`","client_msg_id":"`+uuid.NewString()+`","mentioned_actor_ids":["`+w.veraID+`"],"blocks":{"version":1,"card":{"title":"Слот"}}}`)
	if err != nil || result.Confirmation != nil {
		t.Fatalf("card in the run chat: %+v err=%v", result, err)
	}

	// The exception: Vera started the run in her direct chat herself; the
	// answer follows the ordinary post_message setting.
	if _, err := w.pool.Exec(t.Context(), `UPDATE agents SET confirmation_policy=confirmation_policy || '{"post_message":"auto"}' WHERE actor_id=$1`, w.agentID); err != nil {
		t.Fatal(err)
	}
	runID, lease, correlation := w.run(t, w.dm, w.veraID)
	result, err = w.invoke(t, [3]string{runID, lease, correlation}, "post_message", `{"chat_id":"`+w.dm+`","client_msg_id":"`+uuid.NewString()+`","body":"Отвечаю на ваш вопрос"}`)
	if err != nil || result.Confirmation != nil || w.dmMessages(t) != 1 {
		t.Fatalf("answer in a run Vera started: %+v err=%v messages=%d", result, err, w.dmMessages(t))
	}

	// Second line: the message service refuses an unapproved direct write
	// that bypasses the executor.
	groupRun, _, _ := w.run(t, w.groupChat, "")
	if _, _, err := w.messages.CreateForAgentRun(t.Context(), w.agentUser, w.dm, message.CreateInput{ClientMsgID: uuid.NewString(), Body: "в обход", BodyFormat: "plain"},
		message.AgentProvenance{RunID: groupRun}); !errors.Is(err, interactive.ErrForbidden) {
		t.Fatalf("direct write past the executor error = %v", err)
	}

	// Approval executes exactly that call.
	pending, err := w.invoke(t, scheduled(), "post_message", `{"chat_id":"`+w.dm+`","client_msg_id":"`+uuid.NewString()+`","body":"Вера, слот ваш"}`)
	if err != nil || pending.Confirmation == nil {
		t.Fatal(err)
	}
	owner := identity.User{ActorID: w.ownerID, OrgID: w.orgID, OrgRole: "owner"}
	approved, err := w.executor.DecideConfirmation(t.Context(), owner, pending.Confirmation.ID, true)
	if err != nil || approved.Status != "completed" || w.dmMessages(t) != 2 {
		t.Fatalf("approved direct message = %+v err=%v messages=%d", approved, err, w.dmMessages(t))
	}
	// Finding 6: the continuation learns that the message was delivered, not
	// its text; the full result stays with the confirmation.
	var input string
	if err := w.pool.QueryRow(t.Context(), `SELECT input::text FROM agent_runs WHERE input->>'confirmation_id'=$1`, approved.ID).Scan(&input); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(input, "слот ваш") || !strings.Contains(input, `"delivered": true`) {
		t.Fatalf("continuation input = %s", input)
	}
}

// TestDirectWritesKeepPersonLimitsAndQuietHours: even when an agent may write
// to people by itself, the per-person daily limit across agents and the
// recipient's quiet hours apply to every direct write.
func TestDirectWritesKeepPersonLimitsAndQuietHours(t *testing.T) {
	limits := interactive.DefaultLimits()
	limits.MaxDirectMessagesPerPersonPerDay = 2
	night := time.Date(2026, 11, 12, 23, 30, 0, 0, time.UTC)
	w := newDirectWorld(t, limits, night)
	if _, err := w.pool.Exec(t.Context(), `UPDATE agents SET confirmation_policy=confirmation_policy || '{"send_direct_message":"auto"}' WHERE actor_id=$1`, w.agentID); err != nil {
		t.Fatal(err)
	}
	runID, _, _ := w.run(t, w.groupChat, "")
	post := func() error {
		_, _, err := w.messages.CreateForAgentRun(t.Context(), w.agentUser, w.dm, message.CreateInput{ClientMsgID: uuid.NewString(), Body: "x", BodyFormat: "plain"}, message.AgentProvenance{RunID: runID})
		return err
	}
	if err := post(); !errors.Is(err, interactive.ErrLimit) {
		t.Fatalf("direct write in quiet hours error = %v", err)
	}
	w.interactive.SetClock(func() time.Time { return night.Add(-11 * time.Hour) })
	for index := range 2 {
		if err := post(); err != nil {
			t.Fatalf("direct write %d: %v", index, err)
		}
	}
	if err := post(); !errors.Is(err, interactive.ErrLimit) {
		t.Fatalf("third direct write error = %v", err)
	}
}

// TestConfirmationCardShowsOnlyWhatTheChatMaySee covers finding 11: the
// card in the run chat shows the text of writes into that chat and the reach
// of a collection, never a memory value or a direct message.
func TestConfirmationCardShowsOnlyWhatTheChatMaySee(t *testing.T) {
	w := newDirectWorld(t, interactive.DefaultLimits(), time.Date(2026, 11, 12, 12, 0, 0, 0, time.UTC))
	if _, err := w.pool.Exec(t.Context(), `UPDATE agents SET confirmation_policy=confirmation_policy || '{"remember":"confirm"}' WHERE actor_id=$1`, w.agentID); err != nil {
		t.Fatal(err)
	}
	card := func(confirmation *Confirmation) string {
		t.Helper()
		if confirmation == nil || confirmation.CardMessageID == nil {
			t.Fatalf("no card for %+v", confirmation)
		}
		var blocks string
		if err := w.pool.QueryRow(t.Context(), `SELECT blocks::text FROM messages WHERE id=$1`, *confirmation.CardMessageID).Scan(&blocks); err != nil {
			t.Fatal(err)
		}
		return blocks
	}
	runID, lease, correlation := w.run(t, w.groupChat, "")
	run := [3]string{runID, lease, correlation}
	remembered, err := w.invoke(t, run, "remember", `{"key":"pin","value":"код от сейфа 4711"}`)
	if err != nil {
		t.Fatal(err)
	}
	if text := card(remembered.Confirmation); strings.Contains(text, "4711") {
		t.Fatalf("memory value on the card: %s", text)
	}
	direct, err := w.invoke(t, run, "send_direct_message", `{"actor_id":"`+w.veraID+`","client_msg_id":"`+uuid.NewString()+`","body":"личное для Веры"}`)
	if err != nil {
		t.Fatal(err)
	}
	if text := card(direct.Confirmation); strings.Contains(text, "личное") {
		t.Fatalf("direct message text on the card: %s", text)
	}
	collection, err := w.invoke(t, run, "start_collection", `{"message_id":"`+w.groupMessage+`","response":"reaction","expect_all_members":true,"deadline_in_seconds":3600,"remind_every_seconds":600,"reminder_channel":"direct","reminder_text":"Отметьтесь, пожалуйста"}`)
	if err != nil {
		t.Fatal(err)
	}
	if text := card(collection.Confirmation); !strings.Contains(text, "Отметьтесь, пожалуйста") || !strings.Contains(text, "recipients") {
		t.Fatalf("collection card lacks its reach: %s", text)
	}
}

// TestApprovedCallFollowsCurrentChatRoles covers review finding 7c: a call
// approved after the agent's chat roles changed runs under the new roles.
func TestApprovedCallFollowsCurrentChatRoles(t *testing.T) {
	w := newDirectWorld(t, interactive.DefaultLimits(), time.Date(2026, 11, 12, 12, 0, 0, 0, time.UTC))
	if _, err := w.pool.Exec(t.Context(), `UPDATE agents SET allowed_scopes=allowed_scopes||ARRAY['reactions:write'], confirmation_policy=confirmation_policy || '{"add_reaction":"confirm"}' WHERE actor_id=$1`, w.agentID); err != nil {
		t.Fatal(err)
	}
	w.authentication.Scopes = append(w.authentication.Scopes, "reactions:write")
	runID, lease, correlation := w.run(t, w.groupChat, "")
	pending, err := w.invoke(t, [3]string{runID, lease, correlation}, "add_reaction", `{"message_id":"`+w.groupMessage+`","emoji":"👍"}`)
	if err != nil || pending.Confirmation == nil {
		t.Fatalf("reaction confirmation = %+v err=%v", pending, err)
	}
	if _, err := w.pool.Exec(t.Context(), `UPDATE agents SET read_only_chat_ids=ARRAY[$2::uuid] WHERE actor_id=$1`, w.agentID, w.groupChat); err != nil {
		t.Fatal(err)
	}
	owner := identity.User{ActorID: w.ownerID, OrgID: w.orgID, OrgRole: "owner"}
	decided, err := w.executor.DecideConfirmation(t.Context(), owner, pending.Confirmation.ID, true)
	if err != nil || decided.Status != "failed" {
		t.Fatalf("approved reaction in a chat that became read-only = %+v err=%v", decided, err)
	}
	var reactions int
	if err := w.pool.QueryRow(t.Context(), `SELECT count(*) FROM reactions WHERE message_id=$1`, w.groupMessage).Scan(&reactions); err != nil || reactions != 0 {
		t.Fatalf("reactions = %d err=%v", reactions, err)
	}
}
