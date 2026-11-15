package poll_test

import (
	"context"
	"encoding/json"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/comamessenger/comamessenger/core/internal/chat"
	"github.com/comamessenger/comamessenger/core/internal/eventlog"
	"github.com/comamessenger/comamessenger/core/internal/identity"
	"github.com/comamessenger/comamessenger/core/internal/message"
	"github.com/comamessenger/comamessenger/core/internal/poll"
	"github.com/comamessenger/comamessenger/core/internal/request"
	"github.com/comamessenger/comamessenger/core/internal/task"
	"github.com/comamessenger/comamessenger/core/internal/testdb"
	"github.com/comamessenger/comamessenger/core/internal/userstate"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// fakeJobs records River jobs instead of running them.
type fakeJobs struct {
	mu        sync.Mutex
	next      int64
	scheduled map[int64]string
	cancelled map[int64]bool
}

func (f *fakeJobs) ScheduleTx(_ context.Context, _ pgx.Tx, messageID string, _ time.Time) (int64, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.next++
	if f.scheduled == nil {
		f.scheduled, f.cancelled = map[int64]string{}, map[int64]bool{}
	}
	f.scheduled[f.next] = messageID
	return f.next, nil
}

func (f *fakeJobs) CancelTx(_ context.Context, _ pgx.Tx, jobID int64) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.cancelled[jobID] = true
	return nil
}

// live returns the job of messageID that was not cancelled, 0 for none.
func (f *fakeJobs) live(messageID string) int64 {
	f.mu.Lock()
	defer f.mu.Unlock()
	for id, target := range f.scheduled {
		if target == messageID && !f.cancelled[id] {
			return id
		}
	}
	return 0
}

type clock struct {
	mu  sync.Mutex
	now time.Time
}

func (c *clock) Now() time.Time  { c.mu.Lock(); defer c.mu.Unlock(); return c.now }
func (c *clock) Set(t time.Time) { c.mu.Lock(); defer c.mu.Unlock(); c.now = t }

type world struct {
	pool     *pgxpool.Pool
	messages *message.Service
	polls    *poll.Service
	chats    *chat.Service
	jobs     *fakeJobs
	clock    *clock
	orgID    string
	chatID   string
	otherID  string // a second chat the outsider is in
	author   identity.User
	alice    identity.User
	bob      identity.User
	carol    identity.User
	admin    identity.User // chat admin
	owner    identity.User // chat owner, workspace owner
	outsider identity.User // not in the chat
	agentID  string
	sleepyID string // deactivated member
}

