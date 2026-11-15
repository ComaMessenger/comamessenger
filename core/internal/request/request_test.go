package request_test

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/comamessenger/comamessenger/core/internal/chat"
	"github.com/comamessenger/comamessenger/core/internal/eventlog"
	"github.com/comamessenger/comamessenger/core/internal/identity"
	"github.com/comamessenger/comamessenger/core/internal/message"
	"github.com/comamessenger/comamessenger/core/internal/request"
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

func (f *fakeJobs) job(t *testing.T, kind, messageID string) (int64, scheduledJob) {
	t.Helper()
	f.mu.Lock()
	defer f.mu.Unlock()
	for id, job := range f.scheduled {
		if job.kind == kind && job.messageID == messageID {
			return id, job
		}
	}
	t.Fatalf("no %s job for %s", kind, messageID)
	return 0, scheduledJob{}
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
	requests *request.Service
	chats    *chat.Service
	jobs     *fakeJobs
	clock    *clock
	orgID    string
	chatID   string
	otherID  string // a second group
	author   identity.User
	alice    identity.User
	bob      identity.User
	carol    identity.User // a member who is never asked
	admin    identity.User // chat admin
	owner    identity.User // chat owner, workspace owner
	agentID  string
	sleepyID string // deactivated member
	outsider identity.User
}

func newWorld(t *testing.T) *world {
	t.Helper()
	pool := testdb.New(t)
	ctx := context.Background()
	w := &world{pool: pool, orgID: uuid.NewString(), chatID: uuid.NewString(), otherID: uuid.NewString(), agentID: uuid.NewString(), sleepyID: uuid.NewString()}
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
	exec(`INSERT INTO chat_members (chat_id, actor_id, org_id, role) VALUES ($1, $2, $3, 'member')`, w.otherID, w.author.ActorID, w.orgID)
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	w.clock = &clock{now: time.Now().UTC().Truncate(time.Microsecond)}
	w.jobs = &fakeJobs{}
	w.requests = request.NewService(pool, nil)
	w.requests.SetJobs(w.jobs)
	w.requests.SetClock(w.clock.Now)
	w.messages = message.NewService(pool, 64*1024, 100, nil)
	w.messages.SetRequests(w.requests)
	w.chats = chat.NewService(pool)
	return w
}

type spec struct {
	audience string
	people   []string
	preset   string
	options  []string
	due      *time.Time
	remind   bool
	comment  *bool
}

func (w *world) create(t *testing.T, author identity.User, chatID string, s spec) (message.Message, error) {
	t.Helper()
	if s.audience == "" {
		s.audience = "chat"
	}
	if s.preset == "" {
		s.preset = request.PresetYesNo
	}
	result, _, err := w.messages.CreateRequest(context.Background(), author, chatID, message.CreateRequestInput{
		ClientMsgID: uuid.NewString(), Body: "Планёрка в понедельник. Будете?",
		Audience:     request.AudienceInput{Kind: s.audience, ActorIDs: s.people},
		Answer:       request.AnswerSpec{Preset: s.preset, Options: s.options},
		AllowComment: s.comment, DueAt: s.due, AutoRemind: s.remind,
	})
	return result, err
}

func (w *world) mustCreate(t *testing.T, s spec) message.Message {
	t.Helper()
	result, err := w.create(t, w.author, w.chatID, s)
	if err != nil {
		t.Fatal(err)
	}
	return result
}

func (w *world) answer(user identity.User, messageID string, option int, comment *string) (request.State, error) {
	return w.requests.Answer(context.Background(), user, messageID, request.AnswerInput{Option: &option, Comment: comment})
}

func (w *world) seq(t *testing.T) int64 {
	t.Helper()
	var seq int64
	if err := w.pool.QueryRow(context.Background(), `SELECT event_seq FROM organizations WHERE id=$1`, w.orgID).Scan(&seq); err != nil {
		t.Fatal(err)
	}
	return seq
}

func (w *world) count(t *testing.T, query string, args ...any) int {
	t.Helper()
	var count int
	if err := w.pool.QueryRow(context.Background(), query, args...).Scan(&count); err != nil {
		t.Fatalf("%s: %v", query, err)
	}
	return count
}

func ptr[T any](value T) *T { return &value }

