package scheduled

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/comamessenger/comamessenger/core/internal/files"
	"github.com/comamessenger/comamessenger/core/internal/identity"
	"github.com/comamessenger/comamessenger/core/internal/message"
	"github.com/comamessenger/comamessenger/core/internal/storage"
	"github.com/comamessenger/comamessenger/core/internal/testdb"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type fakeScheduler struct {
	mu        sync.Mutex
	next      int64
	scheduled map[int64]time.Time
	cancelled []int64
}

func (f *fakeScheduler) ScheduleTx(_ context.Context, _ pgx.Tx, _ string, at time.Time) (int64, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.next++
	if f.scheduled == nil {
		f.scheduled = map[int64]time.Time{}
	}
	f.scheduled[f.next] = at
	return f.next, nil
}

func (f *fakeScheduler) CancelTx(_ context.Context, _ pgx.Tx, jobID int64) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.cancelled = append(f.cancelled, jobID)
	return nil
}

func (f *fakeScheduler) wasCancelled(jobID int64) bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, id := range f.cancelled {
		if id == jobID {
			return true
		}
	}
	return false
}

type world struct {
	pool      *pgxpool.Pool
	service   *Service
	messages  *message.Service
	scheduler *fakeScheduler
	orgID     string
	owner     Author // org owner, owns the chats
	author    Author // the person scheduling
	other     Author // another member of the group
	admin     Author // organization admin, member of nothing
	groupID   string
	channelID string
	outsideID string // a group the author is not in
}

func newWorld(t *testing.T) *world {
	t.Helper()
	pool := testdb.New(t)
	ctx := context.Background()
	w := &world{pool: pool, orgID: uuid.NewString(), groupID: uuid.NewString(), channelID: uuid.NewString(), outsideID: uuid.NewString()}
	person := func(role, handle string) Author {
		return Author{User: identity.User{ActorID: uuid.NewString(), OrgID: w.orgID, OrgRole: role, Status: "active"}, SessionID: uuid.NewString()}
	}
	w.owner, w.author, w.other, w.admin = person("owner", "owner"), person("member", "author"), person("member", "other"), person("admin", "admin")
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
	for _, p := range []struct {
		a      Author
		handle string
	}{{w.owner, "owner"}, {w.author, "author"}, {w.other, "other"}, {w.admin, "admin"}} {
		exec(`INSERT INTO actors (id, org_id, type, org_role, display_name, handle) VALUES ($1, $2, 'user', $3, $4, $5)`, p.a.User.ActorID, w.orgID, p.a.User.OrgRole, p.handle, p.handle)
		exec(`INSERT INTO users (actor_id, org_id, email, password_hash) VALUES ($1, $2, $3, 'hash')`, p.a.User.ActorID, w.orgID, p.handle+"@example.test")
		exec(`INSERT INTO sessions (id, org_id, actor_id, family_id, refresh_hash, expires_at) VALUES ($1, $2, $3, $1, sha256(convert_to(gen_random_uuid()::text, 'UTF8')), now() + interval '1 day')`,
			p.a.SessionID, w.orgID, p.a.User.ActorID)
	}
	for _, chat := range []struct{ id, kind string }{{w.groupID, "group"}, {w.channelID, "channel"}, {w.outsideID, "group"}} {
		exec(`INSERT INTO chats (id, org_id, kind, visibility, name, created_by) VALUES ($1, $2, $3, 'private', $3, $4)`, chat.id, w.orgID, chat.kind, w.owner.User.ActorID)
		exec(`INSERT INTO chat_members (chat_id, actor_id, org_id, role) VALUES ($1, $2, $3, 'owner')`, chat.id, w.owner.User.ActorID, w.orgID)
	}
	exec(`INSERT INTO chat_members (chat_id, actor_id, org_id, role) VALUES ($1, $2, $4, 'member'), ($1, $3, $4, 'member'), ($5, $2, $4, 'member')`,
		w.groupID, w.author.User.ActorID, w.other.User.ActorID, w.orgID, w.channelID)
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	w.messages = message.NewService(pool, 1024, 100, nil)
	w.service = NewService(pool, w.messages, nil, slog.New(slog.NewTextHandler(io.Discard, nil)))
	w.scheduler = &fakeScheduler{}
	w.service.SetScheduler(w.scheduler)
	return w
}

func (w *world) input(body string) CreateInput {
	return CreateInput{ClientMsgID: uuid.NewString(), Body: body, BodyFormat: "plain", SendAt: time.Now().Add(time.Hour)}
}

func (w *world) create(t *testing.T, chatID string, input CreateInput) ScheduledMessage {
	t.Helper()
	result, created, err := w.service.Create(context.Background(), w.author, chatID, input)
	if err != nil || !created {
		t.Fatalf("Create() created=%v error=%v", created, err)
	}
	return result
}

// makeDue moves the send time into the past, as if the time had come.
func (w *world) makeDue(t *testing.T, id string) {
	t.Helper()
	if _, err := w.pool.Exec(context.Background(), `UPDATE scheduled_messages SET send_at = now() - interval '1 second' WHERE id = $1`, id); err != nil {
		t.Fatal(err)
	}
}

