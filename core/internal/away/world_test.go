package away_test

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"sync"
	"testing"
	"time"

	"github.com/comamessenger/comamessenger/core/internal/away"
	"github.com/comamessenger/comamessenger/core/internal/identity"
	"github.com/comamessenger/comamessenger/core/internal/message"
	"github.com/comamessenger/comamessenger/core/internal/testdb"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// secret is the auto-reply text: it must never show up anywhere but in the
// auto-reply message itself and in the owner's getAway.
const secret = "SECRET-autoreply-7c1f: по срочному к Марине"

// world is one organization: anna (who goes away), boss (admin), colleague,
// marina (the substitute), bob (also a person) and robot (an agent). Each
// person but marina has a direct chat with anna; everyone is in a group.
type world struct {
	pool                                    *pgxpool.Pool
	messages                                *message.Service
	service                                 *away.Service
	scheduler                               *fakeScheduler
	orgID                                   string
	anna, boss, colleague, marina, bob, bot identity.User
	group, annaColleague, annaBoss, annaBob string
	annaBot, colleagueBob                   string
}

// fakeScheduler records the jobs the hook schedules; drain runs them.
type fakeScheduler struct {
	mu   sync.Mutex
	jobs []away.AutoreplyArgs
}

func (f *fakeScheduler) ScheduleAutoreplyTx(_ context.Context, _ pgx.Tx, args away.AutoreplyArgs) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.jobs = append(f.jobs, args)
	return nil
}

func (f *fakeScheduler) take() []away.AutoreplyArgs {
	f.mu.Lock()
	defer f.mu.Unlock()
	jobs := f.jobs
	f.jobs = nil
	return jobs
}

