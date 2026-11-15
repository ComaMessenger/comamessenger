package push

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/comamessenger/comamessenger/core/internal/message"
	"github.com/comamessenger/comamessenger/core/internal/request"
	"github.com/google/uuid"
)

func TestRequestNotificationTexts(t *testing.T) {
	chat, body := "Зал ЛФК", "Планёрка в понедельник. Будете?"
	chatID := uuid.NewString()
	recipient := []byte(`{"request":true,"request_recipient":true,"message_id":"m1"}`)
	content := buildNotification("message.created", recipient, "Анна", "ru", false, &chatID, nil, &body, &chat)
	if content.Title != "Запрос · Анна" || content.Body != "Ждут вашего ответа" || content.URL != "/chat/"+chatID+"?message=m1" {
		t.Fatalf("request push without preview = %+v", content)
	}
	content = buildNotification("message.created", recipient, "Анна", "ru", true, &chatID, nil, &body, &chat)
	if content.Body != chat+": "+body {
		t.Fatalf("request push with preview = %+v", content)
	}
	// Someone who is not asked gets an ordinary message push.
	observer := []byte(`{"request":true,"request_recipient":false,"message_id":"m1"}`)
	if content := buildNotification("message.created", observer, "Анна", "ru", true, &chatID, nil, &body, &chat); content.Title != "Анна · "+chat || content.Body != body {
		t.Fatalf("observer push = %+v", content)
	}
	reminded := []byte(`{"kind":"manual","message_id":"m1","request":true,"request_due_at":"2026-11-20T15:00:00Z","timezone":"Europe/Moscow"}`)
	content = buildNotification("request.reminded", reminded, "Анна", "ru", false, &chatID, nil, &body, &chat)
	if content.Title != "Напоминание: ждут вашего ответа" || content.Body != "Анна · Зал ЛФК · до пт 20.11, 18:00" || strings.Contains(content.Body, body) {
		t.Fatalf("reminder push = %+v", content)
	}
	if content := buildNotification("request.reminded", reminded, "Anna", "en", false, &chatID, nil, &body, &chat); content.Body != "Anna · Зал ЛФК · due Fri 20 Nov, 18:00" {
		t.Fatalf("en reminder push = %+v", content)
	}
	summary := []byte(`{"message_id":"m1","reminded":3,"answered_count":5,"waiting_count":3}`)
	if content := buildNotification("request.auto_reminded", summary, "Анна", "ru", false, &chatID, nil, nil, &chat); content.Title != "Запрос: ответили 5 из 8" || content.Body != "Напомнили 3" {
		t.Fatalf("summary push = %+v", content)
	}
	everyone := []byte(`{"message_id":"m1","reminded":0,"answered_count":5,"waiting_count":0}`)
	if content := buildNotification("request.auto_reminded", everyone, "Анна", "ru", false, &chatID, nil, nil, &chat); content.Body != "Ответили все" {
		t.Fatalf("everyone answered push = %+v", content)
	}
	if got := categoryBody("request.reminded", reminded, "Анна", "ru"); !strings.HasPrefix(got, "Напоминание: ждут вашего ответа · ") {
		t.Fatalf("digest line = %q", got)
	}
}

// A recipient counts as mentioned: a request and a reminder about it reach
// them in a chat set to «mentions only», nothing reaches a chat set to «none».
func TestRequestPushFollowsMentionRules(t *testing.T) {
	w := newFailurePushWorld(t)
	ctx := context.Background()
	requests := request.NewService(w.pool, nil)
	now := time.Now().UTC()
	requests.SetClock(func() time.Time { return now })
	messages := message.NewService(w.pool, 1024, 100, nil)
	messages.SetRequests(requests)
	w.exec(t, `UPDATE chat_members SET notify_level='mentions' WHERE chat_id=$1 AND actor_id=$2`, w.chatID, w.author.User.ActorID)

	req, _, err := messages.CreateRequest(ctx, w.other.User, w.chatID, message.CreateRequestInput{
		ClientMsgID: uuid.NewString(), Body: w.secretBody, Audience: request.AudienceInput{Kind: "chat"},
		Answer: request.AnswerSpec{Preset: request.PresetAck},
	})
	if err != nil {
		t.Fatal(err)
	}
	w.materialize(t)
	if web, mobile := w.deliveries(t, req.CreatedSeq); len(web) != 1 || len(mobile) != 1 {
		t.Fatalf("request push to a «mentions only» recipient: web=%v mobile=%v", web, mobile)
	}
	if err := w.worker.deliverMobile(ctx); err != nil {
		t.Fatal(err)
	}
	if len(w.relay.messages) != 1 {
		t.Fatalf("relay got %d", len(w.relay.messages))
	}
	payload := openPayload(t, w.authorKey, w.relay.messages[0].Ciphertext)
	if payload.Title != "Запрос · Other" || payload.Body != w.chatName+": "+w.secretBody || payload.URL != "/chat/"+w.chatID+"?message="+req.ID {
		t.Fatalf("request payload = %+v", payload)
	}

	reminded := func() int64 {
		t.Helper()
		if _, err := requests.Remind(ctx, w.other.User, req.ID); err != nil {
			t.Fatal(err)
		}
		var seq int64
		if err := w.pool.QueryRow(ctx, `SELECT max(seq) FROM events WHERE type='request.reminded' AND subject_id=$1`, req.ID).Scan(&seq); err != nil {
			t.Fatal(err)
		}
		w.materialize(t)
		return seq
	}
	if web, mobile := w.deliveries(t, reminded()); len(web) != 1 || len(mobile) != 1 {
		t.Fatalf("reminder push in «mentions only»: web=%v mobile=%v", web, mobile)
	}
	w.relay.messages = nil
	if err := w.worker.deliverMobile(ctx); err != nil {
		t.Fatal(err)
	}
	payload = openPayload(t, w.authorKey, w.relay.messages[0].Ciphertext)
	if payload.Title != "Напоминание: ждут вашего ответа" || strings.Contains(payload.Body, w.secretBody) {
		t.Fatalf("reminder payload = %+v", payload)
	}

	w.exec(t, `UPDATE chat_members SET notify_level='none' WHERE chat_id=$1 AND actor_id=$2`, w.chatID, w.author.User.ActorID)
	now = now.Add(3 * time.Hour)
	if web, mobile := w.deliveries(t, reminded()); len(web) != 0 || len(mobile) != 0 {
		t.Fatalf("reminder push in a «none» chat: web=%v mobile=%v", web, mobile)
	}
}