func (w *world) load(t *testing.T, id string) ScheduledMessage {
	t.Helper()
	var item ScheduledMessage
	if err := scan(w.pool.QueryRow(context.Background(), `SELECT `+selectColumns+` FROM scheduled_messages sm WHERE sm.id = $1`, id), &item); err != nil {
		t.Fatal(err)
	}
	return item
}

func (w *world) deliver(t *testing.T, item ScheduledMessage) {
	t.Helper()
	if err := w.service.Deliver(context.Background(), item.ID, *w.load(t, item.ID).riverJobID); err != nil {
		t.Fatalf("Deliver() error = %v", err)
	}
}

func (w *world) count(t *testing.T, query string, args ...any) int {
	t.Helper()
	var result int
	if err := w.pool.QueryRow(context.Background(), query, args...).Scan(&result); err != nil {
		t.Fatal(err)
	}
	return result
}

func (w *world) file(t *testing.T, uploader Author) string {
	t.Helper()
	fileID := uuid.NewString()
	if _, err := w.pool.Exec(context.Background(), `
		INSERT INTO files (id, org_id, uploader_id, storage_driver, storage_key, name, mime, size, status, processing_status, ready_at)
		VALUES ($1, $2, $3, 'local', $4, 'notes.txt', 'text/plain', 5, 'ready', 'skipped', now() - interval '2 days')`,
		fileID, w.orgID, uploader.User.ActorID, "objects/test/"+fileID); err != nil {
		t.Fatal(err)
	}
	return fileID
}

type event struct {
	Type     string
	Audience *string
	ChatID   *string
	Data     map[string]any
}

func (w *world) events(t *testing.T, subjectID string) []event {
	t.Helper()
	rows, err := w.pool.Query(context.Background(), `SELECT type, audience_actor_id, chat_id, data FROM events WHERE subject_id = $1 ORDER BY seq`, subjectID)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var result []event
	for rows.Next() {
		var item event
		var raw []byte
		if err := rows.Scan(&item.Type, &item.Audience, &item.ChatID, &raw); err != nil {
			t.Fatal(err)
		}
		if err := json.Unmarshal(raw, &item.Data); err != nil {
			t.Fatal(err)
		}
		result = append(result, item)
	}
	return result
}

func TestCreateChecksRightsAndInput(t *testing.T) {
	w := newWorld(t)
	ctx := context.Background()
	cases := []struct {
		name   string
		author Author
		chatID string
		mutate func(*CreateInput)
		want   error
	}{
		{"agent api key has no session", Author{User: w.author.User}, w.groupID, nil, ErrForbidden},
		{"foreign session", Author{User: w.author.User, SessionID: w.other.SessionID}, w.groupID, nil, ErrForbidden},
		{"not a member", w.author, w.outsideID, nil, ErrNotFound},
		{"channel member cannot write", w.author, w.channelID, nil, ErrForbidden},
		{"past", w.author, w.groupID, func(in *CreateInput) { in.SendAt = time.Now().Add(-time.Minute) }, ErrInvalid},
		{"missing time", w.author, w.groupID, func(in *CreateInput) { in.SendAt = time.Time{} }, ErrInvalid},
		{"beyond a year", w.author, w.groupID, func(in *CreateInput) { in.SendAt = time.Now().Add(MaxHorizon + time.Hour) }, ErrInvalid},
		{"too large", w.author, w.groupID, func(in *CreateInput) { in.Body = strings.Repeat("x", 1025) }, ErrTooLarge},
		{"blank", w.author, w.groupID, func(in *CreateInput) { in.Body = "  " }, ErrInvalid},
		{"foreign reply", w.author, w.groupID, func(in *CreateInput) { value := uuid.NewString(); in.ReplyToID = &value }, ErrInvalid},
		{"mention of a non-member", w.author, w.groupID, func(in *CreateInput) { in.MentionedActorIDs = []string{w.admin.User.ActorID} }, ErrInvalid},
		{"someone else's file", w.author, w.groupID, func(in *CreateInput) { in.FileIDs = []string{w.file(t, w.other)} }, ErrInvalid},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			input := w.input("hello")
			if tc.mutate != nil {
				tc.mutate(&input)
			}
			if _, _, err := w.service.Create(ctx, tc.author, tc.chatID, input); !errors.Is(err, tc.want) {
				t.Fatalf("Create() error = %v, want %v", err, tc.want)
			}
		})
	}
	if got := w.count(t, `SELECT count(*) FROM scheduled_messages`); got != 0 {
		t.Fatalf("refused creates stored %d records", got)
	}

	t.Run("deactivated author", func(t *testing.T) {
		if _, err := w.pool.Exec(ctx, `UPDATE actors SET status='deactivated' WHERE id=$1`, w.other.User.ActorID); err != nil {
			t.Fatal(err)
		}
		defer w.pool.Exec(ctx, `UPDATE actors SET status='active' WHERE id=$1`, w.other.User.ActorID)
		if _, _, err := w.service.Create(ctx, w.other, w.groupID, w.input("hi")); !errors.Is(err, ErrForbidden) {
			t.Fatalf("Create() error = %v, want ErrForbidden", err)
		}
	})
	t.Run("revoked session", func(t *testing.T) {
		if _, err := w.pool.Exec(ctx, `UPDATE sessions SET revoked_at=now() WHERE id=$1`, w.other.SessionID); err != nil {
			t.Fatal(err)
		}
		defer w.pool.Exec(ctx, `UPDATE sessions SET revoked_at=NULL WHERE id=$1`, w.other.SessionID)
		if _, _, err := w.service.Create(ctx, w.other, w.groupID, w.input("hi")); !errors.Is(err, ErrForbidden) {
			t.Fatalf("Create() error = %v, want ErrForbidden", err)
		}
	})
}