func newWorld(t *testing.T) *world {
	t.Helper()
	pool := testdb.New(t)
	orgID := uuid.NewString()
	person := func(role string) identity.User {
		return identity.User{ActorID: uuid.NewString(), OrgID: orgID, OrgRole: role, Status: "active"}
	}
	w := &world{
		pool: pool, orgID: orgID,
		anna: person("member"), boss: person("owner"), colleague: person("member"), marina: person("member"),
		bob: person("member"), bot: person("member"),
		group: uuid.NewString(), annaColleague: uuid.NewString(), annaBoss: uuid.NewString(), annaBob: uuid.NewString(),
		annaBot: uuid.NewString(), colleagueBob: uuid.NewString(),
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
	for _, item := range []struct {
		user              identity.User
		kind, name        string
		emoji, statusText string
	}{
		{w.anna, "user", "anna", "🎯", "Готовлю отчёт"}, {w.boss, "user", "boss", "", ""}, {w.colleague, "user", "colleague", "", ""},
		{w.marina, "user", "marina", "", ""}, {w.bob, "user", "bob", "", ""}, {w.bot, "agent", "robot", "", ""},
	} {
		run(`INSERT INTO actors (id, org_id, type, org_role, display_name, handle, timezone, status_emoji, status_text) VALUES ($1, $2, $3, $4, $5, $8, 'Europe/Moscow', $6, $7)`,
			item.user.ActorID, orgID, item.kind, item.user.OrgRole, item.name, item.emoji, item.statusText, item.name)
		if item.kind == "user" {
			run(`INSERT INTO users (actor_id, org_id, email, password_hash) VALUES ($1, $2, $3, 'hash')`, item.user.ActorID, orgID, item.name+"@example.test")
		}
	}
	run(`INSERT INTO chats (id, org_id, kind, visibility, name, created_by) VALUES ($1, $2, 'group', 'private', 'Team', $3)`, w.group, orgID, w.boss.ActorID)
	for _, member := range []identity.User{w.anna, w.boss, w.colleague, w.marina, w.bob, w.bot} {
		role := "member"
		if member.ActorID == w.boss.ActorID {
			role = "owner"
		}
		run(`INSERT INTO chat_members (chat_id, actor_id, org_id, role) VALUES ($1, $2, $3, $4)`, w.group, member.ActorID, orgID, role)
	}
	for _, pair := range []struct {
		chatID string
		a, b   identity.User
	}{
		{w.annaColleague, w.anna, w.colleague}, {w.annaBoss, w.anna, w.boss}, {w.annaBob, w.anna, w.bob},
		{w.annaBot, w.anna, w.bot}, {w.colleagueBob, w.colleague, w.bob},
	} {
		run(`INSERT INTO chats (id, org_id, kind, visibility, direct_pair_key, created_by) VALUES ($1, $2, 'direct', 'private', $3, $4)`,
			pair.chatID, orgID, pair.a.ActorID+":"+pair.b.ActorID, pair.a.ActorID)
		run(`INSERT INTO chat_members (chat_id, actor_id, org_id, role) VALUES ($1, $2, $4, 'member'), ($1, $3, $4, 'member')`,
			pair.chatID, pair.a.ActorID, pair.b.ActorID, orgID)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	w.messages = message.NewService(pool, 64*1024, 100, nil)
	w.service = away.NewService(pool, w.messages, nil, slog.New(slog.NewTextHandler(io.Discard, nil)))
	w.scheduler = &fakeScheduler{}
	w.service.SetScheduler(w.scheduler)
	w.messages.SetAwayHook(w.service.OnDirectMessageTx)
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

func (w *world) post(t *testing.T, author identity.User, chatID, body string) message.Message {
	t.Helper()
	result, _, err := w.messages.Create(context.Background(), author, chatID, message.CreateInput{ClientMsgID: uuid.NewString(), Body: body, BodyFormat: "plain"})
	if err != nil {
		t.Fatal(err)
	}
	return result
}

// drain runs every scheduled auto-reply job.
func (w *world) drain(t *testing.T) {
	t.Helper()
	for _, job := range w.scheduler.take() {
		if err := w.service.SendAutoreply(context.Background(), job); err != nil {
			t.Fatal(err)
		}
	}
}

// vacation is a running vacation of `days` days with the secret auto-reply.
func vacation(days int, substitute *identity.User, mute bool) away.SetInput {
	enabled, text := true, secret
	ends := time.Now().Add(time.Duration(days) * 24 * time.Hour)
	input := away.SetInput{Kind: away.KindVacation, EndsAt: &ends, Autoreply: &away.AutoreplyInput{Enabled: &enabled, Text: &text}, MutePush: &mute}
	if substitute != nil {
		input.SubstituteID = &substitute.ActorID
	}
	return input
}

func (w *world) set(t *testing.T, user identity.User, input away.SetInput) away.Status {
	t.Helper()
	result, err := w.service.Set(context.Background(), user, input)
	if err != nil {
		t.Fatal(err)
	}
	return result
}

func (w *world) seq(t *testing.T) int64 {
	t.Helper()
	var value int64
	if err := w.pool.QueryRow(context.Background(), `SELECT event_seq FROM organizations WHERE id = $1`, w.orgID).Scan(&value); err != nil {
		t.Fatal(err)
	}
	return value
}

type storedEvent struct {
	Type     string
	Actor    *string
	Audience *string
	ChatID   *string
	Raw      string
	Data     map[string]any
}

// eventsAfter lists every event after seq.
func (w *world) eventsAfter(t *testing.T, seq int64) []storedEvent {
	t.Helper()
	rows, err := w.pool.Query(context.Background(), `
		SELECT type, actor_id::text, audience_actor_id::text, chat_id::text, data::text FROM events
		WHERE org_id = $1 AND seq > $2 ORDER BY seq`, w.orgID, seq)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var result []storedEvent
	for rows.Next() {
		var item storedEvent
		if err := rows.Scan(&item.Type, &item.Actor, &item.Audience, &item.ChatID, &item.Raw); err != nil {
			t.Fatal(err)
		}
		if err := json.Unmarshal([]byte(item.Raw), &item.Data); err != nil {
			t.Fatal(err)
		}
		result = append(result, item)
	}
	return result
}

func (w *world) ofType(t *testing.T, seq int64, eventType string) []storedEvent {
	t.Helper()
	var result []storedEvent
	for _, item := range w.eventsAfter(t, seq) {
		if item.Type == eventType {
			result = append(result, item)
		}
	}
	return result
}

func ptr[T any](value T) *T { return &value }
