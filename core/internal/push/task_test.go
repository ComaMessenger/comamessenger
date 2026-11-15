package push

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/comamessenger/comamessenger/core/internal/message"
	"github.com/comamessenger/comamessenger/core/internal/task"
	"github.com/google/uuid"
)

func TestTaskNotificationTexts(t *testing.T) {
	chat := "Кухня"
	chatID := uuid.NewString()
	data := func(kind string, extra string) []byte {
		return []byte(`{"message_id":"m1","kind":"` + kind + `","task":true,"task_title":"Помыть пол","task_due_at":"2026-11-20T15:00:00Z","timezone":"Europe/Moscow"` + extra + `}`)
	}
	build := func(kind, extra, locale string, preview bool) notificationContent {
		return buildNotification("task.notified", data(kind, extra), "Анна", locale, preview, &chatID, nil, nil, &chat)
	}
	cases := []struct {
		kind, extra    string
		preview        bool
		title, body    string
		locale         string
		forbiddenTitle bool
	}{
		{"assigned", "", true, "Задача · Анна", "Кухня: Помыть пол · до пт 20.11, 18:00", "ru", false},
		{"assigned", "", false, "Задача · Анна", "Вам поставили задачу", "ru", true},
		{"item_assigned", `,"task_item":"Швабра"`, true, "Пункт задачи · Анна", "Швабра — в задаче «Помыть пол»", "ru", false},
		{"item_assigned", `,"task_item":"Швабра"`, false, "Пункт задачи · Анна", "Вам назначили пункт задачи", "ru", true},
		{"offered", `,"task_assignee_kind":"department","task_label":"Кухня"`, true, "Задача отделу «Кухня»", "Помыть пол — возьмите, если можете", "ru", false},
		{"offered", `,"task_assignee_kind":"department","task_label":"Кухня"`, false, "Задача отделу «Кухня»", "Новая задача для вашего отдела", "ru", true},
		{"taken", "", true, "Анна взял(а) задачу", "Помыть пол", "ru", false},
		{"nudged", "", false, "Напоминание о задаче · Анна", "Задача в чате Кухня · до пт 20.11, 18:00", "ru", true},
		{"due_soon", "", true, "Через час срок задачи", "Помыть пол · Кухня", "ru", false},
		{"overdue", `,"task_recipient_author":true,"task_responsible":"Илья"`, true, "Срок задачи прошёл", "Помыть пол · отвечает Илья", "ru", false},
		{"overdue", "", true, "Срок задачи прошёл", "Помыть пол · Кухня", "ru", false},
		{"due_changed", "", true, "Новый срок задачи", "Помыть пол · до пт 20.11, 18:00", "ru", false},
		{"completed", "", false, "Готово · Анна", "Задача в чате Кухня", "ru", true},
		{"reopened", "", true, "Задачу вернули в работу", "Помыть пол · Анна", "ru", false},
		{"assigned", "", true, "Task · Анна", "Кухня: Помыть пол · due Fri 20 Nov, 18:00", "en", false},
	}
	for _, c := range cases {
		content := build(c.kind, c.extra, c.locale, c.preview)
		if content.Title != c.title || content.Body != c.body || content.Kind != "task" || content.URL != "/chat/"+chatID+"?message=m1" {
			t.Errorf("%s preview=%v: %+v", c.kind, c.preview, content)
		}
		if c.forbiddenTitle && (strings.Contains(content.Body, "Помыть") || strings.Contains(content.Title, "Помыть") || strings.Contains(content.Body, "Швабра")) {
			t.Errorf("%s without preview shows the title: %+v", c.kind, content)
		}
	}
	// The digest line never shows the title.
	if got := categoryBody("task.notified", data("assigned", ""), "Анна", "ru"); got != "Задача · Анна · Вам поставили задачу" {
		t.Fatalf("digest = %q", got)
	}
}