func TestCreateIsIdempotentAndPrivate(t *testing.T) {
	w := newWorld(t)
	ctx := context.Background()
	input := w.input("see you tomorrow")
	input.MentionedActorIDs = []string{w.other.User.ActorID}
	first := w.create(t, w.groupID, input)
	if first.Status != StatusPending || first.Version != 1 || len(first.MentionedActorIDs) != 1 {
		t.Fatalf("created = %#v", first)
	}
	if _, ok := w.scheduler.scheduled[*w.load(t, first.ID).riverJobID]; !ok {
		t.Fatal("delivery job was not scheduled")
	}
	again, created, err := w.service.Create(ctx, w.author, w.groupID, input)
	if err != nil || created || again.ID != first.ID {
		t.Fatalf("repeat Create() = %v created=%v error=%v", again.ID, created, err)
	}
	changed := input
	changed.Body = "something else"
	if _, _, err := w.service.Create(ctx, w.author, w.groupID, changed); !errors.Is(err, ErrIdempotencyConflict) {
		t.Fatalf("conflicting Create() error = %v", err)
	}
	// The sent message's client_msg_id is reserved: an ordinary send cannot
	// take it to hijack or break the delivery, and clients never see it.
	if _, _, err := w.messages.Create(ctx, w.author.User, w.groupID, message.CreateInput{ClientMsgID: MessageClientID(first.ID), Body: "hijack"}); !errors.Is(err, message.ErrIdempotencyConflict) {
		t.Fatalf("ordinary send with the reserved id error = %v", err)
	}
	encoded, _ := json.Marshal(first)
	if strings.Contains(string(encoded), MessageClientID(first.ID)) {
		t.Fatal("the reserved client_msg_id leaks to the client")
	}

	// Only the author sees and changes it; everyone else gets "not found".
	for name, stranger := range map[string]Author{"chat member": w.other, "org owner": w.owner, "org admin": w.admin} {
		t.Run(name, func(t *testing.T) {
			if _, err := w.service.Get(ctx, stranger, first.ID); !errors.Is(err, ErrNotFound) {
				t.Fatalf("Get() error = %v", err)
			}
			body := "hijack"
			if _, err := w.service.Update(ctx, stranger, first.ID, UpdateInput{ExpectedVersion: 1, Body: &body}); !errors.Is(err, ErrNotFound) {
				t.Fatalf("Update() error = %v", err)
			}
			if err := w.service.Delete(ctx, stranger, first.ID); !errors.Is(err, ErrNotFound) {
				t.Fatalf("Delete() error = %v", err)
			}
			if _, err := w.service.SendNow(ctx, stranger, first.ID); !errors.Is(err, ErrNotFound) {
				t.Fatalf("SendNow() error = %v", err)
			}
			list, err := w.service.List(ctx, stranger, nil)
			if err != nil || len(list) != 0 {
				t.Fatalf("List() = %d error=%v", len(list), err)
			}
		})
	}
	if _, err := w.service.Get(ctx, Author{User: w.author.User}, first.ID); !errors.Is(err, ErrForbidden) {
		t.Fatalf("Get() without session error = %v", err)
	}
	list, err := w.service.List(ctx, w.author, &w.groupID)
	if err != nil || len(list) != 1 || list[0].ID != first.ID {
		t.Fatalf("List() = %#v error=%v", list, err)
	}
	if other, err := w.service.List(ctx, w.author, &w.channelID); err != nil || len(other) != 0 {
		t.Fatalf("List(channel) = %d error=%v", len(other), err)
	}

	// Nothing reaches other people, search or the chat before sending.
	if got := w.count(t, `SELECT count(*) FROM messages WHERE body = 'see you tomorrow'`); got != 0 {
		t.Fatalf("messages before send = %d", got)
	}
	events := w.events(t, first.ID)
	if len(events) != 1 || events[0].Type != "scheduled_message.created" || events[0].Audience == nil || *events[0].Audience != w.author.User.ActorID || events[0].ChatID != nil {
		t.Fatalf("events = %#v", events)
	}
	assertEventShape(t, events[0].Data)
	if got := w.count(t, `SELECT count(*) FROM notification_jobs`); got != 0 {
		t.Fatalf("notification jobs = %d", got)
	}
}