func newWorld(t *testing.T) *world {
	t.Helper()
	pool := testdb.New(t)
	ctx := context.Background()
	w := &world{pool: pool, orgID: uuid.NewString(), chatID: uuid.NewString(), otherID: uuid.NewString(),
		agentID: uuid.NewString(), sleepyID: uuid.NewString()}
	person := func(role string) identity.User {
		return identity.User{ActorID: uuid.NewString(), OrgID: w.orgID, OrgRole: role, Status: "active"}
	}
	w.author, w.alice, w.bob, w.carol, w.admin, w.owner, w.outsider = person("member"), person("member"), person("member"), person("member"), person("member"), person("owner"), person("member")
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	exec := func(query string, args ...any) {
		t.Helper()
		if _, err := tx.Exec(ctx, query, args...); err != nil {
			t.Fatalf("%s: %v", query, err)
		}
	}
	exec(`INSERT INTO organizations (id, name, slug) VALUES ($1, 'Test', 'test')`, w.orgID)
	names := map[string]identity.User{"author": w.author, "alice": w.alice, "bob": w.bob, "carol": w.carol, "admin": w.admin, "owner": w.owner, "outsider": w.outsider}
	for handle, user := range names {
		exec(`INSERT INTO actors (id, org_id, type, org_role, display_name, handle) VALUES ($1, $2, 'user', $3, $4, $5)`, user.ActorID, w.orgID, user.OrgRole, handle, handle)
		exec(`INSERT INTO users (actor_id, org_id, email, password_hash) VALUES ($1, $2, $3, 'hash')`, user.ActorID, w.orgID, handle+"@example.test")
	}
	exec(`INSERT INTO actors (id, org_id, type, org_role, display_name, handle) VALUES ($1, $2, 'agent', 'member', 'agent', 'agent')`, w.agentID, w.orgID)
	exec(`INSERT INTO actors (id, org_id, type, org_role, display_name, handle, status) VALUES ($1, $2, 'user', 'member', 'sleepy', 'sleepy', 'deactivated')`, w.sleepyID, w.orgID)
	for _, chatID := range []string{w.chatID, w.otherID} {
		exec(`INSERT INTO chats (id, org_id, kind, visibility, name, created_by) VALUES ($1, $2, 'group', 'private', 'Team', $3)`, chatID, w.orgID, w.owner.ActorID)
		exec(`INSERT INTO chat_members (chat_id, actor_id, org_id, role) VALUES ($1, $2, $3, 'owner')`, chatID, w.owner.ActorID, w.orgID)
	}
	for _, member := range []string{w.author.ActorID, w.alice.ActorID, w.bob.ActorID, w.carol.ActorID, w.agentID, w.sleepyID} {
		exec(`INSERT INTO chat_members (chat_id, actor_id, org_id, role) VALUES ($1, $2, $3, 'member')`, w.chatID, member, w.orgID)
	}
	exec(`INSERT INTO chat_members (chat_id, actor_id, org_id, role) VALUES ($1, $2, $3, 'admin')`, w.chatID, w.admin.ActorID, w.orgID)
	exec(`INSERT INTO chat_members (chat_id, actor_id, org_id, role) VALUES ($1, $2, $3, 'member')`, w.otherID, w.outsider.ActorID, w.orgID)
	exec(`INSERT INTO chat_members (chat_id, actor_id, org_id, role) VALUES ($1, $2, $3, 'member')`, w.otherID, w.author.ActorID, w.orgID)
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	w.clock = &clock{now: time.Now().UTC().Truncate(time.Microsecond)}
	w.jobs = &fakeJobs{}
	w.polls = poll.NewService(pool, nil)
	w.polls.SetJobs(w.jobs)
	w.polls.SetClock(w.clock.Now)
	w.messages = message.NewService(pool, 64*1024, 100, nil)
	w.messages.SetPolls(w.polls)
	w.messages.SetTasks(task.NewService(pool, nil))
	w.messages.SetRequests(request.NewService(pool, nil))
	w.chats = chat.NewService(pool)
	return w
}

// people of the chat: author, alice, bob, carol, admin, owner. M is 6.
const chatPeople = 6

func (w *world) exec(t *testing.T, query string, args ...any) {
	t.Helper()
	if _, err := w.pool.Exec(context.Background(), query, args...); err != nil {
		t.Fatalf("%s: %v", query, err)
	}
}

func (w *world) count(t *testing.T, query string, args ...any) int {
	t.Helper()
	var n int
	if err := w.pool.QueryRow(context.Background(), query, args...).Scan(&n); err != nil {
		t.Fatalf("%s: %v", query, err)
	}
	return n
}

func (w *world) maxSeq(t *testing.T) int64 {
	t.Helper()
	var seq int64
	if err := w.pool.QueryRow(context.Background(), `SELECT event_seq FROM organizations WHERE id=$1`, w.orgID).Scan(&seq); err != nil {
		t.Fatal(err)
	}
	return seq
}

func ptr[T any](value T) *T { return &value }

// create makes a poll by user in the team chat.
func (w *world) create(t *testing.T, user identity.User, input message.CreatePollInput) message.Message {
	t.Helper()
	if input.ClientMsgID == "" {
		input.ClientMsgID = uuid.NewString()
	}
	if input.Question == "" {
		input.Question = "Когда удобнее субботник?"
	}
	if input.Options == nil {
		input.Options = []string{"Среда", "Четверг", "Суббота"}
	}
	if input.Multiple == nil {
		input.Multiple = ptr(false)
	}
	if input.Anonymous == nil {
		input.Anonymous = ptr(false)
	}
	result, created, err := w.messages.CreatePoll(context.Background(), user, w.chatID, input)
	if err != nil {
		t.Fatalf("create poll: %v", err)
	}
	if !created || result.Poll == nil || result.PollViewer == nil {
		t.Fatalf("create poll: created=%v poll=%v viewer=%v", created, result.Poll, result.PollViewer)
	}
	return result
}

