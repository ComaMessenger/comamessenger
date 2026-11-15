package push

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"strings"
	"testing"
	"time"

	"github.com/comamessenger/comamessenger/core/internal/message"
	"github.com/comamessenger/comamessenger/core/internal/reminder"
	"github.com/google/uuid"
)

// reminderPushWorld reuses the failure push world: the author (member of
// the chat) sets reminders on a message of the other (chat owner).
type reminderPushWorld struct {
	*failurePushWorld
	messages  *message.Service
	reminders *reminder.Service
	target    message.Message
}

func newReminderPushWorld(t *testing.T) *reminderPushWorld {
	t.Helper()
	base := newFailurePushWorld(t)
	w := &reminderPushWorld{
		failurePushWorld: base,
		messages:         message.NewService(base.pool, 1024, 100, nil),
		reminders:        reminder.NewService(base.pool, nil, slog.New(slog.NewTextHandler(io.Discard, nil))),
	}
	target, _, err := w.messages.Create(context.Background(), base.other.User, base.chatID, message.CreateInput{
		ClientMsgID: uuid.NewString(), Body: base.secretBody, BodyFormat: "plain",
	})
	if err != nil {
		t.Fatal(err)
	}
	w.target = target
	// The message itself was pushed to the author; this test is about reminders.
	w.exec(t, `DELETE FROM notification_jobs`)
	return w
}

// fired sets a reminder on the target and makes it fire `late` after its time.
func (w *reminderPushWorld) fired(t *testing.T, note string, late time.Duration) (reminder.Reminder, int64) {
	t.Helper()
	ctx := context.Background()
	item, _, err := w.reminders.Set(ctx, w.author.User, w.target.ID, reminder.SetInput{RemindAt: time.Now().Add(time.Hour), Note: &note})
	if err != nil {
		t.Fatal(err)
	}
	w.exec(t, `UPDATE message_reminders SET remind_at = now() - $2::interval WHERE id = $1`, item.ID, late.String())
	if err := w.reminders.Fire(ctx, item.ID, 0); err != nil {
		t.Fatal(err)
	}
	var seq int64
	if err := w.pool.QueryRow(ctx, `SELECT max(seq) FROM events WHERE subject_id = $1 AND type = 'reminder.fired'`, item.ID).Scan(&seq); err != nil {
		t.Fatal(err)
	}
	return item, seq
}

func (w *reminderPushWorld) closeAll(t *testing.T) {
	t.Helper()
	w.exec(t, `DELETE FROM message_reminders`)
	w.exec(t, `UPDATE mobile_push_deliveries SET sent_at = now() WHERE sent_at IS NULL`)
	w.exec(t, `UPDATE notification_deliveries SET sent_at = now() WHERE sent_at IS NULL`)
	w.relay.messages = nil
}

func (w *reminderPushWorld) deliverOne(t *testing.T) mobilePayload {
	t.Helper()
	if err := w.worker.deliverMobile(context.Background()); err != nil {
		t.Fatal(err)
	}
	if len(w.relay.messages) != 1 {
		t.Fatalf("relay messages = %d, want 1", len(w.relay.messages))
	}
	sent := w.relay.messages[0]
	w.relay.messages = nil
	if sent.FallbackTitle != "Coma" || strings.Contains(sent.FallbackBody, w.secretBody) {
		t.Fatalf("relay sees %+v", sent)
	}
	return openPayload(t, w.authorKey, sent.Ciphertext)
}