func TestLimits(t *testing.T) {
	w := newWorld(t)
	w.service.SetLimits(Limits{PerAuthor: 3, PerChat: 2})
	w.create(t, w.groupID, w.input("one"))
	w.create(t, w.groupID, w.input("two"))
	if _, _, err := w.service.Create(context.Background(), w.author, w.groupID, w.input("three")); !errors.Is(err, ErrLimitReached) {
		t.Fatalf("per chat limit error = %v", err)
	}
	// Another chat still has room until the per-author limit.
	if _, err := w.pool.Exec(context.Background(), `INSERT INTO chat_members (chat_id, actor_id, org_id, role) VALUES ($1, $2, $3, 'member')`, w.outsideID, w.author.User.ActorID, w.orgID); err != nil {
		t.Fatal(err)
	}
	w.create(t, w.outsideID, w.input("three"))
	if _, _, err := w.service.Create(context.Background(), w.author, w.outsideID, w.input("four")); !errors.Is(err, ErrLimitReached) {
		t.Fatalf("per author limit error = %v", err)
	}
	// Sent and failed records do not count.
	if _, err := w.pool.Exec(context.Background(), `UPDATE scheduled_messages SET status='failed', failure_reason='not_member', failed_at=now() WHERE body='one'`); err != nil {
		t.Fatal(err)
	}
	w.create(t, w.groupID, w.input("again"))
}

func TestDeliverSendsOnceThroughTheOrdinaryPath(t *testing.T) {
	w := newWorld(t)
	ctx := context.Background()
	root, _, err := w.messages.Create(ctx, w.other.User, w.groupID, message.CreateInput{ClientMsgID: uuid.NewString(), Body: "root"})
	if err != nil {
		t.Fatal(err)
	}
	fileID := w.file(t, w.author)
	input := w.input("reply in thread")
	input.ThreadRootID, input.ReplyToID = &root.ID, &root.ID
	input.MentionedActorIDs = []string{w.other.User.ActorID}
	input.FileIDs = []string{fileID}
	item := w.create(t, w.groupID, input)
	if len(item.Files) != 1 || item.Files[0].ID != fileID {
		t.Fatalf("files = %#v", item.Files)
	}

	// Attached files stay private to the uploader until the message goes out.
	store, err := storage.NewLocalBlobStore(t.TempDir(), 0)
	if err != nil {
		t.Fatal(err)
	}
	fileService, err := files.NewService(w.pool, store, "", 16<<20, 8<<20, 4<<20, time.Nanosecond, time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := fileService.Get(ctx, w.other.User, fileID); err == nil {
		t.Fatal("another member read a file of a pending scheduled message")
	}
	loose := w.file(t, w.author)
	// The test files have rows but no objects, so after the unattached
	// cleanup the pass stops on its empty-bucket guard; that is expected.
	if _, err := fileService.Reconcile(ctx); err != nil && !errors.Is(err, files.ErrStorageSuspect) {
		t.Fatal(err)
	}
	if got := w.count(t, `SELECT count(*) FROM files WHERE id=$1 AND status='deleted'`, fileID); got != 0 {
		t.Fatal("the unattached file cleanup removed a file waiting for a scheduled message")
	}
	if got := w.count(t, `SELECT count(*) FROM files WHERE id=$1 AND status='deleted'`, loose); got != 1 {
		t.Fatal("the cleanup did not run")
	}
	if _, err := w.pool.Exec(ctx, `UPDATE files SET status='ready' WHERE id=$1`, fileID); err != nil { // the test blob does not exist
		t.Fatal(err)
	}

	// A job running early for an older time does nothing; the current one snoozes.
	if err := w.service.Deliver(ctx, item.ID, 999); err != nil {
		t.Fatalf("stale job error = %v", err)
	}
	var snooze Snooze
	if err := w.service.Deliver(ctx, item.ID, *w.load(t, item.ID).riverJobID); !errors.As(err, &snooze) {
		t.Fatalf("early job error = %v, want Snooze", err)
	}

	w.makeDue(t, item.ID)
	var wait sync.WaitGroup
	errs := make(chan error, 10)
	jobID := *w.load(t, item.ID).riverJobID
	for range 10 {
		wait.Add(1)
		go func() {
			defer wait.Done()
			errs <- w.service.Deliver(ctx, item.ID, jobID)
		}()
	}
	wait.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatalf("Deliver() error = %v", err)
		}
	}
	w.deliver(t, item) // a retried job is harmless

	if got := w.count(t, `SELECT count(*) FROM messages WHERE client_msg_id=$1`, MessageClientID(item.ID)); got != 1 {
		t.Fatalf("messages sent = %d, want 1", got)
	}
	sent := w.load(t, item.ID)
	if sent.Status != StatusSent || sent.MessageID == nil || sent.SentAt == nil || sent.Body != "" || len(sent.MentionedActorIDs) != 0 {
		t.Fatalf("sent record = %#v", sent)
	}
	var actorID, body string
	var threadRootID, replyToID *string
	var mentioned []string
	if err := w.pool.QueryRow(ctx, `SELECT actor_id, body, thread_root_id, reply_to_id, mentioned_actor_ids FROM messages WHERE id=$1`, *sent.MessageID).
		Scan(&actorID, &body, &threadRootID, &replyToID, &mentioned); err != nil {
		t.Fatal(err)
	}
	if actorID != w.author.User.ActorID || body != "reply in thread" || threadRootID == nil || *threadRootID != root.ID || replyToID == nil || len(mentioned) != 1 {
		t.Fatalf("sent message actor=%s body=%q thread=%v reply=%v mentions=%v", actorID, body, threadRootID, replyToID, mentioned)
	}
	if got := w.count(t, `SELECT count(*) FROM message_files WHERE message_id=$1 AND file_id=$2`, *sent.MessageID, fileID); got != 1 {
		t.Fatal("file was not attached to the sent message")
	}
	if got := w.count(t, `SELECT count(*) FROM scheduled_message_files WHERE scheduled_message_id=$1`, item.ID); got != 0 {
		t.Fatal("sent record still holds its files")
	}
	if _, err := fileService.Get(ctx, w.other.User, fileID); err != nil {
		t.Fatalf("chat member cannot read the sent file: %v", err)
	}
	if got := w.count(t, `SELECT count(*) FROM events WHERE subject_id=$1 AND type='message.created'`, *sent.MessageID); got != 1 {
		t.Fatal("message.created event missing")
	}
	if got := w.count(t, `SELECT count(*) FROM notification_jobs nj JOIN events e ON e.org_id=nj.org_id AND e.seq=nj.event_seq WHERE e.subject_id=$1`, *sent.MessageID); got != 1 {
		t.Fatal("ordinary scheduled message must notify recipients")
	}
	events := w.events(t, item.ID)
	last := events[len(events)-1]
	if last.Type != "scheduled_message.sent" || *last.Audience != w.author.User.ActorID || last.Data["status"] != StatusSent {
		t.Fatalf("sent event = %#v", last)
	}
	assertEventShape(t, last.Data)
	// The text survives neither in the record nor anywhere in the event log.
	if got := w.count(t, `SELECT count(*) FROM scheduled_messages WHERE body LIKE '%reply in thread%'`); got != 0 {
		t.Fatal("text kept in the sent record")
	}
	if got := w.count(t, `SELECT count(*) FROM events WHERE data::text LIKE '%reply in thread%'`); got != 0 {
		t.Fatal("text kept in the event log")
	}
	if got := w.count(t, `SELECT count(*) FROM events WHERE subject_id=$1 AND type='scheduled_message.sent'`, item.ID); got != 1 {
		t.Fatalf("sent events = %d", got)
	}
	// Closed records can no longer change, and the list hides them.
	body = "late edit"
	if _, err := w.service.Update(ctx, w.author, item.ID, UpdateInput{ExpectedVersion: sent.Version, Body: &body}); !errors.Is(err, ErrClosed) {
		t.Fatalf("Update() after send error = %v", err)
	}
	if _, err := w.service.SendNow(ctx, w.author, item.ID); !errors.Is(err, ErrClosed) {
		t.Fatalf("SendNow() after send error = %v", err)
	}
	if list, _ := w.service.List(ctx, w.author, nil); len(list) != 0 {
		t.Fatalf("list after send = %d", len(list))
	}
}