func TestCreateRequest(t *testing.T) {
	w := newWorld(t)
	ctx := context.Background()

	t.Run("whole chat: the author, agents and deactivated people are left out", func(t *testing.T) {
		before := w.seq(t)
		result := w.mustCreate(t, spec{})
		if result.Type != "request" || result.Request == nil || result.RequestViewer == nil {
			t.Fatalf("created = %+v", result)
		}
		if result.Request.Audience.Count != 5 || result.Request.WaitingCount != 5 || result.Request.Audience.Label != "" {
			t.Fatalf("summary = %+v; want 5 recipients (alice, bob, carol, admin, owner)", result.Request)
		}
		if result.RequestViewer.Role != "author" || !result.RequestViewer.CanViewAnswers || result.RequestViewer.Tally == nil {
			t.Fatalf("viewer = %+v", result.RequestViewer)
		}
		for _, excluded := range []string{w.author.ActorID, w.agentID, w.sleepyID} {
			if n := w.count(t, `SELECT count(*) FROM message_request_recipients WHERE message_id=$1 AND actor_id=$2`, result.ID, excluded); n != 0 {
				t.Fatalf("%s is a recipient", excluded)
			}
		}
		// request.assigned to every recipient, all before message.created.
		var assignedMax, createdSeq int64
		if err := w.pool.QueryRow(ctx, `SELECT max(seq) FROM events WHERE type='request.assigned' AND subject_id=$1`, result.ID).Scan(&assignedMax); err != nil {
			t.Fatal(err)
		}
		if err := w.pool.QueryRow(ctx, `SELECT seq FROM events WHERE type='message.created' AND subject_id=$1`, result.ID).Scan(&createdSeq); err != nil {
			t.Fatal(err)
		}
		if n := w.count(t, `SELECT count(*) FROM events WHERE type='request.assigned' AND subject_id=$1 AND seq>$2`, result.ID, before); n != 5 || assignedMax >= createdSeq || result.CreatedSeq != createdSeq {
			t.Fatalf("assigned=%d max=%d created=%d", n, assignedMax, createdSeq)
		}
	})

	t.Run("people: intersected with members, one person's name as the label", func(t *testing.T) {
		result := w.mustCreate(t, spec{audience: "people", people: []string{w.alice.ActorID, w.outsider.ActorID, w.agentID}})
		if result.Request.Audience.Count != 1 || result.Request.Audience.Label != "alice" {
			t.Fatalf("summary = %+v", result.Request)
		}
		if _, err := w.create(t, w.author, w.chatID, spec{audience: "people", people: []string{w.outsider.ActorID, w.author.ActorID}}); !errors.Is(err, request.ErrAudienceEmpty) {
			t.Fatalf("empty audience err = %v", err)
		}
	})

	t.Run("department and position wait for wave 2", func(t *testing.T) {
		for _, kind := range []string{"department", "position"} {
			if _, err := w.create(t, w.author, w.chatID, spec{audience: kind}); !errors.Is(err, request.ErrAudienceUnavailable) {
				t.Fatalf("%s err = %v", kind, err)
			}
		}
	})

	t.Run("validation", func(t *testing.T) {
		now := w.clock.Now()
		cases := map[string]spec{
			"custom needs 2 options":  {preset: "custom", options: []string{"Да"}},
			"custom repeats":          {preset: "custom", options: []string{"Да", "да"}},
			"preset with options":     {preset: "ack", options: []string{"a", "b"}},
			"due too soon":            {due: ptr(now.Add(5 * time.Minute))},
			"due too far":             {due: ptr(now.Add(91 * 24 * time.Hour))},
			"auto remind without due": {remind: true},
			"auto remind too close":   {due: ptr(now.Add(30 * time.Minute)), remind: true},
		}
		for name, c := range cases {
			if _, err := w.create(t, w.author, w.chatID, c); !errors.Is(err, request.ErrInvalid) {
				t.Errorf("%s: err = %v", name, err)
			}
		}
	})

	t.Run("idempotent replay and conflict", func(t *testing.T) {
		input := message.CreateRequestInput{
			ClientMsgID: uuid.NewString(), Body: "Готово?", Audience: request.AudienceInput{Kind: "chat"},
			Answer: request.AnswerSpec{Preset: "done"},
		}
		first, created, err := w.messages.CreateRequest(ctx, w.author, w.chatID, input)
		if err != nil || !created {
			t.Fatal(created, err)
		}
		before := w.seq(t)
		again, created, err := w.messages.CreateRequest(ctx, w.author, w.chatID, input)
		if err != nil || created || again.ID != first.ID || again.Request == nil || again.RequestViewer == nil {
			t.Fatalf("replay = %+v, %v, %v", again, created, err)
		}
		if w.seq(t) != before {
			t.Fatal("replay wrote events")
		}
		input.Answer.Preset = "ack"
		if _, _, err := w.messages.CreateRequest(ctx, w.author, w.chatID, input); !errors.Is(err, message.ErrIdempotencyConflict) {
			t.Fatalf("conflict err = %v", err)
		}
	})

	t.Run("limits", func(t *testing.T) {
		limited := request.NewService(w.pool, nil)
		limits := request.DefaultLimits()
		limits.OpenPerChat, limits.MaxRecipients = 1, 2
		limited.SetLimits(limits)
		messages := message.NewService(w.pool, 64*1024, 100, nil)
		messages.SetRequests(limited)
		create := func(chatID string, audience string, people []string) error {
			_, _, err := messages.CreateRequest(ctx, w.author, chatID, message.CreateRequestInput{
				ClientMsgID: uuid.NewString(), Body: "?", Audience: request.AudienceInput{Kind: audience, ActorIDs: people},
				Answer: request.AnswerSpec{Preset: "ack"},
			})
			return err
		}
		if err := create(w.chatID, "chat", nil); !errors.Is(err, request.ErrLimitReached) {
			t.Fatalf("open per chat err = %v (the chat already has open requests)", err)
		}
		limits.OpenPerChat = 1000
		limited.SetLimits(limits)
		if err := create(w.chatID, "chat", nil); !errors.Is(err, request.ErrTooManyRecipients) {
			t.Fatalf("recipients err = %v", err)
		}
		limits.OpenPerAuthor = 1
		limited.SetLimits(limits)
		if err := create(w.otherID, "chat", nil); !errors.Is(err, request.ErrLimitReached) {
			t.Fatalf("open per author err = %v", err)
		}
	})

	t.Run("a replay after the due date went stale returns the original", func(t *testing.T) {
		due := w.clock.Now().Add(15 * time.Minute)
		input := message.CreateRequestInput{
			ClientMsgID: uuid.NewString(), Body: "Скоро?", Audience: request.AudienceInput{Kind: "chat"},
			Answer: request.AnswerSpec{Preset: "ack"}, DueAt: &due,
		}
		first, _, err := w.messages.CreateRequest(ctx, w.author, w.chatID, input)
		if err != nil {
			t.Fatal(err)
		}
		w.clock.Set(w.clock.Now().Add(20 * time.Minute))
		defer w.clock.Set(time.Now().UTC())
		again, created, err := w.messages.CreateRequest(ctx, w.author, w.chatID, input)
		if err != nil || created || again.ID != first.ID {
			t.Fatalf("stale replay = %+v, %v, %v", again.ID, created, err)
		}
		input.ClientMsgID = uuid.NewString()
		if _, _, err := w.messages.CreateRequest(ctx, w.author, w.chatID, input); !errors.Is(err, request.ErrInvalid) {
			t.Fatalf("new request with a past due err = %v", err)
		}
	})

	t.Run("agents and non-members cannot ask", func(t *testing.T) {
		agent := identity.User{ActorID: w.agentID, OrgID: w.orgID, OrgRole: "member", Status: "active"}
		if _, err := w.create(t, agent, w.chatID, spec{}); !errors.Is(err, message.ErrForbidden) {
			t.Fatalf("agent err = %v", err)
		}
		if _, err := w.create(t, w.outsider, w.chatID, spec{}); !errors.Is(err, message.ErrNotFound) {
			t.Fatalf("outsider err = %v", err)
		}
	})
}

