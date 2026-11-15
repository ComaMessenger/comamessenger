package reminder_test

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"testing"
	"time"

	"github.com/comamessenger/comamessenger/core/internal/identity"
	"github.com/comamessenger/comamessenger/core/internal/message"
	"github.com/comamessenger/comamessenger/core/internal/reminder"
	"github.com/comamessenger/comamessenger/core/internal/testdb"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

// world is one organization with a group chat: owner (chat owner), member
// and colleague are in it, outsider is not.
type world struct {
	pool                               *pgxpool.Pool
	messages                           *message.Service
	service                            *reminder.Service
	owner, member, colleague, outsider identity.User
	chatID, otherChatID                string
}

func newWorld(t *testing.T) *world {
	t.Helper()
	pool := testdb.New(t)
	orgID := uuid.NewString()
	user := func(role string) identity.User {
		return identity.User{ActorID: uuid.NewString(), OrgID: orgID, OrgRole: role, Status: "active"}
	}
	w := &world{
		pool: pool, owner: user("owner"), member: user("member"), colleague: user("member"), outsider: user("admin"),
		chatID: uuid.NewString(), otherChatID: uuid.NewString(),
	}
	ctx := context.Background()
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	run := func(query string, args ...any) {
		t.Helper()
		if _, err := tx.Exec(ctx, query, args...); err != nil {
			t.Fatal(err)
		}
	}
	run(`INSERT INTO organizations (id, name, slug) VALUES ($1, 'Test', 'test')`, orgID)
	for index, actor := range []identity.User{w.owner, w.member, w.colleague, w.outsider} {
		handle := []string{"owner", "member", "colleague", "outsider"}[index]
		run(`INSERT INTO actors (id, org_id, type, org_role, display_name, handle) VALUES ($1, $2, 'user', $3, $4, $5)`,
			actor.ActorID, orgID, actor.OrgRole, handle, handle)
	}
	for _, chatID := range []string{w.chatID, w.otherChatID} {
		run(`INSERT INTO chats (id, org_id, kind, visibility, name, created_by) VALUES ($1, $2, 'group', 'private', 'Plans', $3)`,
			chatID, orgID, w.owner.ActorID)
		run(`INSERT INTO chat_members (chat_id, actor_id, org_id, role) VALUES ($1, $2, $5, 'owner'), ($1, $3, $5, 'member'), ($1, $4, $5, 'member')`,
			chatID, w.owner.ActorID, w.member.ActorID, w.colleague.ActorID, orgID)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	w.messages = message.NewService(pool, 64*1024, 100, nil)
	w.service = reminder.NewService(pool, nil, slog.New(slog.NewTextHandler(io.Discard, nil)))
	return w
}

func (w *world) exec(t *testing.T, query string, args ...any) {
	t.Helper()
	if _, err := w.pool.Exec(context.Background(), query, args...); err != nil {
		t.Fatal(err)
	}
}

func (w *world) count(t *testing.T, query string, args ...any) int {
	t.Helper()
	var value int
	if err := w.pool.QueryRow(context.Background(), query, args...).Scan(&value); err != nil {
		t.Fatal(err)
	}
	return value
}

func (w *world) post(t *testing.T, chatID, body string) message.Message {
	t.Helper()
	result, _, err := w.messages.Create(context.Background(), w.owner, chatID, message.CreateInput{ClientMsgID: uuid.NewString(), Body: body, BodyFormat: "plain"})
	if err != nil {
		t.Fatal(err)
	}
	return result
}

func (w *world) set(t *testing.T, user identity.User, messageID string, in time.Duration, note *string) reminder.Reminder {
	t.Helper()
	result, _, err := w.service.Set(context.Background(), user, messageID, reminder.SetInput{RemindAt: time.Now().Add(in), Note: note})
	if err != nil {
		t.Fatal(err)
	}
	return result
}

// due moves a reminder's time into the past, as if it were due now.
func (w *world) due(t *testing.T, reminderID string, ago time.Duration) {
	t.Helper()
	w.exec(t, `UPDATE message_reminders SET remind_at = now() - $2::interval WHERE id = $1`, reminderID, ago.String())
}

func (w *world) fire(t *testing.T, reminderID string) {
	t.Helper()
	if err := w.service.Fire(context.Background(), reminderID, 0); err != nil {
		t.Fatal(err)
	}
}

func (w *world) seq(t *testing.T) int64 {
	t.Helper()
	var value int64
	if err := w.pool.QueryRow(context.Background(), `SELECT event_seq FROM organizations WHERE id = $1`, w.owner.OrgID).Scan(&value); err != nil {
		t.Fatal(err)
	}
	return value
}

type storedEvent struct {
	Type     string
	Audience *string
	ChatID   *string
	Data     map[string]any
	Raw      string
}

// eventsAfter lists the reminder.* events after seq.
func (w *world) eventsAfter(t *testing.T, seq int64) []storedEvent {
	t.Helper()
	rows, err := w.pool.Query(context.Background(), `
		SELECT type, audience_actor_id::text, chat_id::text, data::text FROM events
		WHERE org_id = $1 AND seq > $2 AND type LIKE 'reminder.%' ORDER BY seq`, w.owner.OrgID, seq)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var result []storedEvent
	for rows.Next() {
		var item storedEvent
		if err := rows.Scan(&item.Type, &item.Audience, &item.ChatID, &item.Raw); err != nil {
			t.Fatal(err)
		}
		if err := json.Unmarshal([]byte(item.Raw), &item.Data); err != nil {
			t.Fatal(err)
		}
		result = append(result, item)
	}
	return result
}

func (w *world) load(t *testing.T, reminderID string) (state string, messageID *string, version int, ok bool) {
	t.Helper()
	err := w.pool.QueryRow(context.Background(), `SELECT state, message_id::text, version FROM message_reminders WHERE id = $1`, reminderID).Scan(&state, &messageID, &version)
	if err != nil {
		return "", nil, 0, false
	}
	return state, messageID, version, true
}

func ptr[T any](value T) *T { return &value }
