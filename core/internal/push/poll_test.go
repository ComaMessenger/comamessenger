package push

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/comamessenger/comamessenger/core/internal/message"
	"github.com/comamessenger/comamessenger/core/internal/poll"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

func TestPollNotificationTexts(t *testing.T) {
	chat := "Кухня"
	chatID := uuid.NewString()
	build := func(eventType, raw, actor, locale string, preview bool) notificationContent {
		return buildNotification(eventType, []byte(raw), actor, locale, preview, &chatID, nil, nil, &chat)
	}
	readable := `"poll":true,"message_id":"m1","poll_readable":true,"poll_question":"Когда субботник?","poll_options":["Среда","Четверг"],"poll_due_at":"2026-11-20T15:00:00Z","timezone":"Europe/Moscow"`
	cases := []struct {
		eventType, raw, actor, locale string
		preview                       bool
		title, body                   string
	}{
		{"message.created", `{` + readable + `}`, "Анна", "ru", true, "Опрос · Анна", "Кухня: Когда субботник?"},
		{"message.created", `{` + readable + `}`, "Анна", "ru", false, "Опрос · Анна", "Новый опрос"},
		{"message.created", `{"poll":true,"message_id":"m1"}`, "Анна", "ru", true, "Опрос · Анна", "Новый опрос"},
		{"poll.notified", `{"kind":"reminded",` + readable + `}`, "Анна", "ru", false, "Напоминание: опрос", "Анна · Кухня · до пт 20.11, 18:00"},
		{"poll.notified", `{"kind":"closed_expired",` + readable + `,"poll_final_counts":[2,5],"poll_voter_count":7}`, "", "ru", true, "Опрос закрыт", "Итог: «Четверг» — 5 из 7"},
		{"poll.notified", `{"kind":"closed_expired",` + readable + `,"poll_final_counts":[2,5],"poll_voter_count":7}`, "", "ru", false, "Опрос закрыт", "Опрос закрыт по сроку"},
		{"poll.notified", `{"kind":"closed_expired",` + readable + `,"poll_final_counts":[0,0],"poll_voter_count":0}`, "", "ru", true, "Опрос закрыт", "Опрос закрыт по сроку"},
		{"poll.notified", `{"kind":"closed_expired",` + readable + `,"poll_final_counts":[2,5],"poll_voter_count":7}`, "", "en", true, "Poll closed", "Result: “Четверг” — 5 of 7"},
	}
	for _, c := range cases {
		content := build(c.eventType, c.raw, c.actor, c.locale, c.preview)
		if content.Title != c.title || content.Body != c.body || content.Kind != "poll" || content.URL != "/chat/"+chatID+"?message=m1" {
			t.Errorf("%s %s preview=%v: %+v", c.eventType, c.raw, c.preview, content)
		}
	}
	// An ordinary message is not a poll.
	if content := build("message.created", `{}`, "Анна", "ru", true); content.Kind == "poll" {
		t.Fatalf("plain message = %+v", content)
	}
}

type pollJobs struct{ next int64 }

func (j *pollJobs) ScheduleTx(context.Context, pgx.Tx, string, time.Time) (int64, error) {
	j.next++
	return j.next, nil
}
func (j *pollJobs) CancelTx(context.Context, pgx.Tx, int64) error { return nil }