func TestAnswers(t *testing.T) {
	w := newWorld(t)
	ctx := context.Background()
	due := w.clock.Now().Add(2 * time.Hour)
	req := w.mustCreate(t, spec{audience: "people", people: []string{w.alice.ActorID, w.bob.ActorID}, due: &due})

	t.Run("first answer, change, repeat without events", func(t *testing.T) {
		state, err := w.answer(w.alice, req.ID, 0, ptr("буду"))
		if err != nil {
			t.Fatal(err)
		}
		if state.Request.AnsweredCount != 1 || state.Request.Audience.Count != 2 || state.Viewer.Answer == nil || state.Viewer.Answer.Late || !state.Viewer.CanChange {
			t.Fatalf("state = %+v", state)
		}
		if state.Viewer.Tally != nil {
			t.Fatal("a recipient sees the tally")
		}
		changed, err := w.answer(w.alice, req.ID, 1, nil)
		if err != nil || changed.Viewer.Answer.Option != 1 || changed.Viewer.Answer.Comment != "буду" || changed.Request.AnsweredCount != 1 {
			t.Fatalf("changed = %+v, %v", changed, err)
		}
		// A changed answer is not visible to the chat: no shared version bump.
		if changed.Request.Version != state.Request.Version {
			t.Fatalf("shared version moved on a change: %d → %d", state.Request.Version, changed.Request.Version)
		}
		if _, err := w.requests.Answer(ctx, w.alice, req.ID, request.AnswerInput{Comment: ptr("x")}); !errors.Is(err, request.ErrInvalid) {
			t.Fatalf("answer without option err = %v", err)
		}
		before := w.seq(t)
		if _, err := w.answer(w.alice, req.ID, 1, ptr("буду")); err != nil {
			t.Fatal(err)
		}
		if w.seq(t) != before {
			t.Fatal("repeating the answer wrote events")
		}
		if _, err := w.requests.Answer(ctx, w.alice, req.ID, request.AnswerInput{Option: ptr(0), ExpectedVersion: ptr(1)}); !errors.Is(err, request.ErrVersionConflict) {
			t.Fatalf("stale version err = %v", err)
		}
	})

	t.Run("who may answer", func(t *testing.T) {
		if _, err := w.answer(w.carol, req.ID, 0, nil); !errors.Is(err, request.ErrForbidden) {
			t.Fatalf("observer err = %v", err)
		}
		if _, err := w.answer(w.outsider, req.ID, 0, nil); !errors.Is(err, request.ErrNotFound) {
			t.Fatalf("outsider err = %v", err)
		}
		if _, err := w.answer(w.bob, req.ID, 2, nil); !errors.Is(err, request.ErrInvalid) {
			t.Fatalf("option beyond buttons err = %v", err)
		}
		if _, err := w.answer(w.bob, req.ID, 0, ptr(strings.Repeat("я", 281))); !errors.Is(err, request.ErrInvalid) {
			t.Fatalf("long comment err = %v", err)
		}
	})

	t.Run("after the due date: late first answer, no change", func(t *testing.T) {
		w.clock.Set(due.Add(time.Minute))
		state, err := w.answer(w.bob, req.ID, 0, nil)
		if err != nil || !state.Viewer.Answer.Late || state.Viewer.CanChange {
			t.Fatalf("late answer = %+v, %v", state, err)
		}
		if _, err := w.answer(w.alice, req.ID, 0, nil); !errors.Is(err, request.ErrChangeTooLate) {
			t.Fatalf("change after due err = %v", err)
		}
	})

	t.Run("comments only where allowed", func(t *testing.T) {
		w.clock.Set(time.Now().UTC())
		quiet := w.mustCreate(t, spec{audience: "people", people: []string{w.alice.ActorID}, comment: ptr(false)})
		if _, err := w.answer(w.alice, quiet.ID, 0, ptr("x")); !errors.Is(err, request.ErrInvalid) {
			t.Fatalf("comment err = %v", err)
		}
	})

	t.Run("closed, left, archived", func(t *testing.T) {
		open := w.mustCreate(t, spec{audience: "people", people: []string{w.alice.ActorID, w.bob.ActorID}})
		if _, err := w.requests.Close(ctx, w.carol, open.ID); !errors.Is(err, request.ErrForbidden) {
			t.Fatalf("observer close err = %v", err)
		}
		state, err := w.requests.Close(ctx, w.admin, open.ID)
		if err != nil || state.Request.Status != "closed" || *state.Request.ClosedReason != "moderator" {
			t.Fatalf("admin close = %+v, %v", state, err)
		}
		before := w.seq(t)
		if _, err := w.requests.Close(ctx, w.author, open.ID); err != nil || w.seq(t) != before {
			t.Fatalf("repeat close err = %v, events %d", err, w.seq(t)-before)
		}
		if _, err := w.answer(w.alice, open.ID, 0, nil); !errors.Is(err, request.ErrClosed) {
			t.Fatalf("closed err = %v", err)
		}

		left := w.mustCreate(t, spec{audience: "people", people: []string{w.bob.ActorID, w.alice.ActorID}})
		if err := w.chats.RemoveMember(ctx, w.owner, w.chatID, w.bob.ActorID); err != nil {
			t.Fatal(err)
		}
		if _, err := w.answer(w.bob, left.ID, 0, nil); !errors.Is(err, request.ErrNotMember) {
			t.Fatalf("left member err = %v", err)
		}
		if _, err := w.pool.Exec(ctx, `UPDATE chats SET archived_at=now() WHERE id=$1`, w.chatID); err != nil {
			t.Fatal(err)
		}
		if _, err := w.answer(w.alice, left.ID, 0, nil); !errors.Is(err, request.ErrChatArchived) {
			t.Fatalf("archived err = %v", err)
		}
		if _, err := w.requests.Remind(ctx, w.author, left.ID); !errors.Is(err, request.ErrChatArchived) {
			t.Fatalf("archived remind err = %v", err)
		}
		if _, err := w.requests.Get(ctx, w.alice, left.ID); !errors.Is(err, request.ErrNotFound) {
			t.Fatalf("archived get err = %v", err)
		}
	})
}