// "Without sound" notifies as usual; the push worker makes it quiet.
func TestSilentStillNotifies(t *testing.T) {
	w := newWorld(t)
	ctx := context.Background()
	input := w.input("quiet")
	input.Silent = true
	item := w.create(t, w.groupID, input)
	w.makeDue(t, item.ID)
	w.deliver(t, item)
	sent := w.load(t, item.ID)
	var silent bool
	if err := w.pool.QueryRow(ctx, `SELECT silent FROM messages WHERE id=$1`, *sent.MessageID).Scan(&silent); err != nil || !silent {
		t.Fatalf("silent=%v error=%v", silent, err)
	}
	if got := w.count(t, `SELECT count(*) FROM notification_jobs nj JOIN events e ON e.org_id=nj.org_id AND e.seq=nj.event_seq WHERE e.subject_id=$1`, *sent.MessageID); got != 1 {
		t.Fatalf("notification jobs = %d, want 1", got)
	}
	direct, _, err := w.messages.Create(ctx, w.author.User, w.groupID, message.CreateInput{ClientMsgID: uuid.NewString(), Body: "shh", Silent: true})
	if err != nil || !direct.Silent {
		t.Fatalf("Create(silent) = %#v error=%v", direct, err)
	}
	// Repeating the command with another silence is a different command.
	if _, _, err := w.messages.Create(ctx, w.author.User, w.groupID, message.CreateInput{ClientMsgID: direct.ClientMsgID, Body: "shh"}); !errors.Is(err, message.ErrIdempotencyConflict) {
		t.Fatalf("Create() with changed silence error = %v", err)
	}
}

// assertEventShape: scheduled_message.* events carry no content.
func assertEventShape(t *testing.T, data map[string]any) {
	t.Helper()
	allowed := map[string]bool{"id": true, "chat_id": true, "status": true, "version": true, "send_at": true, "failure_reason": true}
	for key := range data {
		if !allowed[key] {
			t.Fatalf("event carries %q: %v", key, data)
		}
	}
	if len(data) != len(allowed) {
		t.Fatalf("event fields = %v", data)
	}
}