// A reminder reaches a person who has not voted like a mention; a voter
// gets none; the author learns the result of a poll closed by its due date
// even though the event has no actor.
func TestPollPushRules(t *testing.T) {
	w := newFailurePushWorld(t)
	ctx := context.Background()
	polls := poll.NewService(w.pool, nil)
	jobs := &pollJobs{}
	polls.SetJobs(jobs)
	messages := message.NewService(w.pool, 4096, 100, nil)
	messages.SetPolls(polls)
	w.exec(t, `UPDATE chat_members SET notify_level='mentions' WHERE chat_id=$1 AND actor_id=$2`, w.chatID, w.author.User.ActorID)
	no := false
	due := time.Now().Add(5 * time.Hour)
	created, _, err := messages.CreatePoll(ctx, w.other.User, w.chatID, message.CreatePollInput{
		ClientMsgID: uuid.NewString(), Question: w.secretBody, Options: []string{"да", "нет"}, Multiple: &no, Anonymous: &no, DueAt: &due,
	})
	if err != nil {
		t.Fatal(err)
	}
	// «mentions only»: the new poll itself is an ordinary message.
	for range 3 {
		w.materialize(t)
	}
	if web, mobile := w.deliveries(t, created.CreatedSeq); len(web) != 0 || len(mobile) != 0 {
		t.Fatalf("new poll in «mentions only»: web=%v mobile=%v", web, mobile)
	}
	if _, err := polls.Remind(ctx, w.other.User, created.ID); err != nil {
		t.Fatal(err)
	}
	var reminded int64
	if err := w.pool.QueryRow(ctx, `SELECT seq FROM events WHERE type='poll.notified' AND subject_id=$1`, created.ID).Scan(&reminded); err != nil {
		t.Fatal(err)
	}
	w.materialize(t)
	if web, mobile := w.deliveries(t, reminded); len(web) != 1 || len(mobile) != 1 {
		t.Fatalf("reminder in «mentions only»: web=%v mobile=%v", web, mobile)
	}
	w.relay.messages = nil
	if err := w.worker.deliverMobile(ctx); err != nil {
		t.Fatal(err)
	}
	if len(w.relay.messages) != 1 {
		t.Fatalf("relay got %d", len(w.relay.messages))
	}
	payload := openPayload(t, w.authorKey, w.relay.messages[0].Ciphertext)
	if payload.Title != "Напоминание: опрос" || !strings.HasPrefix(payload.Body, "Other · "+w.chatName+" · до ") || payload.Kind != "poll" ||
		payload.URL != "/chat/"+w.chatID+"?message="+created.ID || strings.Contains(payload.Body, w.secretBody) {
		t.Fatalf("reminder payload = %+v", payload)
	}

	// A reminder to someone who has voted by the time the push goes out is
	// dropped.
	polls.SetClock(func() time.Time { return time.Now().Add(3 * time.Hour) })
	if _, err := polls.Remind(ctx, w.other.User, created.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := polls.Vote(ctx, w.author.User, created.ID, poll.VoteInput{Options: []int{1}}); err != nil {
		t.Fatal(err)
	}
	var second int64
	if err := w.pool.QueryRow(ctx, `SELECT max(seq) FROM events WHERE type='poll.notified' AND subject_id=$1`, created.ID).Scan(&second); err != nil {
		t.Fatal(err)
	}
	w.materialize(t)
	if web, mobile := w.deliveries(t, second); len(web) != 0 || len(mobile) != 0 {
		t.Fatalf("reminder after the vote: web=%v mobile=%v", web, mobile)
	}

	// Closed by its due date: the author (muted chat, the event has no
	// actor) gets the result.
	w.exec(t, `UPDATE chat_members SET muted_until=now()+interval '1 day' WHERE chat_id=$1 AND actor_id=$2`, w.chatID, w.other.User.ActorID)
	polls.SetClock(func() time.Time { return due.Add(time.Minute) })
	if err := polls.Expire(ctx, created.ID, 1); err != nil {
		t.Fatal(err)
	}
	var closed int64
	if err := w.pool.QueryRow(ctx, `SELECT seq FROM events WHERE type='poll.notified' AND subject_id=$1 AND data->>'kind'='closed_expired' AND actor_id IS NULL`, created.ID).Scan(&closed); err != nil {
		t.Fatal(err)
	}
	w.materialize(t)
	if web, mobile := w.deliveries(t, closed); len(web) != 1 || len(mobile) != 1 {
		t.Fatalf("closed to the author: web=%v mobile=%v", web, mobile)
	}
	w.relay.messages = nil
	if err := w.worker.deliverMobile(ctx); err != nil {
		t.Fatal(err)
	}
	if len(w.relay.messages) != 1 {
		t.Fatalf("closed relay got %d", len(w.relay.messages))
	}
	payload = openPayload(t, w.otherKey, w.relay.messages[0].Ciphertext)
	if payload.Title != "Опрос закрыт" || payload.Body != "Итог: «нет» — 1 из 1" {
		t.Fatalf("closed payload = %+v", payload)
	}
}