// TestAnswersStayPrivate checks the main promise: only the author and chat
// admins learn who answered what, through REST, realtime and the feed.
func TestAnswersStayPrivate(t *testing.T) {
	w := newWorld(t)
	ctx := context.Background()
	start := w.seq(t)
	req := w.mustCreate(t, spec{audience: "people", people: []string{w.alice.ActorID, w.bob.ActorID}})
	const secret = "секретный-комментарий"
	if _, err := w.answer(w.alice, req.ID, 1, ptr(secret)); err != nil {
		t.Fatal(err)
	}
	if _, err := w.requests.Close(ctx, w.author, req.ID); err != nil {
		t.Fatal(err)
	}
	end := w.seq(t)

	t.Run("realtime frames of an observer carry counters only", func(t *testing.T) {
		store := eventlog.NewStore(w.pool)
		frames, err := store.Replay(ctx, w.carol, "", start, end, 1000)
		if err != nil {
			t.Fatal(err)
		}
		types := map[string]int{}
		for _, frame := range frames {
			types[frame.Type]++
			raw, _ := json.Marshal(frame)
			for _, leak := range []string{secret, w.alice.ActorID, w.bob.ActorID, `"tally"`, "request_viewer", `"option"`} {
				if strings.Contains(string(raw), leak) {
					t.Fatalf("frame %s leaks %q: %s", frame.Type, leak, raw)
				}
			}
		}
		if types["message.created"] != 1 || types["request.updated"] < 2 || types["request.assigned"] != 0 || types["request.tally.updated"] != 0 || types["request.answer.updated"] != 0 {
			t.Fatalf("observer frame types = %v", types)
		}
		// The recipient gets her own answer and nobody else's.
		frames, err = store.Replay(ctx, w.bob, "", start, end, 1000)
		if err != nil {
			t.Fatal(err)
		}
		for _, frame := range frames {
			raw, _ := json.Marshal(frame)
			if strings.Contains(string(raw), secret) || strings.Contains(string(raw), w.alice.ActorID) || frame.Type == "request.tally.updated" || frame.Type == "request.answer.updated" {
				t.Fatalf("bob receives %s: %s", frame.Type, raw)
			}
		}
		frames, err = store.Replay(ctx, w.author, "", start, end, 1000)
		if err != nil {
			t.Fatal(err)
		}
		tally := 0
		for _, frame := range frames {
			if frame.Type == "request.tally.updated" {
				tally++
			}
			if raw, _ := json.Marshal(frame); strings.Contains(string(raw), secret) {
				t.Fatalf("a frame carries the comment: %s", raw)
			}
		}
		if tally != 1 {
			t.Fatalf("author tally frames = %d", tally)
		}
	})

	t.Run("the feed of an observer has no answers", func(t *testing.T) {
		page, err := w.messages.List(ctx, w.carol, w.chatID, message.ListOptions{})
		if err != nil {
			t.Fatal(err)
		}
		raw, _ := json.Marshal(page)
		for _, leak := range []string{secret, w.alice.ActorID} {
			if strings.Contains(string(raw), leak) {
				t.Fatalf("feed leaks %q", leak)
			}
		}
		found := false
		for _, item := range page.Messages {
			if item.ID == req.ID {
				found = true
				if item.RequestViewer == nil || item.RequestViewer.Role != "observer" || item.RequestViewer.Tally != nil || item.Request.AnsweredCount != 1 {
					t.Fatalf("observer view = %+v %+v", item.Request, item.RequestViewer)
				}
			}
		}
		if !found {
			t.Fatal("request not in feed")
		}
	})

	t.Run("an agent, even a chat admin, gets no view of answers", func(t *testing.T) {
		if _, err := w.pool.Exec(ctx, `UPDATE chat_members SET role='admin' WHERE chat_id=$1 AND actor_id=$2`, w.chatID, w.agentID); err != nil {
			t.Fatal(err)
		}
		agent := identity.User{ActorID: w.agentID, OrgID: w.orgID, OrgRole: "member", Status: "active"}
		page, err := w.messages.List(ctx, agent, w.chatID, message.ListOptions{})
		if err != nil {
			t.Fatal(err)
		}
		raw, _ := json.Marshal(page)
		if strings.Contains(string(raw), "request_viewer") || strings.Contains(string(raw), secret) {
			t.Fatalf("agent feed = %s", raw)
		}
	})

	t.Run("answers: author and current chat admins only", func(t *testing.T) {
		for _, user := range []identity.User{w.author, w.admin, w.owner} {
			page, err := w.requests.Answers(ctx, user, req.ID, request.AnswerListOptions{})
			if err != nil {
				t.Fatalf("%s: %v", user.ActorID, err)
			}
			if len(page.Items) != 2 || page.Counts.Waiting != 1 || page.Counts.Options[1] != 1 {
				t.Fatalf("page = %+v", page)
			}
			if page.Items[0].State != "waiting" || page.Items[1].Comment != secret {
				t.Fatalf("items = %+v", page.Items)
			}
		}
		for _, user := range []identity.User{w.carol, w.alice, w.bob} {
			if _, err := w.requests.Answers(ctx, user, req.ID, request.AnswerListOptions{}); !errors.Is(err, request.ErrForbidden) {
				t.Fatalf("member err = %v", err)
			}
		}
		if _, err := w.requests.Answers(ctx, w.outsider, req.ID, request.AnswerListOptions{}); !errors.Is(err, request.ErrNotFound) {
			t.Fatalf("outsider err = %v", err)
		}
		// A former admin loses access at once.
		if _, err := w.pool.Exec(ctx, `UPDATE chat_members SET role='member' WHERE chat_id=$1 AND actor_id=$2`, w.chatID, w.admin.ActorID); err != nil {
			t.Fatal(err)
		}
		if _, err := w.requests.Answers(ctx, w.admin, req.ID, request.AnswerListOptions{}); !errors.Is(err, request.ErrForbidden) {
			t.Fatalf("former admin err = %v", err)
		}
		state, err := w.requests.Get(ctx, w.admin, req.ID)
		if err != nil || state.Viewer.Tally != nil || state.Viewer.CanViewAnswers {
			t.Fatalf("former admin view = %+v, %v", state.Viewer, err)
		}
		// An author who left the chat loses access too.
		if _, err := w.pool.Exec(ctx, `DELETE FROM chat_members WHERE chat_id=$1 AND actor_id=$2`, w.chatID, w.author.ActorID); err != nil {
			t.Fatal(err)
		}
		if _, err := w.requests.Answers(ctx, w.author, req.ID, request.AnswerListOptions{}); !errors.Is(err, request.ErrNotFound) {
			t.Fatalf("former author err = %v", err)
		}
	})
}