func TestRescheduleEditAndCancel(t *testing.T) {
	w := newWorld(t)
	ctx := context.Background()
	item := w.create(t, w.groupID, w.input("draft"))
	oldJob := *w.load(t, item.ID).riverJobID

	later := time.Now().Add(48 * time.Hour).UTC().Truncate(time.Second)
	body := "final text"
	updated, err := w.service.Update(ctx, w.author, item.ID, UpdateInput{ExpectedVersion: 1, Body: &body, SendAt: &later})
	if err != nil {
		t.Fatal(err)
	}
	if updated.Version != 2 || updated.Body != body || !updated.SendAt.Equal(later) {
		t.Fatalf("updated = %#v", updated)
	}
	newJob := *w.load(t, item.ID).riverJobID
	if newJob == oldJob || !w.scheduler.wasCancelled(oldJob) || !w.scheduler.scheduled[newJob].Equal(later) {
		t.Fatalf("reschedule old=%d new=%d cancelled=%v", oldJob, newJob, w.scheduler.cancelled)
	}
	if _, err := w.service.Update(ctx, w.author, item.ID, UpdateInput{ExpectedVersion: 1, Body: &body}); !errors.Is(err, ErrVersionConflict) {
		t.Fatalf("stale Update() error = %v", err)
	}
	if got := w.count(t, `SELECT count(*) FROM events WHERE data::text LIKE '%final text%' OR data::text LIKE '%draft%'`); got != 0 {
		t.Fatal("text in the event log")
	}
	past := time.Now().Add(-time.Minute)
	if _, err := w.service.Update(ctx, w.author, item.ID, UpdateInput{ExpectedVersion: 2, SendAt: &past}); !errors.Is(err, ErrInvalid) {
		t.Fatalf("Update(past) error = %v", err)
	}
	tooBig := strings.Repeat("y", 2000)
	if _, err := w.service.Update(ctx, w.author, item.ID, UpdateInput{ExpectedVersion: 2, Body: &tooBig}); !errors.Is(err, ErrTooLarge) {
		t.Fatalf("Update(large) error = %v", err)
	}
	// Changing only the text keeps the job.
	text := "final text!"
	if _, err := w.service.Update(ctx, w.author, item.ID, UpdateInput{ExpectedVersion: 2, Body: &text}); err != nil {
		t.Fatal(err)
	}
	if *w.load(t, item.ID).riverJobID != newJob {
		t.Fatal("text edit moved the job")
	}
	// The old job firing at the old time does nothing.
	if err := w.service.Deliver(ctx, item.ID, oldJob); err != nil {
		t.Fatal(err)
	}
	if w.load(t, item.ID).Status != StatusPending {
		t.Fatal("old job sent a rescheduled message")
	}
	// Editing rights are checked as of now.
	if _, err := w.pool.Exec(ctx, `DELETE FROM chat_members WHERE chat_id=$1 AND actor_id=$2`, w.groupID, w.author.User.ActorID); err != nil {
		t.Fatal(err)
	}
	if _, err := w.service.Update(ctx, w.author, item.ID, UpdateInput{ExpectedVersion: 3, Body: &body}); !errors.Is(err, ErrNotFound) {
		t.Fatalf("Update() after leaving error = %v", err)
	}
	// Deleting needs no chat rights and cancels the job.
	if err := w.service.Delete(ctx, w.author, item.ID); err != nil {
		t.Fatal(err)
	}
	if !w.scheduler.wasCancelled(newJob) {
		t.Fatal("delete did not cancel the job")
	}
	if err := w.service.Deliver(ctx, item.ID, newJob); err != nil {
		t.Fatal(err)
	}
	if got := w.count(t, `SELECT count(*) FROM messages WHERE client_msg_id=$1`, MessageClientID(item.ID)); got != 0 {
		t.Fatal("a deleted scheduled message was sent")
	}
	events := w.events(t, item.ID)
	if events[len(events)-1].Type != "scheduled_message.deleted" || events[len(events)-1].Data["status"] != "deleted" {
		t.Fatalf("events = %#v", events)
	}
	assertEventShape(t, events[len(events)-1].Data)
	if got := w.count(t, `SELECT count(*) FROM events WHERE data::text LIKE '%final text%'`); got != 0 {
		t.Fatal("deleted text kept in the event log")
	}
	if err := w.service.Delete(ctx, w.author, item.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("second Delete() error = %v", err)
	}
}

func TestSendNow(t *testing.T) {
	w := newWorld(t)
	ctx := context.Background()
	item := w.create(t, w.groupID, w.input("right away"))
	job := *w.load(t, item.ID).riverJobID
	result, err := w.service.SendNow(ctx, w.author, item.ID)
	if err != nil {
		t.Fatal(err)
	}
	if result.Status != StatusSent || result.MessageID == nil {
		t.Fatalf("SendNow() = %#v", result)
	}
	if !w.scheduler.wasCancelled(job) {
		t.Fatal("send now left the job behind")
	}
	// A failure at send time is reported in the record, not as an error.
	second := w.create(t, w.groupID, w.input("will fail"))
	if _, err := w.pool.Exec(ctx, `UPDATE chats SET archived_at=now() WHERE id=$1`, w.groupID); err != nil {
		t.Fatal(err)
	}
	failed, err := w.service.SendNow(ctx, w.author, second.ID)
	if err != nil || failed.Status != StatusFailed || failed.FailureReason == nil || *failed.FailureReason != ReasonChatUnavailable {
		t.Fatalf("SendNow() = %#v error=%v", failed, err)
	}
}