func (w *world) vote(t *testing.T, user identity.User, messageID string, options ...int) poll.State {
	t.Helper()
	state, err := w.polls.Vote(context.Background(), user, messageID, poll.VoteInput{Options: options})
	if err != nil {
		t.Fatalf("vote: %v", err)
	}
	return state
}

func (w *world) get(t *testing.T, user identity.User, messageID string) poll.State {
	t.Helper()
	state, err := w.polls.Get(context.Background(), user, messageID)
	if err != nil {
		t.Fatalf("get poll: %v", err)
	}
	return state
}

type storedEvent struct {
	Seq      int64
	Type     string
	ActorID  *string
	Audience *string
	Data     map[string]any
	Raw      string
}

// events lists the stored events about subjectID after seq, in order.
func (w *world) events(t *testing.T, subjectID string, after int64) []storedEvent {
	t.Helper()
	rows, err := w.pool.Query(context.Background(), `
		SELECT seq, type, actor_id, audience_actor_id, data::text FROM events WHERE org_id=$1 AND subject_id=$2 AND seq>$3 ORDER BY seq`,
		w.orgID, subjectID, after)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var result []storedEvent
	for rows.Next() {
		var item storedEvent
		if err := rows.Scan(&item.Seq, &item.Type, &item.ActorID, &item.Audience, &item.Raw); err != nil {
			t.Fatal(err)
		}
		if err := json.Unmarshal([]byte(item.Raw), &item.Data); err != nil {
			t.Fatal(err)
		}
		result = append(result, item)
	}
	return result
}

func ofType(events []storedEvent, eventType string) []storedEvent {
	var result []storedEvent
	for _, item := range events {
		if item.Type == eventType {
			result = append(result, item)
		}
	}
	return result
}

// replay is what user receives over realtime after seq.
func (w *world) replay(t *testing.T, user identity.User, after int64) []eventlog.Frame {
	t.Helper()
	frames, err := eventlog.NewStore(w.pool).Replay(context.Background(), user, "", after, w.maxSeq(t), 1000)
	if err != nil {
		t.Fatal(err)
	}
	return frames
}

func (w *world) unread(t *testing.T, user identity.User) userstate.UnreadSnapshot {
	t.Helper()
	snapshot, err := userstate.NewService(w.pool, 4096, nil).Unread(context.Background(), user)
	if err != nil {
		t.Fatal(err)
	}
	return snapshot
}

func (w *world) waiting(t *testing.T, user identity.User, kind string) []message.WaitingInboxItem {
	t.Helper()
	var all []message.WaitingInboxItem
	var cursor *string
	for {
		page, err := w.messages.WaitingInbox(context.Background(), user, message.WaitingInboxOptions{Kind: kind, Cursor: cursor, Limit: 2})
		if err != nil {
			t.Fatal(err)
		}
		all = append(all, page.Items...)
		if page.NextCursor == nil {
			return all
		}
		cursor = page.NextCursor
	}
}

func expectErr(t *testing.T, err, want error) {
	t.Helper()
	if !errors.Is(err, want) {
		t.Fatalf("error = %v, want %v", err, want)
	}
}

// eventlogLive is the live batch after seq with its recipients.
func eventlogLive(w *world, after int64) ([]eventlog.LiveEvent, error) {
	var through int64
	if err := w.pool.QueryRow(context.Background(), `SELECT event_seq FROM organizations WHERE id=$1`, w.orgID).Scan(&through); err != nil {
		return nil, err
	}
	return eventlog.NewStore(w.pool).Live(context.Background(), w.orgID, after, through, 1000)
}