// The responsible person is notified like a mentioned person; they do not
// get a second push for message.created; «none» silences the task too; the
// author's «taken»/«completed» come always.
func TestTaskPushFollowsMentionRules(t *testing.T) {
	w := newFailurePushWorld(t)
	ctx := context.Background()
	tasks := task.NewService(w.pool, nil)
	messages := message.NewService(w.pool, 4096, 100, nil)
	messages.SetTasks(tasks)
	w.exec(t, `UPDATE chat_members SET notify_level='mentions' WHERE chat_id=$1 AND actor_id=$2`, w.chatID, w.author.User.ActorID)
	remind := false
	due := time.Now().Add(5 * time.Hour)
	created, _, err := messages.CreateTask(ctx, w.other.User, w.chatID, message.CreateTaskInput{
		ClientMsgID: uuid.NewString(), Title: w.secretBody, Description: "описание", DueAt: &due, RemindBeforeDue: &remind,
		Assignee: task.AssigneeInput{Kind: "person", ActorID: &w.author.User.ActorID},
	})
	if err != nil {
		t.Fatal(err)
	}
	var assigned int64
	if err := w.pool.QueryRow(ctx, `SELECT seq FROM events WHERE type='task.notified' AND subject_id=$1`, created.ID).Scan(&assigned); err != nil {
		t.Fatal(err)
	}
	for range 3 {
		w.materialize(t)
	}
	if web, mobile := w.deliveries(t, assigned); len(web) != 1 || len(mobile) != 1 {
		t.Fatalf("assigned push in «mentions only»: web=%v mobile=%v", web, mobile)
	}
	if web, mobile := w.deliveries(t, created.CreatedSeq); len(web) != 0 || len(mobile) != 0 {
		t.Fatalf("second push for message.created: web=%v mobile=%v", web, mobile)
	}
	if err := w.worker.deliverMobile(ctx); err != nil {
		t.Fatal(err)
	}
	if len(w.relay.messages) != 1 {
		t.Fatalf("relay got %d", len(w.relay.messages))
	}
	payload := openPayload(t, w.authorKey, w.relay.messages[0].Ciphertext)
	if payload.Title != "Задача · Other" || !strings.Contains(payload.Body, w.chatName+": "+w.secretBody) || payload.Kind != "task" ||
		payload.URL != "/chat/"+w.chatID+"?message="+created.ID || strings.Contains(payload.Body, "описание") {
		t.Fatalf("assigned payload = %+v", payload)
	}

	// Without preview: no title.
	w.exec(t, `UPDATE users SET preferences='{"push_preview":false}' WHERE actor_id=$1`, w.author.User.ActorID)
	if _, err := messages.NudgeTask(ctx, w.other.User, created.ID); err != nil {
		t.Fatal(err)
	}
	w.materialize(t)
	w.relay.messages = nil
	if err := w.worker.deliverMobile(ctx); err != nil {
		t.Fatal(err)
	}
	if len(w.relay.messages) != 1 {
		t.Fatalf("nudge relay got %d", len(w.relay.messages))
	}
	payload = openPayload(t, w.authorKey, w.relay.messages[0].Ciphertext)
	if strings.Contains(payload.Body, w.secretBody) || !strings.HasPrefix(payload.Body, "Задача в чате "+w.chatName) {
		t.Fatalf("nudge without preview = %+v", payload)
	}

	// «none»: nothing about the task, but the author learns it is done.
	w.exec(t, `UPDATE chat_members SET notify_level='none' WHERE chat_id=$1 AND actor_id=$2`, w.chatID, w.author.User.ActorID)
	w.exec(t, `UPDATE chat_members SET muted_until=now()+interval '1 day' WHERE chat_id=$1 AND actor_id=$2`, w.chatID, w.other.User.ActorID)
	tasks.SetClock(func() time.Time { return time.Now().Add(3 * time.Hour) })
	if _, err := messages.NudgeTask(ctx, w.other.User, created.ID); err != nil {
		t.Fatal(err)
	}
	var nudged int64
	if err := w.pool.QueryRow(ctx, `SELECT max(seq) FROM events WHERE type='task.notified' AND subject_id=$1`, created.ID).Scan(&nudged); err != nil {
		t.Fatal(err)
	}
	w.materialize(t)
	if web, mobile := w.deliveries(t, nudged); len(web) != 0 || len(mobile) != 0 {
		t.Fatalf("nudge in a «none» chat: web=%v mobile=%v", web, mobile)
	}
	if _, err := messages.SetTaskStatus(ctx, w.author.User, created.ID, task.StatusInput{Status: "done"}); err != nil {
		t.Fatal(err)
	}
	var completed int64
	if err := w.pool.QueryRow(ctx, `SELECT max(seq) FROM events WHERE type='task.notified' AND subject_id=$1 AND data->>'kind'='completed'`, created.ID).Scan(&completed); err != nil {
		t.Fatal(err)
	}
	w.materialize(t)
	if web, mobile := w.deliveries(t, completed); len(web) != 1 || len(mobile) != 1 {
		t.Fatalf("completed to a muted author: web=%v mobile=%v", web, mobile)
	}
}