func TestSendTimeChecks(t *testing.T) {
	cases := []struct {
		name   string
		setup  func(t *testing.T, w *world, item ScheduledMessage)
		input  func(t *testing.T, w *world, in *CreateInput)
		chat   func(w *world) string
		reason string
	}{
		{name: "author deactivated", reason: ReasonAuthorInactive, setup: func(t *testing.T, w *world, _ ScheduledMessage) {
			w.exec(t, `UPDATE actors SET status='deactivated' WHERE id=$1`, w.author.User.ActorID)
		}},
		{name: "password change required", reason: ReasonSecurityReset, setup: func(t *testing.T, w *world, _ ScheduledMessage) {
			w.exec(t, `UPDATE users SET must_change_password_at=now() WHERE actor_id=$1`, w.author.User.ActorID)
		}},
		{name: "security epoch moved on", reason: ReasonSecurityReset, setup: func(t *testing.T, w *world, _ ScheduledMessage) {
			w.exec(t, `UPDATE users SET security_epoch=security_epoch+1 WHERE actor_id=$1`, w.author.User.ActorID)
		}},
		{name: "chat archived", reason: ReasonChatUnavailable, setup: func(t *testing.T, w *world, _ ScheduledMessage) {
			w.exec(t, `UPDATE chats SET archived_at=now() WHERE id=$1`, w.groupID)
		}},
		{name: "author left", reason: ReasonNotMember, setup: func(t *testing.T, w *world, _ ScheduledMessage) {
			w.exec(t, `DELETE FROM chat_members WHERE chat_id=$1 AND actor_id=$2`, w.groupID, w.author.User.ActorID)
		}},
		{name: "lost the right to write", reason: ReasonForbidden,
			chat: func(w *world) string { return w.channelID },
			input: func(t *testing.T, w *world, _ *CreateInput) {
				w.exec(t, `UPDATE chat_members SET role='admin' WHERE chat_id=$1 AND actor_id=$2`, w.channelID, w.author.User.ActorID)
			},
			setup: func(t *testing.T, w *world, _ ScheduledMessage) {
				w.exec(t, `UPDATE chat_members SET role='member' WHERE chat_id=$1 AND actor_id=$2`, w.channelID, w.author.User.ActorID)
			}},
		{name: "reply target deleted", reason: ReasonReferenceUnavailable,
			input: func(t *testing.T, w *world, in *CreateInput) {
				target, _, err := w.messages.Create(context.Background(), w.other.User, w.groupID, message.CreateInput{ClientMsgID: uuid.NewString(), Body: "target"})
				if err != nil {
					t.Fatal(err)
				}
				in.ReplyToID = &target.ID
			},
			setup: func(t *testing.T, w *world, item ScheduledMessage) {
				w.exec(t, `UPDATE messages SET deleted_at=now() WHERE id=$1`, *item.ReplyToID)
			}},
		{name: "mentioned member left", reason: ReasonReferenceUnavailable,
			input: func(t *testing.T, w *world, in *CreateInput) { in.MentionedActorIDs = []string{w.other.User.ActorID} },
			setup: func(t *testing.T, w *world, _ ScheduledMessage) {
				w.exec(t, `DELETE FROM chat_members WHERE chat_id=$1 AND actor_id=$2`, w.groupID, w.other.User.ActorID)
			}},
		{name: "attachment deleted", reason: ReasonAttachmentUnavailable,
			input: func(t *testing.T, w *world, in *CreateInput) { in.FileIDs = []string{w.file(t, w.author)} },
			setup: func(t *testing.T, w *world, item ScheduledMessage) {
				w.exec(t, `UPDATE files SET status='deleted', deleted_at=now() WHERE id=$1`, item.Files[0].ID)
			}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			w := newWorld(t)
			chatID := w.groupID
			if tc.chat != nil {
				chatID = tc.chat(w)
			}
			input := w.input("must not go out")
			if tc.input != nil {
				tc.input(t, w, &input)
			}
			item := w.create(t, chatID, input)
			tc.setup(t, w, item)
			w.makeDue(t, item.ID)
			w.deliver(t, item)
			if got := w.count(t, `SELECT count(*) FROM messages WHERE client_msg_id=$1`, MessageClientID(item.ID)); got != 0 {
				t.Fatal("message was sent despite the refusal")
			}
			failed := w.load(t, item.ID)
			if failed.Status != StatusFailed || failed.FailureReason == nil || *failed.FailureReason != tc.reason || failed.Body != "must not go out" {
				t.Fatalf("record = status %s reason %v body %q, want %s", failed.Status, failed.FailureReason, failed.Body, tc.reason)
			}
			events := w.events(t, item.ID)
			last := events[len(events)-1]
			if last.Type != "scheduled_message.failed" || last.Audience == nil || *last.Audience != w.author.User.ActorID || last.ChatID != nil || last.Data["failure_reason"] != tc.reason {
				t.Fatalf("failure event = %#v", last)
			}
			assertEventShape(t, last.Data)
			// Repeating the job does not resend or re-fail.
			w.deliver(t, item)
			if got := w.count(t, `SELECT count(*) FROM events WHERE subject_id=$1 AND type='scheduled_message.failed'`, item.ID); got != 1 {
				t.Fatalf("failure events = %d", got)
			}
		})
	}

	t.Run("refreshing the session keeps the message", func(t *testing.T) {
		w := newWorld(t)
		item := w.create(t, w.groupID, w.input("still mine"))
		rotated := uuid.NewString()
		w.exec(t, `INSERT INTO sessions (id, org_id, actor_id, family_id, refresh_hash, expires_at) VALUES ($1, $2, $3, $4, sha256(convert_to(gen_random_uuid()::text, 'UTF8')), now() + interval '1 day')`,
			rotated, w.orgID, w.author.User.ActorID, w.author.SessionID)
		w.exec(t, `UPDATE sessions SET revoked_at=now(), replaced_by=$2 WHERE id=$1`, w.author.SessionID, rotated)
		w.makeDue(t, item.ID)
		w.deliver(t, item)
		if status := w.load(t, item.ID).Status; status != StatusSent {
			t.Fatalf("status = %s", status)
		}
	})
	t.Run("repeated internal errors fail the record", func(t *testing.T) {
		w := newWorld(t)
		item := w.create(t, w.groupID, w.input("unlucky"))
		if err := w.service.MarkDeliveryFailed(context.Background(), item.ID, 0); err != nil {
			t.Fatal(err)
		}
		if reason := w.load(t, item.ID).FailureReason; reason == nil || *reason != ReasonDeliveryError {
			t.Fatalf("reason = %v", reason)
		}
	})
}