// The alarm rings for the owner only, through a muted chat, a pause and
// quiet hours; it never reaches anyone else nor the e-mail digest.
func TestReminderPushRingsOnlyForTheOwner(t *testing.T) {
	w := newReminderPushWorld(t)
	w.exec(t, `UPDATE chat_members SET notify_level='none', muted_until=now()+interval '1 day' WHERE actor_id=$1`, w.author.User.ActorID)
	w.exec(t, `UPDATE users SET preferences=preferences||'{"email_digest":true}' WHERE actor_id=$1`, w.author.User.ActorID)
	w.exec(t, `INSERT INTO notification_snoozes(org_id,actor_id,starts_at,ends_at) VALUES($1,$2,now()-interval '1 hour',now()+interval '1 hour')`, w.orgID, w.author.User.ActorID)
	w.exec(t, `UPDATE users SET preferences=preferences||jsonb_build_object('schedule',jsonb_build_object('from',to_char(now() AT TIME ZONE 'UTC' + interval '1 hour','HH24:MI'),'to',to_char(now() AT TIME ZONE 'UTC' + interval '2 hours','HH24:MI'),'days','all')) WHERE actor_id=$1`, w.author.User.ActorID)

	item, seq := w.fired(t, "позвонить Ивану", time.Minute)
	if got := w.count(t, `SELECT count(*) FROM notification_jobs WHERE event_seq=$1`, seq); got != 1 {
		t.Fatalf("push jobs = %d", got)
	}
	w.materialize(t)
	web, mobile := w.deliveries(t, seq)
	if len(web) != 1 || web[0] != w.authorSub || len(mobile) != 1 || mobile[0] != w.authorDev {
		t.Fatalf("deliveries web=%v mobile=%v, want only the owner's", web, mobile)
	}
	if got := w.count(t, `SELECT count(*) FROM email_digest_items`); got != 0 {
		t.Fatalf("digest items = %d", got)
	}
	// A second materialization adds nothing: one push per firing.
	w.exec(t, `INSERT INTO notification_jobs(org_id,event_seq) VALUES($1,$2)`, w.orgID, seq)
	w.materialize(t)
	if web, mobile := w.deliveries(t, seq); len(web) != 1 || len(mobile) != 1 {
		t.Fatalf("second materialize: web=%v mobile=%v", web, mobile)
	}
	payload := w.deliverOne(t)
	wantURL := "/chat/" + w.chatID + "?message=" + w.target.ID + "&reminder=" + item.ID
	if payload.Title != "Напоминание" || payload.Kind != "reminder" || payload.URL != wantURL || payload.ChatID != w.chatID ||
		payload.Tag != "reminder-"+item.ID || payload.Body != "Other · "+w.chatName+": "+w.secretBody+"\n📝 позвонить Ивану" {
		t.Fatalf("payload = %+v", payload)
	}
	// Delivered: never again, even if the worker runs once more.
	if err := w.worker.deliverMobile(context.Background()); err != nil || len(w.relay.messages) != 0 {
		t.Fatalf("second delivery: %d, %v", len(w.relay.messages), err)
	}

	// Only push_enabled=false silences it.
	w.closeAll(t)
	w.exec(t, `UPDATE users SET preferences=preferences||'{"push_enabled":false}' WHERE actor_id=$1`, w.author.User.ActorID)
	_, seq = w.fired(t, "", time.Minute)
	w.materialize(t)
	if web, mobile := w.deliveries(t, seq); len(web)+len(mobile) != 0 {
		t.Fatalf("push off: %v %v", web, mobile)
	}
}

// The text, author and chat are shown only with push_preview on and only
// while the owner can read the message; the note only with preview on.
func TestReminderPushShowsOnlyWhatTheOwnerMaySee(t *testing.T) {
	w := newReminderPushWorld(t)
	secrets := func(t *testing.T, payload mobilePayload, allowed ...string) {
		t.Helper()
		plain, _ := json.Marshal(payload)
		for _, secret := range []string{w.secretBody, w.chatName, w.chatID, w.target.ID, "Other"} {
			skip := false
			for _, value := range allowed {
				skip = skip || value == secret
			}
			if !skip && strings.Contains(string(plain), secret) {
				t.Fatalf("push carries %q: %s", secret, plain)
			}
		}
	}

	// Preview off: neither the text nor the note.
	w.exec(t, `UPDATE users SET preferences='{"push_preview":false,"locale":"en"}' WHERE actor_id=$1`, w.author.User.ActorID)
	w.fired(t, "secret note", time.Minute)
	w.materialize(t)
	payload := w.deliverOne(t)
	if payload.Title != "Reminder" || payload.Body != "Reminder about a message" || payload.Kind != "reminder" {
		t.Fatalf("preview off: %+v", payload)
	}
	secrets(t, payload, w.chatID, w.target.ID)
	if strings.Contains(payload.Body, "secret note") {
		t.Fatal("preview off shows the note")
	}

	// Left the chat: the note only, and the link goes to «Important».
	w.closeAll(t)
	w.exec(t, `UPDATE users SET preferences='{"push_preview":true}' WHERE actor_id=$1`, w.author.User.ActorID)
	item, _ := w.fired(t, "call back", time.Minute)
	w.exec(t, `DELETE FROM chat_members WHERE chat_id=$1 AND actor_id=$2`, w.chatID, w.author.User.ActorID)
	w.materialize(t)
	payload = w.deliverOne(t)
	if payload.Body != "📝 call back" || payload.URL != "/important?tab=reminders" || payload.ChatID != "" || payload.Tag != "reminder-"+item.ID {
		t.Fatalf("no access: %+v", payload)
	}
	secrets(t, payload)

	// Archived chat, no note: only that there is no access.
	w.closeAll(t)
	w.exec(t, `INSERT INTO chat_members(chat_id,actor_id,org_id,role) VALUES($1,$2,$3,'member')`, w.chatID, w.author.User.ActorID, w.orgID)
	w.fired(t, "", time.Minute)
	w.exec(t, `UPDATE chats SET archived_at=now() WHERE id=$1`, w.chatID)
	w.materialize(t)
	payload = w.deliverOne(t)
	if payload.Body != "Нет доступа к сообщению" || payload.URL != "/important?tab=reminders" {
		t.Fatalf("archived: %+v", payload)
	}
	secrets(t, payload)
	w.exec(t, `UPDATE chats SET archived_at=NULL WHERE id=$1`, w.chatID)

	// Message deleted after firing, the note kept: the alarm still rings,
	// with the note only.
	w.closeAll(t)
	_, seq := w.fired(t, "ask about it", time.Minute)
	if _, err := w.messages.Delete(context.Background(), w.other.User, w.target.ID); err != nil {
		t.Fatal(err)
	}
	w.materialize(t)
	if web, mobile := w.deliveries(t, seq); len(web) != 1 || len(mobile) != 1 {
		t.Fatalf("deleted message: deliveries %v %v", web, mobile)
	}
	payload = w.deliverOne(t)
	if payload.Body != "📝 ask about it" || payload.URL != "/important?tab=reminders" {
		t.Fatalf("deleted message: %+v", payload)
	}
	secrets(t, payload)
}