func TestAnswersPagination(t *testing.T) {
	w := newWorld(t)
	ctx := context.Background()
	req := w.mustCreate(t, spec{})
	for _, user := range []identity.User{w.alice, w.bob} {
		if _, err := w.answer(user, req.ID, 0, nil); err != nil {
			t.Fatal(err)
		}
	}
	seen := map[string]bool{}
	var cursor *string
	for range 10 {
		page, err := w.requests.Answers(ctx, w.author, req.ID, request.AnswerListOptions{Limit: 2, Cursor: cursor})
		if err != nil {
			t.Fatal(err)
		}
		for _, item := range page.Items {
			if seen[item.ActorID] {
				t.Fatalf("%s listed twice", item.ActorID)
			}
			seen[item.ActorID] = true
		}
		if page.NextCursor == nil {
			break
		}
		cursor = page.NextCursor
	}
	if len(seen) != 5 {
		t.Fatalf("listed %d recipients, want 5", len(seen))
	}
	page, err := w.requests.Answers(ctx, w.author, req.ID, request.AnswerListOptions{Filter: "option:0"})
	if err != nil || len(page.Items) != 2 {
		t.Fatalf("option filter = %+v, %v", page, err)
	}
	page, err = w.requests.Answers(ctx, w.author, req.ID, request.AnswerListOptions{Filter: "waiting"})
	if err != nil || len(page.Items) != 3 {
		t.Fatalf("waiting filter = %+v, %v", page, err)
	}
}

func TestDenominatorAndInbox(t *testing.T) {
	w := newWorld(t)
	ctx := context.Background()
	unread := userstate.NewService(w.pool, 1024, nil)
	due := w.clock.Now().Add(24 * time.Hour)
	first := w.mustCreate(t, spec{audience: "people", people: []string{w.alice.ActorID, w.bob.ActorID, w.carol.ActorID}, due: &due})
	second := w.mustCreate(t, spec{audience: "people", people: []string{w.alice.ActorID}})

	inbox := func(user identity.User, state string) []string {
		t.Helper()
		page, err := w.messages.RequestInbox(ctx, user, message.RequestInboxOptions{State: state})
		if err != nil {
			t.Fatal(err)
		}
		ids := []string{}
		for _, item := range page.Items {
			ids = append(ids, item.Message.ID)
		}
		return ids
	}
	if got := inbox(w.alice, "waiting"); len(got) != 2 || got[0] != first.ID || got[1] != second.ID {
		t.Fatalf("waiting = %v; want the one with a due date first", got)
	}
	snapshot, err := unread.Unread(ctx, w.alice)
	if err != nil || snapshot.RequestsWaitingTotal != 2 {
		t.Fatalf("unread = %+v, %v", snapshot, err)
	}
	for _, item := range snapshot.Chats {
		if item.ChatID == w.chatID && (item.RequestsWaiting != 2 || item.RequestsNextDueAt == nil || !item.RequestsNextDueAt.Equal(due) || item.MentionCount != 2) {
			t.Fatalf("chat unread = %+v", item)
		}
	}
	if _, err := w.answer(w.alice, first.ID, 0, nil); err != nil {
		t.Fatal(err)
	}
	if got := inbox(w.alice, "answered"); len(got) != 1 || got[0] != first.ID {
		t.Fatalf("answered = %v", got)
	}

	// Alice answered and leaves: still counted. Bob leaves without an
	// answer: drops out of «N из M», and the chat hears about it.
	before := w.seq(t)
	for _, user := range []identity.User{w.alice, w.bob} {
		if err := w.chats.RemoveMember(ctx, w.owner, w.chatID, user.ActorID); err != nil {
			t.Fatal(err)
		}
	}
	// No chat-wide event on leaving: it would tell the chat that bob was
	// asked and had not answered. The count is recomputed on reading.
	if n := w.count(t, `SELECT count(*) FROM events WHERE type LIKE 'request.%' AND subject_id=$1 AND seq>$2`, first.ID, before); n != 0 {
		t.Fatalf("request events on leave = %d, want 0", n)
	}
	state, err := w.requests.Get(ctx, w.carol, first.ID)
	if err != nil || state.Request.Audience.Count != 2 || state.Request.AnsweredCount != 1 || state.Request.WaitingCount != 1 {
		t.Fatalf("after leaving = %+v, %v", state.Request, err)
	}
	if got := inbox(w.alice, "waiting"); len(got) != 0 {
		t.Fatalf("a former member's inbox = %v", got)
	}
	if got := inbox(w.carol, "waiting"); len(got) != 1 {
		t.Fatalf("carol inbox = %v", got)
	}
	page, err := w.requests.Answers(ctx, w.author, first.ID, request.AnswerListOptions{})
	if err != nil || len(page.Items) != 2 || page.Items[1].State != "left" {
		t.Fatalf("answers after leaving = %+v, %v", page.Items, err)
	}
}

