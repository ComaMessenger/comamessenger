package task_test

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/comamessenger/comamessenger/core/internal/message"
	"github.com/comamessenger/comamessenger/core/internal/task"
)

func TestDueSoonJob(t *testing.T) {
	w := newWorld(t)
	ctx := context.Background()
	due := w.clock.Now().Add(3 * time.Hour)
	item := w.create(t, w.author, message.CreateTaskInput{Title: "Срок", Assignee: person(w.alice.ActorID), DueAt: &due, RemindBeforeDue: ptr(true)})
	jobID, job := w.jobs.one(t, task.KindDueSoon, item.ID)
	// Early: snooze until the moment.
	var snooze task.Snooze
	if err := w.tasks.DueSoon(ctx, item.ID, jobID); !errors.As(err, &snooze) || snooze.Delay <= 0 {
		t.Fatalf("early = %v", err)
	}
	before := w.maxSeq(t)
	w.clock.Set(job.at.Add(time.Minute))
	if err := w.tasks.DueSoon(ctx, item.ID, jobID); err != nil {
		t.Fatal(err)
	}
	notes := w.notices(t, item.ID, before)
	if len(notes) != 1 || notes[0].Kind != "due_soon" || notes[0].Audience != w.alice.ActorID || notes[0].ByActor != nil {
		t.Fatalf("due soon = %+v", notes)
	}
	// Once.
	if err := w.tasks.DueSoon(ctx, item.ID, jobID); err != nil || len(w.notices(t, item.ID, before)) != 1 {
		t.Fatalf("second run = %v", err)
	}

	// Without the switch, or with less than an hour left, no job.
	w.clock.Set(due.Add(-3 * time.Hour))
	plain := w.create(t, w.author, message.CreateTaskInput{Title: "Без напоминания", Assignee: person(w.alice.ActorID), DueAt: &due})
	if len(w.jobs.live(task.KindDueSoon, plain.ID)) != 0 || len(w.jobs.live(task.KindOverdue, plain.ID)) != 1 {
		t.Fatal("jobs without the reminder")
	}

	// A moved due date makes the old job stale.
	moved := w.create(t, w.author, message.CreateTaskInput{Title: "Перенос", Assignee: person(w.alice.ActorID), DueAt: &due, RemindBeforeDue: ptr(true)})
	oldJob, oldAt := w.jobs.one(t, task.KindDueSoon, moved.ID)
	newDue := due.Add(24 * time.Hour)
	if _, err := w.messages.UpdateTask(ctx, w.author, moved.ID, task.UpdateInput{ExpectedVersion: ptr(1), DueAt: task.OptionalTime{Set: true, Value: &newDue}}); err != nil {
		t.Fatal(err)
	}
	before = w.maxSeq(t)
	w.clock.Set(oldAt.at.Add(time.Minute))
	if err := w.tasks.DueSoon(ctx, moved.ID, oldJob); err != nil || len(w.notices(t, moved.ID, before)) != 0 {
		t.Fatalf("stale job = %v", err)
	}

	// More than 30 minutes late: nothing is sent.
	late := w.create(t, w.author, message.CreateTaskInput{Title: "Поздно", Assignee: person(w.alice.ActorID), DueAt: ptr(w.clock.Now().Add(3 * time.Hour)), RemindBeforeDue: ptr(true)})
	lateJob, lateAt := w.jobs.one(t, task.KindDueSoon, late.ID)
	before = w.maxSeq(t)
	w.clock.Set(lateAt.at.Add(31 * time.Minute))
	if err := w.tasks.DueSoon(ctx, late.ID, lateJob); err != nil || len(w.notices(t, late.ID, before)) != 0 {
		t.Fatalf("late = %v", err)
	}

	// A queue: the candidates in the chat get it.
	w.clock.Set(time.Now().UTC().Truncate(time.Microsecond))
	queue := w.create(t, w.author, message.CreateTaskInput{Title: "Очередь", Assignee: task.AssigneeInput{Kind: "department", DepartmentID: &w.department},
		DueAt: ptr(w.clock.Now().Add(3 * time.Hour)), RemindBeforeDue: ptr(true)})
	queueJob, queueAt := w.jobs.one(t, task.KindDueSoon, queue.ID)
	before = w.maxSeq(t)
	w.clock.Set(queueAt.at)
	if err := w.tasks.DueSoon(ctx, queue.ID, queueJob); err != nil {
		t.Fatal(err)
	}
	if k := kinds(w.notices(t, queue.ID, before)); len(k) != 2 || k[w.alice.ActorID] != "due_soon" || k[w.carol.ActorID] != "due_soon" {
		t.Fatalf("queue due soon = %v", k)
	}
}

