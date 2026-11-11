package push

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"io"
	"log/slog"
	"strings"
	"testing"
	"time"

	"github.com/comamessenger/comamessenger/core/internal/config"
	"github.com/comamessenger/comamessenger/core/internal/identity"
	"github.com/comamessenger/comamessenger/core/internal/message"
	"github.com/comamessenger/comamessenger/core/internal/scheduled"
	"github.com/comamessenger/comamessenger/core/internal/scheduledreset"
	"github.com/comamessenger/comamessenger/core/internal/testdb"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

type failurePushWorld struct {
	pool                 *pgxpool.Pool
	orgID, chatID        string
	author, other        scheduled.Author
	authorKey, otherKey  []byte
	service              *scheduled.Service
	worker               *Worker
	relay                *recordingRelay
	authorSub, otherSub  string
	authorDev, otherDev  string
	secretBody, chatName string
}

func newFailurePushWorld(t *testing.T) *failurePushWorld {
	t.Helper()
	pool := testdb.New(t)
	ctx := context.Background()
	w := &failurePushWorld{
		pool: pool, orgID: uuid.NewString(), chatID: uuid.NewString(),
		author:    scheduled.Author{User: identity.User{ActorID: uuid.NewString(), OrgRole: "member", Status: "active"}, SessionID: uuid.NewString()},
		other:     scheduled.Author{User: identity.User{ActorID: uuid.NewString(), OrgRole: "owner", Status: "active"}, SessionID: uuid.NewString()},
		authorKey: []byte(strings.Repeat("a", 32)), otherKey: []byte(strings.Repeat("o", 32)),
		authorSub: uuid.NewString(), otherSub: uuid.NewString(),
		secretBody: "the secret plan", chatName: "Mergers and acquisitions",
	}
	w.author.User.OrgID, w.other.User.OrgID = w.orgID, w.orgID
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	for _, statement := range []struct {
		query string
		args  []any
	}{
		{`INSERT INTO organizations(id,name,slug) VALUES($1,'Failure push','failure-push')`, []any{w.orgID}},
		{`INSERT INTO actors(id,org_id,type,org_role,display_name,handle,timezone) VALUES ($2,$1,'user','member','Author','author','UTC'),($3,$1,'user','owner','Other','other','UTC')`, []any{w.orgID, w.author.User.ActorID, w.other.User.ActorID}},
		{`INSERT INTO users(actor_id,org_id,email,password_hash,preferences) VALUES ($2,$1,'author@example.test','hash','{"push_preview":true}'),($3,$1,'other@example.test','hash','{"push_preview":true}')`, []any{w.orgID, w.author.User.ActorID, w.other.User.ActorID}},
		{`INSERT INTO sessions(id,org_id,actor_id,family_id,refresh_hash,expires_at) VALUES($3,$1,$2,$3,decode(repeat('01',32),'hex'),now()+interval '1 day'),($5,$1,$4,$5,decode(repeat('02',32),'hex'),now()+interval '1 day')`, []any{w.orgID, w.author.User.ActorID, w.author.SessionID, w.other.User.ActorID, w.other.SessionID}},
		{`INSERT INTO chats(id,org_id,kind,visibility,name,created_by) VALUES($3,$1,'group','private',$4,$2)`, []any{w.orgID, w.other.User.ActorID, w.chatID, w.chatName}},
		{`INSERT INTO chat_members(chat_id,actor_id,org_id,role) VALUES ($3,$2,$1,'owner'),($3,$4,$1,'member')`, []any{w.orgID, w.other.User.ActorID, w.chatID, w.author.User.ActorID}},
		{`INSERT INTO web_push_subscriptions(id,org_id,actor_id,session_id,endpoint,p256dh,auth) VALUES($4,$1,$2,$3,'https://push.example.test/a','0123456789abcdef','0123456789abcdef'),($7,$1,$5,$6,'https://push.example.test/o','0123456789abcdef','0123456789abcdef')`,
			[]any{w.orgID, w.author.User.ActorID, w.author.SessionID, w.authorSub, w.other.User.ActorID, w.other.SessionID, w.otherSub}},
	} {
		if _, err := tx.Exec(ctx, statement.query, statement.args...); err != nil {
			_ = tx.Rollback(ctx)
			t.Fatal(err)
		}
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	cfg := config.PushConfig{RelayURL: "https://relay.example.test", PollInterval: time.Second}
	register := func(person scheduled.Author, key []byte, handle string) string {
		device, err := NewService(pool, cfg).RegisterMobileDevice(ctx, person.User, person.SessionID, MobileDeviceInput{
			Platform: "ios", RelayHandle: strings.Repeat(handle, 43), NotificationKey: base64.StdEncoding.EncodeToString(key), AppVersion: "0.1.0",
		})
		if err != nil {
			t.Fatal(err)
		}
		return device.ID
	}
	w.authorDev, w.otherDev = register(w.author, w.authorKey, "a"), register(w.other, w.otherKey, "o")
	w.service = scheduled.NewService(pool, message.NewService(pool, 1024, 100, nil), nil, slog.New(slog.NewTextHandler(io.Discard, nil)))
	w.relay = &recordingRelay{}
	w.worker = NewWorker(slog.New(slog.NewTextHandler(io.Discard, nil)), pool, cfg, nil).WithRelay(w.relay)
	return w
}

func (w *failurePushWorld) count(t *testing.T, query string, args ...any) int {
	t.Helper()
	var value int
	if err := w.pool.QueryRow(context.Background(), query, args...).Scan(&value); err != nil {
		t.Fatal(err)
	}
	return value
}

func (w *failurePushWorld) exec(t *testing.T, query string, args ...any) {
	t.Helper()
	if _, err := w.pool.Exec(context.Background(), query, args...); err != nil {
		t.Fatal(err)
	}
}

func (w *failurePushWorld) schedule(t *testing.T) scheduled.ScheduledMessage {
	t.Helper()
	item, _, err := w.service.Create(context.Background(), w.author, w.chatID, scheduled.CreateInput{
		ClientMsgID: uuid.NewString(), Body: w.secretBody, BodyFormat: "plain", SendAt: time.Now().Add(time.Hour),
	})
	if err != nil {
		t.Fatal(err)
	}
	return item
}

func (w *failurePushWorld) fail(t *testing.T, item scheduled.ScheduledMessage) {
	t.Helper()
	if err := w.service.MarkDeliveryFailed(context.Background(), item.ID, 0); err != nil {
		t.Fatal(err)
	}
}

func (w *failurePushWorld) materialize(t *testing.T) {
	t.Helper()
	if err := w.worker.materialize(context.Background()); err != nil {
		t.Fatal(err)
	}
}

func (w *failurePushWorld) deliveries(t *testing.T, seq int64) (web, mobile []string) {
	t.Helper()
	rows, err := w.pool.Query(context.Background(), `SELECT subscription_id::text FROM notification_deliveries WHERE event_seq=$1 ORDER BY 1`, seq)
	if err != nil {
		t.Fatal(err)
	}
	for rows.Next() {
		var value string
		_ = rows.Scan(&value)
		web = append(web, value)
	}
	rows.Close()
	rows, err = w.pool.Query(context.Background(), `SELECT device_id::text FROM mobile_push_deliveries WHERE event_seq=$1 ORDER BY 1`, seq)
	if err != nil {
		t.Fatal(err)
	}
	for rows.Next() {
		var value string
		_ = rows.Scan(&value)
		mobile = append(mobile, value)
	}
	rows.Close()
	return web, mobile
}

func (w *failurePushWorld) failureSeq(t *testing.T, item scheduled.ScheduledMessage) int64 {
	t.Helper()
	var seq int64
	if err := w.pool.QueryRow(context.Background(), `SELECT max(seq) FROM events WHERE subject_id=$1 AND type='scheduled_message.failed'`, item.ID).Scan(&seq); err != nil {
		t.Fatal(err)
	}
	return seq
}

func (w *failurePushWorld) assertNoSecrets(t *testing.T, values ...string) {
	t.Helper()
	for _, value := range values {
		for _, secret := range []string{w.secretBody, w.chatName, w.chatID} {
			if strings.Contains(value, secret) {
				t.Fatalf("push carries %q: %s", secret, value)
			}
		}
	}
}

func TestScheduledFailureNotifiesOnlyTheAuthor(t *testing.T) {
	w := newFailurePushWorld(t)
	ctx := context.Background()
	item := w.schedule(t)
	w.fail(t, item)
	seq := w.failureSeq(t, item)
	if got := w.count(t, `SELECT count(*) FROM notification_jobs WHERE event_seq=$1`, seq); got != 1 {
		t.Fatalf("jobs = %d", got)
	}
	// The record cannot fail a second time.
	w.fail(t, item)
	if got := w.count(t, `SELECT count(*) FROM events WHERE subject_id=$1 AND type='scheduled_message.failed'`, item.ID); got != 1 {
		t.Fatalf("failure events = %d", got)
	}
	// The author muted the chat: the failure still reaches them. E-mail
	// digests never carry it.
	w.exec(t, `UPDATE chat_members SET notify_level='none', muted_until=now()+interval '1 day' WHERE actor_id=$1`, w.author.User.ActorID)
	w.exec(t, `UPDATE users SET preferences=preferences||'{"email_digest":true}' WHERE actor_id=$1`, w.author.User.ActorID)
	w.materialize(t)
	web, mobile := w.deliveries(t, seq)
	if len(web) != 1 || web[0] != w.authorSub || len(mobile) != 1 || mobile[0] != w.authorDev {
		t.Fatalf("deliveries web=%v mobile=%v, want only the author's", web, mobile)
	}
	if got := w.count(t, `SELECT count(*) FROM email_digest_items`); got != 0 {
		t.Fatalf("digest items = %d", got)
	}
	// Materializing again adds nothing.
	w.exec(t, `INSERT INTO notification_jobs(org_id,event_seq) VALUES($1,$2)`, w.orgID, seq)
	w.materialize(t)
	if web, mobile := w.deliveries(t, seq); len(web) != 1 || len(mobile) != 1 {
		t.Fatalf("second materialize: web=%v mobile=%v", web, mobile)
	}

	if err := w.worker.deliverMobile(ctx); err != nil {
		t.Fatal(err)
	}
	if len(w.relay.messages) != 1 {
		t.Fatalf("relay messages = %d", len(w.relay.messages))
	}
	sent := w.relay.messages[0]
	payload := openPayload(t, w.authorKey, sent.Ciphertext)
	if payload.Title != "Сообщение не отправлено" || payload.Body != ScheduledFailureText(scheduled.ReasonDeliveryError, "ru") ||
		payload.URL != "/scheduled" || payload.ChatID != "" || payload.Silent || payload.Tag != scheduledFailedTag || sent.CollapseID != scheduledFailedTag {
		t.Fatalf("payload = %+v, relay = %+v", payload, sent)
	}
	plain, _ := json.Marshal(payload)
	w.assertNoSecrets(t, string(plain), sent.FallbackTitle, sent.FallbackBody)
}

// With push_preview on or off, in either language, the push carries the
// reason and nothing of the message or the chat.
func TestScheduledFailureNeverShowsTheText(t *testing.T) {
	w := newFailurePushWorld(t)
	data, _ := json.Marshal(scheduledreset.Event{FailureReason: ptr(scheduled.ReasonNotMember)})
	body, chatName, chatID, threadID := w.secretBody, w.chatName, w.chatID, uuid.NewString()
	for _, locale := range []string{"ru", "en"} {
		for _, preview := range []bool{true, false} {
			content := buildNotification(scheduledreset.EventFailed, data, "Author", locale, preview, &chatID, &threadID, &body, &chatName)
			encoded := webPushPayload(content, false)
			w.assertNoSecrets(t, string(encoded))
			var payload map[string]any
			_ = json.Unmarshal(encoded, &payload)
			if payload["tag"] != scheduledFailedTag || payload["url"] != "/scheduled" || payload["body"] != ScheduledFailureText(scheduled.ReasonNotMember, locale) {
				t.Fatalf("%s preview=%v: payload %v", locale, preview, payload)
			}
		}
	}
	if ScheduledFailureText("something new", "en") != "Unknown reason" {
		t.Fatal("unknown reasons need a fallback")
	}
	for _, reason := range []string{
		scheduled.ReasonAuthorInactive, scheduled.ReasonSecurityReset, scheduled.ReasonSessionRevoked, scheduled.ReasonMissedSendTime,
		scheduled.ReasonChatUnavailable, scheduled.ReasonNotMember, scheduled.ReasonForbidden, scheduled.ReasonReferenceUnavailable,
		scheduled.ReasonAttachmentUnavailable, scheduled.ReasonInvalidContent, scheduled.ReasonDeliveryError,
	} {
		if _, ok := scheduledFailureTexts[reason]; !ok {
			t.Errorf("no text for %s", reason)
		}
	}
}

func ptr[T any](value T) *T { return &value }

func TestScheduledFailurePushFollowsTheRecord(t *testing.T) {
	w := newFailurePushWorld(t)
	ctx := context.Background()

	// Deleted before the push went out: nothing is sent.
	deleted := w.schedule(t)
	w.fail(t, deleted)
	w.materialize(t)
	if err := w.service.Delete(ctx, w.author, deleted.ID); err != nil {
		t.Fatal(err)
	}
	// Sent again before the push went out: the failure is old news.
	retried := w.schedule(t)
	w.fail(t, retried)
	w.materialize(t)
	if _, err := w.service.SendNow(ctx, w.author, retried.ID); err != nil {
		t.Fatal(err)
	}
	if err := w.worker.deliverMobile(ctx); err != nil {
		t.Fatal(err)
	}
	if len(w.relay.messages) != 0 {
		t.Fatalf("relay messages = %d, want none", len(w.relay.messages))
	}
	if got := w.count(t, `SELECT count(*) FROM mobile_push_deliveries WHERE last_error='scheduled_closed' AND sent_at IS NOT NULL`); got != 2 {
		t.Fatalf("skipped deliveries = %d", got)
	}
	// Deleted before the job was even materialized: no delivery at all.
	early := w.schedule(t)
	w.fail(t, early)
	if err := w.service.Delete(ctx, w.author, early.ID); err != nil {
		t.Fatal(err)
	}
	w.materialize(t)
	if web, mobile := w.deliveries(t, w.failureSeq(t, early)); len(web)+len(mobile) != 0 {
		t.Fatalf("deliveries for a deleted record: %v %v", web, mobile)
	}

	// The author's own rules: push off, a pause, quiet hours.
	for name, setup := range map[string]string{
		"push off":    `UPDATE users SET preferences=preferences||'{"push_enabled":false}' WHERE actor_id=$1`,
		"pause":       `INSERT INTO notification_snoozes(org_id,actor_id,starts_at,ends_at) SELECT org_id,id,now()-interval '1 hour',now()+interval '1 hour' FROM actors WHERE id=$1`,
		"quiet hours": `UPDATE users SET preferences=preferences||jsonb_build_object('schedule',jsonb_build_object('from',to_char(now() AT TIME ZONE 'UTC' + interval '1 hour','HH24:MI'),'to',to_char(now() AT TIME ZONE 'UTC' + interval '2 hours','HH24:MI'),'days','all')) WHERE actor_id=$1`,
	} {
		w.exec(t, setup, w.author.User.ActorID)
		item := w.schedule(t)
		w.fail(t, item)
		w.materialize(t)
		if web, mobile := w.deliveries(t, w.failureSeq(t, item)); len(web)+len(mobile) != 0 {
			t.Fatalf("%s: deliveries %v %v", name, web, mobile)
		}
		w.exec(t, `UPDATE users SET preferences='{}' WHERE actor_id=$1`, w.author.User.ActorID)
		w.exec(t, `DELETE FROM notification_snoozes WHERE actor_id=$1`, w.author.User.ActorID)
	}
}

// A security event stops many messages at once: each one fails with its
// own event, and the author gets one push for the whole stop, in the same
// transaction as the failures.
func TestScheduledFailurePushOnMassStop(t *testing.T) {
	w := newFailurePushWorld(t)
	ctx := context.Background()
	stop := func(count int) []scheduled.ScheduledMessage {
		t.Helper()
		var items []scheduled.ScheduledMessage
		for range count {
			items = append(items, w.schedule(t))
		}
		tx, err := w.pool.Begin(ctx)
		if err != nil {
			t.Fatal(err)
		}
		if err := scheduledreset.BumpEpochTx(ctx, tx, w.orgID, w.author.User.ActorID); err != nil {
			t.Fatal(err)
		}
		if err := tx.Commit(ctx); err != nil {
			t.Fatal(err)
		}
		if _, err := scheduledreset.Reconcile(ctx, w.pool, w.orgID, w.author.User.ActorID); err != nil {
			t.Fatal(err)
		}
		// A second pass finds nothing left to stop.
		if seq, err := scheduledreset.Reconcile(ctx, w.pool, w.orgID, w.author.User.ActorID); err != nil || seq != 0 {
			t.Fatalf("second reconcile = %d, %v", seq, err)
		}
		return items
	}

	items := stop(3)
	if got := w.count(t, `SELECT count(*) FROM events WHERE type='scheduled_message.failed'`); got != 3 {
		t.Fatalf("failure events = %d", got)
	}
	if got := w.count(t, `SELECT count(*) FROM notification_jobs`); got != 1 {
		t.Fatalf("push jobs = %d, want one for the stop", got)
	}
	w.materialize(t)
	if got := w.count(t, `SELECT count(*) FROM notification_deliveries WHERE subscription_id=$1`, w.authorSub); got != 1 {
		t.Fatalf("web deliveries = %d", got)
	}
	if got := w.count(t, `SELECT count(*) FROM notification_deliveries WHERE subscription_id=$1`, w.otherSub); got != 0 {
		t.Fatalf("someone else was told: %d", got)
	}
	// The author deleted one of them meanwhile: the others still failed.
	if err := w.service.Delete(ctx, w.author, items[2].ID); err != nil {
		t.Fatal(err)
	}
	if err := w.worker.deliverMobile(ctx); err != nil {
		t.Fatal(err)
	}
	if len(w.relay.messages) != 1 {
		t.Fatalf("relay messages = %d, want 1", len(w.relay.messages))
	}
	sent := w.relay.messages[0]
	payload := openPayload(t, w.authorKey, sent.Ciphertext)
	if payload.Title != "3 сообщения не отправлены" || payload.Body != ScheduledFailureText(scheduled.ReasonSecurityReset, "ru") ||
		payload.URL != "/scheduled" || sent.CollapseID != scheduledFailedTag {
		t.Fatalf("payload = %+v", payload)
	}
	plain, _ := json.Marshal(payload)
	w.assertNoSecrets(t, string(plain))

	// Every stopped message deleted before the push went out: nothing goes.
	w.relay.messages = nil
	for _, item := range stop(2) {
		if err := w.service.Delete(ctx, w.author, item.ID); err != nil {
			t.Fatal(err)
		}
	}
	w.materialize(t)
	if err := w.worker.deliverMobile(ctx); err != nil {
		t.Fatal(err)
	}
	if len(w.relay.messages) != 0 {
		t.Fatalf("pushed a stop whose messages are all gone: %d", len(w.relay.messages))
	}

	// One message stopped alone is told as a single failure.
	stop(1)
	w.materialize(t)
	if err := w.worker.deliverMobile(ctx); err != nil {
		t.Fatal(err)
	}
	if len(w.relay.messages) != 1 || openPayload(t, w.authorKey, w.relay.messages[0].Ciphertext).Title != "Сообщение не отправлено" {
		t.Fatalf("single stop = %+v", w.relay.messages)
	}
}

func TestStoppedTitlePlural(t *testing.T) {
	for count, want := range map[int]string{
		2: "2 сообщения не отправлены", 5: "5 сообщений не отправлено", 11: "11 сообщений не отправлено",
		21: "21 сообщение не отправлено", 22: "22 сообщения не отправлены", 112: "112 сообщений не отправлено",
	} {
		if got := stoppedTitle(count, "ru"); got != want {
			t.Errorf("%d: %q, want %q", count, got, want)
		}
	}
	if got := stoppedTitle(3, "en"); got != "3 messages not sent" {
		t.Errorf("en: %q", got)
	}
}