func TestMessageDeletionClosesRequest(t *testing.T) {
	w := newWorld(t)
	ctx := context.Background()
	due := w.clock.Now().Add(48 * time.Hour)
	req := w.mustCreate(t, spec{due: &due, remind: true})
	remindJob, _ := w.jobs.job(t, request.KindAutoRemind, req.ID)
	expireJob, expire := w.jobs.job(t, request.KindExpire, req.ID)
	if !expire.at.Equal(due.Add(14 * 24 * time.Hour)) {
		t.Fatalf("expire at %s", expire.at)
	}
	if _, err := w.messages.Delete(ctx, w.author, req.ID); err != nil {
		t.Fatal(err)
	}
	if !w.jobs.cancelled[remindJob] || !w.jobs.cancelled[expireJob] {
		t.Fatal("jobs not cancelled")
	}
	var status, reason string
	if err := w.pool.QueryRow(ctx, `SELECT status, closed_reason FROM message_requests WHERE message_id=$1`, req.ID).Scan(&status, &reason); err != nil || status != "closed" || reason != "message_deleted" {
		t.Fatalf("status = %s %s %v", status, reason, err)
	}
	page, err := w.messages.RequestInbox(ctx, w.alice, message.RequestInboxOptions{})
	if err != nil || len(page.Items) != 0 {
		t.Fatalf("inbox = %+v, %v", page, err)
	}
	if _, err := w.answer(w.alice, req.ID, 0, nil); !errors.Is(err, request.ErrNotFound) {
		t.Fatalf("answer deleted err = %v", err)
	}
	if n := w.count(t, `SELECT count(*) FROM events WHERE type='request.updated' AND subject_id=$1`, req.ID); n != 1 {
		t.Fatalf("request.updated = %d", n)
	}
}

func TestAutoRemind(t *testing.T) {
	w := newWorld(t)
	ctx := context.Background()
	created := w.clock.Now()
	due := created.Add(72 * time.Hour)
	req := w.mustCreate(t, spec{audience: "people", people: []string{w.alice.ActorID, w.bob.ActorID}, due: &due, remind: true})
	if want := due.Add(-24 * time.Hour); req.Request.AutoRemindAt == nil || !req.Request.AutoRemindAt.Equal(want) {
		t.Fatalf("auto_remind_at = %v, want %s", req.Request.AutoRemindAt, want)
	}
	if got := request.AutoRemindAt(created, created.Add(8*time.Hour)); !got.Equal(created.Add(4 * time.Hour)) {
		t.Fatalf("short due auto remind = %s", got)
	}
	jobID, job := w.jobs.job(t, request.KindAutoRemind, req.ID)
	if _, err := w.answer(w.alice, req.ID, 0, nil); err != nil {
		t.Fatal(err)
	}

	// Early: snooze. Stale job: nothing.
	var snooze request.Snooze
	if err := w.requests.AutoRemind(ctx, req.ID, jobID); !errors.As(err, &snooze) {
		t.Fatalf("early err = %v", err)
	}
	before := w.seq(t)
	w.clock.Set(job.at.Add(time.Minute))
	if err := w.requests.AutoRemind(ctx, req.ID, jobID+100); err != nil || w.seq(t) != before {
		t.Fatalf("stale job err = %v, events %d", err, w.seq(t)-before)
	}
	if err := w.requests.AutoRemind(ctx, req.ID, jobID); err != nil {
		t.Fatal(err)
	}
	if n := w.count(t, `SELECT count(*) FROM events WHERE type='request.reminded' AND subject_id=$1 AND audience_actor_id=$2 AND data->>'kind'='auto'`, req.ID, w.bob.ActorID); n != 1 {
		t.Fatalf("bob reminded %d times", n)
	}
	if n := w.count(t, `SELECT count(*) FROM events WHERE type='request.reminded' AND subject_id=$1 AND audience_actor_id=$2`, req.ID, w.alice.ActorID); n != 0 {
		t.Fatal("alice answered and was reminded")
	}
	var data string
	if err := w.pool.QueryRow(ctx, `SELECT data::text FROM events WHERE type='request.auto_reminded' AND subject_id=$1 AND audience_actor_id=$2`, req.ID, w.author.ActorID).Scan(&data); err != nil {
		t.Fatal(err)
	}
	var summary struct {
		Reminded     int `json:"reminded"`
		WaitingCount int `json:"waiting_count"`
	}
	_ = json.Unmarshal([]byte(data), &summary)
	if summary.Reminded != 1 || summary.WaitingCount != 1 {
		t.Fatalf("summary = %s", data)
	}
	if n := w.count(t, `SELECT count(*) FROM notification_jobs WHERE org_id=$1`, w.orgID); n < 2 {
		t.Fatalf("push jobs = %d", n)
	}
	// Running again does nothing.
	before = w.seq(t)
	if err := w.requests.AutoRemind(ctx, req.ID, jobID); err != nil || w.seq(t) != before {
		t.Fatalf("second run err = %v", err)
	}

	skipped := func(t *testing.T, name string, prepare func(message.Message, scheduledJob)) {
		t.Helper()
		w.clock.Set(time.Now().UTC())
		due := w.clock.Now().Add(72 * time.Hour)
		other := w.mustCreate(t, spec{audience: "people", people: []string{w.carol.ActorID}, due: &due, remind: true})
		jobID, job := w.jobs.job(t, request.KindAutoRemind, other.ID)
		prepare(other, job)
		if err := w.requests.AutoRemind(ctx, other.ID, jobID); err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		if n := w.count(t, `SELECT count(*) FROM events WHERE type IN ('request.reminded','request.auto_reminded') AND subject_id=$1`, other.ID); n != 0 {
			t.Fatalf("%s: reminded anyway", name)
		}
	}
	skipped(t, "more than 2 hours late", func(_ message.Message, job scheduledJob) { w.clock.Set(job.at.Add(3 * time.Hour)) })
	skipped(t, "author left", func(m message.Message, job scheduledJob) {
		w.clock.Set(job.at)
		if _, err := w.pool.Exec(ctx, `DELETE FROM chat_members WHERE chat_id=$1 AND actor_id=$2`, w.chatID, w.author.ActorID); err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() {
			_, _ = w.pool.Exec(ctx, `INSERT INTO chat_members (chat_id, actor_id, org_id, role) VALUES ($1, $2, $3, 'member') ON CONFLICT DO NOTHING`, w.chatID, w.author.ActorID, w.orgID)
		})
	})
}

