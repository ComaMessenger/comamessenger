package task_test

import (
	"context"
	"encoding/json"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/comamessenger/comamessenger/core/internal/identity"
	"github.com/comamessenger/comamessenger/core/internal/message"
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
	scheduled map[int64]scheduledJob
	cancelled map[int64]bool
}

type scheduledJob struct {
	kind, messageID string
	at              time.Time
}

func (f *fakeJobs) ScheduleTx(_ context.Context, _ pgx.Tx, kind, messageID string, at time.Time) (int64, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.next++
	if f.scheduled == nil {
		f.scheduled, f.cancelled = map[int64]scheduledJob{}, map[int64]bool{}
	}
	f.scheduled[f.next] = scheduledJob{kind: kind, messageID: messageID, at: at}
	return f.next, nil
}

func (f *fakeJobs) CancelTx(_ context.Context, _ pgx.Tx, jobID int64) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.cancelled[jobID] = true
	return nil
}

// live returns the jobs of kind for messageID that were not cancelled.
func (f *fakeJobs) live(kind, messageID string) map[int64]scheduledJob {
	f.mu.Lock()
	defer f.mu.Unlock()
	result := map[int64]scheduledJob{}
	for id, job := range f.scheduled {
		if job.kind == kind && job.messageID == messageID && !f.cancelled[id] {
			result[id] = job
		}
	}
	return result
}

func (f *fakeJobs) one(t *testing.T, kind, messageID string) (int64, scheduledJob) {
	t.Helper()
	live := f.live(kind, messageID)
	if len(live) != 1 {
		t.Fatalf("%d live %s jobs for %s", len(live), kind, messageID)
	}
	for id, job := range live {
		return id, job
	}
	return 0, scheduledJob{}
}

type clock struct {
	mu  sync.Mutex
	now time.Time
}

func (c *clock) Now() time.Time  { c.mu.Lock(); defer c.mu.Unlock(); return c.now }
func (c *clock) Set(t time.Time) { c.mu.Lock(); defer c.mu.Unlock(); c.now = t }

type world struct {
	pool       *pgxpool.Pool
	messages   *message.Service
	tasks      *task.Service
	requests   *request.Service
	jobs       *fakeJobs
	clock      *clock
	orgID      string
	chatID     string
	otherID    string // a second chat the outsider is in
	author     identity.User
	alice      identity.User
	bob        identity.User
	carol      identity.User
	admin      identity.User // chat admin
	owner      identity.User // chat owner, workspace owner
	outsider   identity.User // not in the chat
	agentID    string
	sleepyID   string // deactivated member
	department string // alice (primary) and, through the subdepartment, carol; the outsider too
	subdept    string
	position   string // bob and the outsider
}

func newWorld(t *testing.T) *world {
	t.Helper()
	pool := testdb.New(t)
	ctx := context.Background()
	w := &world{pool: pool, orgID: uuid.NewString(), chatID: uuid.NewString(), otherID: uuid.NewString(),
		agentID: uuid.NewString(), sleepyID: uuid.NewString(), department: uuid.NewString(), subdept: uuid.NewString(), position: uuid.NewString()}
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
	exec(`INSERT INTO departments (org_id, id, name) VALUES ($1, $2, 'Кухня')`, w.orgID, w.department)
	exec(`INSERT INTO departments (org_id, id, parent_id, name) VALUES ($1, $2, $3, 'Выпечка')`, w.orgID, w.subdept, w.department)
	exec(`INSERT INTO department_members (org_id, department_id, actor_id, is_primary) VALUES ($1, $2, $3, true), ($1, $2, $4, true), ($1, $5, $6, true)`,
		w.orgID, w.department, w.alice.ActorID, w.outsider.ActorID, w.subdept, w.carol.ActorID)
	exec(`INSERT INTO positions (org_id, id, name) VALUES ($1, $2, 'Повар')`, w.orgID, w.position)
	exec(`UPDATE actors SET position_id = $2 WHERE id = ANY($3::uuid[]) AND org_id = $1`, w.orgID, w.position, []string{w.bob.ActorID, w.outsider.ActorID})
	// The author may address departments and positions.
	exec(`INSERT INTO actor_permissions (org_id, actor_id, permission) VALUES ($1, $2, 'requests.address_groups')`, w.orgID, w.author.ActorID)
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	w.clock = &clock{now: time.Now().UTC().Truncate(time.Microsecond)}
	w.jobs = &fakeJobs{}
	w.tasks = task.NewService(pool, nil)
	w.tasks.SetJobs(w.jobs)
	w.tasks.SetClock(w.clock.Now)
	w.requests = request.NewService(pool, nil)
	w.requests.SetClock(w.clock.Now)
	w.messages = message.NewService(pool, 64*1024, 100, nil)
	w.messages.SetTasks(w.tasks)
	w.messages.SetRequests(w.requests)
	return w
}

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

func person(actorID string) task.AssigneeInput {
	return task.AssigneeInput{Kind: "person", ActorID: ptr(actorID)}
}

// create makes a task by user; due nil means none.
func (w *world) create(t *testing.T, user identity.User, input message.CreateTaskInput) message.Message {
	t.Helper()
	if input.ClientMsgID == "" {
		input.ClientMsgID = uuid.NewString()
	}
	if input.RemindBeforeDue == nil {
		input.RemindBeforeDue = ptr(false)
	}
	result, created, err := w.messages.CreateTask(context.Background(), user, w.chatID, input)
	if err != nil {
		t.Fatalf("create task: %v", err)
	}
	if !created || result.Task == nil {
		t.Fatalf("create task: created=%v task=%v", created, result.Task)
	}
	return result
}

func (w *world) simple(t *testing.T, assignee identity.User) message.Message {
	t.Helper()
	return w.create(t, w.author, message.CreateTaskInput{Title: "Купить молоко", Assignee: person(assignee.ActorID)})
}

func (w *world) status(t *testing.T, user identity.User, messageID, status string) error {
	t.Helper()
	_, err := w.messages.SetTaskStatus(context.Background(), user, messageID, task.StatusInput{Status: status})
	return err
}

func (w *world) load(t *testing.T, messageID string) *task.Task {
	t.Helper()
	item, err := task.LoadOne(context.Background(), w.pool, w.orgID, messageID)
	if err != nil {
		t.Fatal(err)
	}
	return item
}

type notified struct {
	Audience string
	Kind     string
	ByActor  *string
	Data     map[string]any
}

// notices lists task.notified events of a message after seq, in order.
func (w *world) notices(t *testing.T, messageID string, after int64) []notified {
	t.Helper()
	rows, err := w.pool.Query(context.Background(), `
		SELECT audience_actor_id, data FROM events WHERE org_id=$1 AND type='task.notified' AND subject_id=$2 AND seq>$3 ORDER BY seq`,
		w.orgID, messageID, after)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var result []notified
	for rows.Next() {
		var item notified
		var raw []byte
		if err := rows.Scan(&item.Audience, &raw); err != nil {
			t.Fatal(err)
		}
		if err := json.Unmarshal(raw, &item.Data); err != nil {
			t.Fatal(err)
		}
		item.Kind, _ = item.Data["kind"].(string)
		if by, ok := item.Data["by_actor_id"].(string); ok {
			item.ByActor = &by
		}
		result = append(result, item)
	}
	return result
}

func kinds(items []notified) map[string]string {
	result := map[string]string{}
	for _, item := range items {
		result[item.Audience] = item.Kind
	}
	return result
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