// A firing that is no longer current is never pushed: closed, moved or
// fired again since, or more than six hours late.
func TestReminderPushFollowsTheReminder(t *testing.T) {
	w := newReminderPushWorld(t)
	ctx := context.Background()

	// Closed after materializing, before delivery.
	_, seq := w.fired(t, "", time.Minute)
	w.materialize(t)
	if err := w.reminders.DeleteByMessage(ctx, w.author.User, w.target.ID); err != nil {
		t.Fatal(err)
	}
	if err := w.worker.deliverMobile(ctx); err != nil || len(w.relay.messages) != 0 {
		t.Fatalf("closed reminder pushed: %d, %v", len(w.relay.messages), err)
	}
	if got := w.count(t, `SELECT count(*) FROM mobile_push_deliveries WHERE event_seq=$1 AND sent_at IS NOT NULL AND last_error='scheduled_closed'`, seq); got != 1 {
		t.Fatalf("skipped = %d", got)
	}

	// Moved (pending again) before materializing.
	w.closeAll(t)
	_, seq = w.fired(t, "", time.Minute)
	if _, _, err := w.reminders.Set(ctx, w.author.User, w.target.ID, reminder.SetInput{RemindAt: time.Now().Add(time.Hour)}); err != nil {
		t.Fatal(err)
	}
	w.materialize(t)
	if web, mobile := w.deliveries(t, seq); len(web)+len(mobile) != 0 {
		t.Fatalf("moved reminder pushed: %v %v", web, mobile)
	}

	// More than six hours late: it fires («пропущено») but rings no one.
	w.closeAll(t)
	_, seq = w.fired(t, "", 7*time.Hour)
	w.materialize(t)
	if web, mobile := w.deliveries(t, seq); len(web)+len(mobile) != 0 {
		t.Fatalf("a 7-hour-late alarm rang: %v %v", web, mobile)
	}
	// Five hours late still rings.
	w.closeAll(t)
	_, seq = w.fired(t, "", 5*time.Hour)
	w.materialize(t)
	if web, mobile := w.deliveries(t, seq); len(web) != 1 || len(mobile) != 1 {
		t.Fatalf("a 5-hour-late alarm: %v %v", web, mobile)
	}
	// Held up past six hours before delivery (the worker was down): dropped.
	w.exec(t, `UPDATE message_reminders SET remind_at = remind_at - interval '2 hours', fired_at = fired_at WHERE state = 'fired'`)
	if err := w.worker.deliverMobile(ctx); err != nil || len(w.relay.messages) != 0 {
		t.Fatalf("an alarm held up past six hours rang: %d, %v", len(w.relay.messages), err)
	}
}

func TestReminderTexts(t *testing.T) {
	for _, key := range []string{"title", "hidden", "no_access", "deleted"} {
		if ReminderText(key, "ru") == "" || ReminderText(key, "en") == "" {
			t.Errorf("no text for %s", key)
		}
	}
	// Web push payload of a reminder keeps the link and carries no kind
	// the service worker does not need.
	content := reminderContent(reminderData{id: "r", chatID: "c", messageID: ptr("m"), available: true, author: ptr("A"), body: ptr("text")}, "ru", true)
	if content.URL != "/chat/c?message=m&reminder=r" || content.Body != "A: text" {
		t.Fatalf("content = %+v", content)
	}
}