func TestManualRemindAndDailyLimit(t *testing.T) {
	w := newWorld(t)
	ctx := context.Background()
	req := w.mustCreate(t, spec{audience: "people", people: []string{w.alice.ActorID}})
	result, err := w.requests.Remind(ctx, w.author, req.ID)
	if err != nil || result.Reminded != 1 || result.NextRemindAt == nil {
		t.Fatalf("remind = %+v, %v", result, err)
	}
	var tooSoon *request.RemindTooSoonError
	if _, err := w.requests.Remind(ctx, w.author, req.ID); !errors.As(err, &tooSoon) || tooSoon.RetryAfter <= 0 {
		t.Fatalf("second remind err = %v", err)
	}
	if _, err := w.requests.Remind(ctx, w.admin, req.ID); !errors.Is(err, request.ErrForbidden) {
		t.Fatalf("admin remind err = %v", err)
	}
	// Five manual reminders at most.
	for range 4 {
		w.clock.Set(w.clock.Now().Add(2 * time.Hour))
		if _, err := w.requests.Remind(ctx, w.author, req.ID); err != nil {
			t.Fatal(err)
		}
	}
	w.clock.Set(w.clock.Now().Add(2 * time.Hour))
	if _, err := w.requests.Remind(ctx, w.author, req.ID); !errors.Is(err, request.ErrLimitReached) {
		t.Fatalf("sixth remind err = %v", err)
	}

	// Ten reminders a day per person from all requests, every reminder
	// counted; the rest are counted in reminded but not sent.
	start := time.Now().UTC().Add(48 * time.Hour)
	w.clock.Set(start)
	sent := 0
	repeated := w.mustCreate(t, spec{audience: "people", people: []string{w.bob.ActorID}})
	for range 5 {
		if _, err := w.requests.Remind(ctx, w.author, repeated.ID); err != nil {
			t.Fatal(err)
		}
		w.clock.Set(w.clock.Now().Add(2 * time.Hour))
	}
	sent += w.count(t, `SELECT count(*) FROM events WHERE type='request.reminded' AND subject_id=$1`, repeated.ID)
	for range 7 {
		other := w.mustCreate(t, spec{audience: "people", people: []string{w.bob.ActorID}})
		result, err := w.requests.Remind(ctx, w.author, other.ID)
		if err != nil || result.Reminded != 1 {
			t.Fatalf("remind = %+v, %v", result, err)
		}
		sent += w.count(t, `SELECT count(*) FROM events WHERE type='request.reminded' AND subject_id=$1`, other.ID)
	}
	if sent != 10 {
		t.Fatalf("sent %d reminders to bob, want 10", sent)
	}
	// A day after the first ones, the window has room again.
	w.clock.Set(start.Add(25 * time.Hour))
	later := w.mustCreate(t, spec{audience: "people", people: []string{w.bob.ActorID}})
	if _, err := w.requests.Remind(ctx, w.author, later.ID); err != nil {
		t.Fatal(err)
	}
	if n := w.count(t, `SELECT count(*) FROM events WHERE type='request.reminded' AND subject_id=$1`, later.ID); n != 1 {
		t.Fatalf("reminder after the window = %d", n)
	}
}

func TestExpire(t *testing.T) {
	w := newWorld(t)
	ctx := context.Background()
	start := w.clock.Now()
	due := start.Add(time.Hour)
	withDue := w.mustCreate(t, spec{due: &due})
	jobID, job := w.jobs.job(t, request.KindExpire, withDue.ID)
	w.clock.Set(job.at.Add(-time.Minute))
	var snooze request.Snooze
	if err := w.requests.Expire(ctx, withDue.ID, jobID); !errors.As(err, &snooze) {
		t.Fatalf("early err = %v", err)
	}
	w.clock.Set(job.at)
	if err := w.requests.Expire(ctx, withDue.ID, jobID); err != nil {
		t.Fatal(err)
	}
	state, err := w.requests.Get(ctx, w.alice, withDue.ID)
	if err != nil || state.Request.Status != "closed" || *state.Request.ClosedReason != "expired" {
		t.Fatalf("expired = %+v, %v", state.Request, err)
	}

	// Without a due date: 30 days after the last answer.
	w.clock.Set(start)
	idle := w.mustCreate(t, spec{})
	jobID, job = w.jobs.job(t, request.KindExpire, idle.ID)
	if !job.at.Equal(start.Add(30 * 24 * time.Hour)) {
		t.Fatalf("idle expiry at %s", job.at)
	}
	w.clock.Set(start.Add(20 * 24 * time.Hour))
	if _, err := w.answer(w.alice, idle.ID, 0, nil); err != nil {
		t.Fatal(err)
	}
	w.clock.Set(job.at)
	if err := w.requests.Expire(ctx, idle.ID, jobID); !errors.As(err, &snooze) || snooze.Delay != 20*24*time.Hour {
		t.Fatalf("moved expiry err = %v", err)
	}
	w.clock.Set(start.Add(50 * 24 * time.Hour))
	if err := w.requests.Expire(ctx, idle.ID, jobID); err != nil {
		t.Fatal(err)
	}
	if n := w.count(t, `SELECT count(*) FROM message_requests WHERE message_id=$1 AND status='closed' AND closed_reason='expired'`, idle.ID); n != 1 {
		t.Fatal("idle request not expired")
	}
}