func TestOverdueJob(t *testing.T) {
	w := newWorld(t)
	ctx := context.Background()
	due := w.clock.Now().Add(2 * time.Hour)
	item := w.create(t, w.author, message.CreateTaskInput{Title: "Просрочка", Assignee: person(w.alice.ActorID), DueAt: &due})
	jobID, _ := w.jobs.one(t, task.KindOverdue, item.ID)
	before := w.maxSeq(t)
	w.clock.Set(due.Add(time.Minute))
	if err := w.tasks.Overdue(ctx, item.ID, jobID); err != nil {
		t.Fatal(err)
	}
	if k := kinds(w.notices(t, item.ID, before)); len(k) != 2 || k[w.alice.ActorID] != "overdue" || k[w.author.ActorID] != "overdue" {
		t.Fatalf("overdue = %v", k)
	}
	if w.count(t, `SELECT count(*) FROM events WHERE seq > $1 AND type='task.updated'`, before) != 1 || w.load(t, item.ID).Version != 2 {
		t.Fatal("overdue task.updated")
	}
	// More than 6 hours late: the update without notices.
	late := w.create(t, w.author, message.CreateTaskInput{Title: "Давно", Assignee: person(w.alice.ActorID), DueAt: ptr(w.clock.Now().Add(time.Hour))})
	lateJob, lateAt := w.jobs.one(t, task.KindOverdue, late.ID)
	before = w.maxSeq(t)
	w.clock.Set(lateAt.at.Add(7 * time.Hour))
	if err := w.tasks.Overdue(ctx, late.ID, lateJob); err != nil {
		t.Fatal(err)
	}
	if len(w.notices(t, late.ID, before)) != 0 || w.count(t, `SELECT count(*) FROM events WHERE seq > $1 AND type='task.updated'`, before) != 1 {
		t.Fatal("late overdue")
	}
	// A responsible person who left: only the author.
	w.clock.Set(time.Now().UTC().Truncate(time.Microsecond))
	left := w.create(t, w.author, message.CreateTaskInput{Title: "Ушла", Assignee: person(w.bob.ActorID), DueAt: ptr(w.clock.Now().Add(time.Hour))})
	leftJob, leftAt := w.jobs.one(t, task.KindOverdue, left.ID)
	w.exec(t, `UPDATE actors SET status='deactivated' WHERE id=$1`, w.bob.ActorID)
	before = w.maxSeq(t)
	w.clock.Set(leftAt.at)
	if err := w.tasks.Overdue(ctx, left.ID, leftJob); err != nil {
		t.Fatal(err)
	}
	if k := kinds(w.notices(t, left.ID, before)); len(k) != 1 || k[w.author.ActorID] != "overdue" {
		t.Fatalf("overdue without the responsible person = %v", k)
	}
	w.exec(t, `UPDATE actors SET status='active' WHERE id=$1`, w.bob.ActorID)
}

func TestStatusMovesJobs(t *testing.T) {
	w := newWorld(t)
	ctx := context.Background()
	due := w.clock.Now().Add(5 * time.Hour)
	item := w.create(t, w.author, message.CreateTaskInput{Title: "Сроки", Assignee: person(w.alice.ActorID), DueAt: &due, RemindBeforeDue: ptr(true)})
	soon, _ := w.jobs.one(t, task.KindDueSoon, item.ID)
	overdue, _ := w.jobs.one(t, task.KindOverdue, item.ID)
	if err := w.status(t, w.alice, item.ID, "in_progress"); err != nil {
		t.Fatal(err)
	}
	if len(w.jobs.live(task.KindOverdue, item.ID)) != 1 {
		t.Fatal("in_progress moved the jobs")
	}
	if err := w.status(t, w.alice, item.ID, "done"); err != nil {
		t.Fatal(err)
	}
	if !w.jobs.cancelled[soon] || !w.jobs.cancelled[overdue] {
		t.Fatal("done keeps the jobs")
	}
	// A stale job after done does nothing.
	w.clock.Set(due.Add(time.Minute))
	before := w.maxSeq(t)
	if err := w.tasks.Overdue(ctx, item.ID, overdue); err != nil || w.maxSeq(t) != before {
		t.Fatalf("overdue after done = %v", err)
	}
	// done → open with the due date ahead schedules them again.
	w.clock.Set(due.Add(-3 * time.Hour))
	if err := w.status(t, w.author, item.ID, "open"); err != nil {
		t.Fatal(err)
	}
	if len(w.jobs.live(task.KindOverdue, item.ID)) != 1 || len(w.jobs.live(task.KindDueSoon, item.ID)) != 1 {
		t.Fatal("reopen does not schedule")
	}
	// The chat archived: a job does nothing.
	jobID, _ := w.jobs.one(t, task.KindDueSoon, item.ID)
	w.exec(t, `UPDATE chats SET archived_at=now() WHERE id=$1`, w.chatID)
	w.clock.Set(due.Add(-time.Hour))
	before = w.maxSeq(t)
	if err := w.tasks.DueSoon(ctx, item.ID, jobID); err != nil || w.maxSeq(t) != before {
		t.Fatalf("archived = %v", err)
	}
}