func TestDeletionCascades(t *testing.T) {
	w := newWorld(t)
	ctx := context.Background()

	// A chat that is removed for good takes its scheduled messages along.
	chatID := uuid.NewString()
	w.exec(t, `WITH chat AS (
			INSERT INTO chats (id, org_id, kind, visibility, name, created_by) VALUES ($1, $2, 'group', 'private', 'temp', $3) RETURNING id
		) INSERT INTO chat_members (chat_id, actor_id, org_id, role)
		SELECT id, $3, $2, 'owner' FROM chat UNION ALL SELECT id, $4, $2, 'member' FROM chat`, chatID, w.orgID, w.owner.User.ActorID, w.author.User.ActorID)
	inChat := w.create(t, chatID, w.input("doomed"))
	w.exec(t, `DELETE FROM chats WHERE id=$1`, chatID)
	if got := w.count(t, `SELECT count(*) FROM scheduled_messages WHERE id=$1`, inChat.ID); got != 0 {
		t.Fatal("scheduled message outlived its chat")
	}
	if err := w.service.Deliver(ctx, inChat.ID, 1); err != nil {
		t.Fatalf("Deliver() after chat deletion error = %v", err)
	}

	// A person who is removed for good takes theirs along, files links included.
	fileID := w.file(t, w.other)
	input := w.input("bye")
	input.FileIDs = []string{fileID}
	byOther, _, err := w.service.Create(ctx, w.other, w.groupID, input)
	if err != nil {
		t.Fatal(err)
	}
	w.exec(t, `INSERT INTO revoked_session_families (family_id, org_id, actor_id, reason) VALUES ($1, $2, $3, 'device_revoked')`, w.other.SessionID, w.orgID, w.other.User.ActorID)
	w.exec(t, `DELETE FROM chat_members WHERE actor_id=$1`, w.other.User.ActorID)
	w.exec(t, `DELETE FROM events WHERE actor_id=$1 OR audience_actor_id=$1`, w.other.User.ActorID)
	w.exec(t, `DELETE FROM users WHERE actor_id=$1`, w.other.User.ActorID)
	w.exec(t, `DELETE FROM files WHERE uploader_id=$1`, w.other.User.ActorID)
	w.exec(t, `DELETE FROM actors WHERE id=$1`, w.other.User.ActorID)
	if got := w.count(t, `SELECT count(*) FROM scheduled_messages WHERE id=$1`, byOther.ID); got != 0 {
		t.Fatal("scheduled message outlived its author")
	}
	if got := w.count(t, `SELECT count(*) FROM scheduled_message_files WHERE scheduled_message_id=$1`, byOther.ID); got != 0 {
		t.Fatal("file links outlived the record")
	}
	if got := w.count(t, `SELECT count(*) FROM revoked_session_families WHERE actor_id=$1`, w.other.User.ActorID); got != 0 {
		t.Fatal("revoked family marks outlived the person")
	}
}

func TestCleanupRemovesFinishedRecords(t *testing.T) {
	w := newWorld(t)
	pending := w.create(t, w.groupID, w.input("pending"))
	sent := w.create(t, w.groupID, w.input("sent"))
	w.makeDue(t, sent.ID)
	w.deliver(t, sent)
	failed := w.create(t, w.groupID, w.input("failed"))
	if err := w.service.MarkDeliveryFailed(context.Background(), failed.ID, 0); err != nil {
		t.Fatal(err)
	}
	w.exec(t, `UPDATE scheduled_messages SET updated_at = now() - interval '8 days'`)
	if removed, err := w.service.Cleanup(context.Background()); err != nil || removed != 1 {
		t.Fatalf("Cleanup() = %d error=%v", removed, err)
	}
	w.exec(t, `UPDATE scheduled_messages SET updated_at = now() - interval '31 days'`)
	if removed, err := w.service.Cleanup(context.Background()); err != nil || removed != 1 {
		t.Fatalf("Cleanup() = %d error=%v", removed, err)
	}
	if got := w.count(t, `SELECT count(*) FROM scheduled_messages WHERE id=$1`, pending.ID); got != 1 {
		t.Fatal("cleanup removed a pending message")
	}
}

func (w *world) exec(t *testing.T, query string, args ...any) {
	t.Helper()
	if _, err := w.pool.Exec(context.Background(), query, args...); err != nil {
		t.Fatalf("%s: %v", query, err)
	}
}