// TestRequestLockOrder races answers, closing and reminders against the
// deletion of the message: no deadlock, and the request ends closed.
func TestRequestLockOrder(t *testing.T) {
	w := newWorld(t)
	ctx := context.Background()
	const rounds = 25
	for round := range rounds {
		req := w.mustCreate(t, spec{})
		var wait sync.WaitGroup
		errs := make(chan error, 8)
		run := func(fn func() error) {
			wait.Add(1)
			go func() { defer wait.Done(); errs <- fn() }()
		}
		for _, user := range []identity.User{w.alice, w.bob, w.carol} {
			run(func() error { _, err := w.answer(user, req.ID, 1, nil); return err })
		}
		run(func() error { _, err := w.requests.Remind(ctx, w.author, req.ID); return err })
		run(func() error { _, err := w.requests.Close(ctx, w.admin, req.ID); return err })
		run(func() error { _, err := w.messages.Delete(ctx, w.author, req.ID); return err })
		run(func() error {
			_, _, err := w.messages.Create(ctx, w.owner, w.chatID, message.CreateInput{ClientMsgID: uuid.NewString(), Body: "x"})
			return err
		})
		wait.Wait()
		close(errs)
		for err := range errs {
			if err == nil || errors.Is(err, request.ErrNotFound) || errors.Is(err, request.ErrClosed) {
				continue
			}
			if strings.Contains(err.Error(), "deadlock") {
				t.Fatalf("round %d: %v", round, err)
			}
			t.Fatalf("round %d: unexpected %v", round, err)
		}
		if n := w.count(t, `SELECT count(*) FROM message_requests WHERE message_id=$1 AND status='closed'`, req.ID); n != 1 {
			t.Fatalf("round %d: request still open", round)
		}
	}
}

// TestConcurrentChangesUseVersions: two devices change one answer from the
// same version; one wins, the other gets a conflict.
func TestConcurrentChangesUseVersions(t *testing.T) {
	w := newWorld(t)
	ctx := context.Background()
	req := w.mustCreate(t, spec{preset: "custom", options: []string{"Утро", "День", "Вечер"}})
	state, err := w.answer(w.alice, req.ID, 0, nil)
	if err != nil {
		t.Fatal(err)
	}
	version := state.Viewer.Answer.Version
	var wait sync.WaitGroup
	results := make([]error, 2)
	for index, option := range []int{1, 2} {
		wait.Add(1)
		go func() {
			defer wait.Done()
			_, results[index] = w.requests.Answer(ctx, w.alice, req.ID, request.AnswerInput{Option: &option, ExpectedVersion: &version})
		}()
	}
	wait.Wait()
	conflicts := 0
	for _, err := range results {
		if errors.Is(err, request.ErrVersionConflict) {
			conflicts++
		} else if err != nil {
			t.Fatal(err)
		}
	}
	if conflicts != 1 {
		t.Fatalf("conflicts = %d, want 1", conflicts)
	}
	page, err := w.requests.Answers(ctx, w.author, req.ID, request.AnswerListOptions{Filter: "option:0"})
	if err != nil || len(page.Items) != 0 || page.Counts.Options[1]+page.Counts.Options[2] != 1 {
		t.Fatalf("after race = %+v, %v", page, err)
	}
}

// TestManyRecipients: a request to 500 people and 200 parallel answers.
func TestManyRecipients(t *testing.T) {
	if testing.Short() {
		t.Skip("load test")
	}
	w := newWorld(t)
	ctx := context.Background()
	people := make([]identity.User, 0, 500)
	batch := &pgx.Batch{}
	for index := range 495 {
		user := identity.User{ActorID: uuid.NewString(), OrgID: w.orgID, OrgRole: "member", Status: "active"}
		handle := "p" + strings.ReplaceAll(user.ActorID[:8], "-", "") + string(rune('a'+index%26))
		batch.Queue(`INSERT INTO actors (id, org_id, type, org_role, display_name, handle) VALUES ($1, $2, 'user', 'member', $3, $4)`, user.ActorID, w.orgID, handle, handle)
		batch.Queue(`INSERT INTO chat_members (chat_id, actor_id, org_id, role) VALUES ($1, $2, $3, 'member')`, w.chatID, user.ActorID, w.orgID)
		people = append(people, user)
	}
	if err := w.pool.SendBatch(ctx, batch).Close(); err != nil {
		t.Fatal(err)
	}
	started := time.Now()
	req := w.mustCreate(t, spec{})
	if req.Request.Audience.Count != 500 {
		t.Fatalf("count = %d", req.Request.Audience.Count)
	}
	t.Logf("request to 500 people: %s", time.Since(started))
	started = time.Now()
	var wait sync.WaitGroup
	errs := make(chan error, 200)
	for _, user := range people[:200] {
		wait.Add(1)
		go func() {
			defer wait.Done()
			_, err := w.answer(user, req.ID, 0, nil)
			errs <- err
		}()
	}
	wait.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatal(err)
		}
	}
	t.Logf("200 parallel answers: %s", time.Since(started))
	state, err := w.requests.Get(ctx, w.author, req.ID)
	if err != nil || state.Request.AnsweredCount != 200 || state.Viewer.Tally[0] != 200 {
		t.Fatalf("state = %+v, %v", state, err)
	}
}
