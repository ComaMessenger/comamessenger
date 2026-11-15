package task_test

import (
	"context"
	"encoding/json"
	"errors"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/comamessenger/comamessenger/core/internal/eventlog"
	"github.com/comamessenger/comamessenger/core/internal/message"
	"github.com/comamessenger/comamessenger/core/internal/request"
	"github.com/comamessenger/comamessenger/core/internal/task"
	"github.com/google/uuid"
)

func TestCreatePersonWithItems(t *testing.T) {
	w := newWorld(t)
	ctx := context.Background()
	before := w.maxSeq(t)
	due := w.clock.Now().Add(3 * time.Hour)
	input := message.CreateTaskInput{
		ClientMsgID: uuid.NewString(), Title: "Подготовить зал", Description: "Расставить **стулья**",
		Assignee: person(w.alice.ActorID), DueAt: &due, RemindBeforeDue: ptr(true),
		Items: []task.ItemInput{{Text: "Стулья", AssigneeID: ptr(w.bob.ActorID)}, {Text: "Проектор", AssigneeID: ptr(w.carol.ActorID)}, {Text: "Вода"}},
	}
	created := w.create(t, w.author, input)
	if created.Type != "task" || created.Body != "Подготовить зал\n\nРасставить **стулья**" || created.BodyFormat != "markdown" {
		t.Fatalf("message = %+v", created)
	}
	got := created.Task
	if got.Status != "open" || got.Assignee.Kind != "person" || *got.Assignee.ActorID != w.alice.ActorID || !got.Assignee.InChat ||
		len(got.Items) != 3 || got.Items[0].Text != "Стулья" || !got.Items[0].AssigneeInChat || got.Items[2].AssigneeID != nil ||
		!got.RemindBeforeDue || got.Version != 1 {
		t.Fatalf("task = %+v", got)
	}
	// Notices precede message.created and go to each person concerned once.
	var createdSeq int64
	if err := w.pool.QueryRow(ctx, `SELECT seq FROM events WHERE type='message.created' AND subject_id=$1`, created.ID).Scan(&createdSeq); err != nil {
		t.Fatal(err)
	}
	notes := w.notices(t, created.ID, before)
	if k := kinds(notes); len(notes) != 3 || k[w.alice.ActorID] != "assigned" || k[w.bob.ActorID] != "item_assigned" || k[w.carol.ActorID] != "item_assigned" {
		t.Fatalf("notices = %+v", notes)
	}
	if w.count(t, `SELECT count(*) FROM events WHERE type='task.notified' AND subject_id=$1 AND seq > $2`, created.ID, createdSeq) != 0 {
		t.Fatal("task.notified after message.created")
	}
	// Jobs: overdue at the due date, the reminder an hour before.
	if _, job := w.jobs.one(t, task.KindOverdue, created.ID); !job.at.Equal(due) {
		t.Fatalf("overdue at %v", job.at)
	}
	if _, job := w.jobs.one(t, task.KindDueSoon, created.ID); !job.at.Equal(due.Add(-time.Hour)) {
		t.Fatalf("due soon at %v", job.at)
	}
	// Idempotent replay; another content with the same key is a conflict.
	again, wasCreated, err := w.messages.CreateTask(ctx, w.author, w.chatID, input)
	if err != nil || wasCreated || again.ID != created.ID || again.Task == nil {
		t.Fatalf("replay = %v %v %v", again.ID, wasCreated, err)
	}
	other := input
	other.Title = "Другое"
	if _, _, err := w.messages.CreateTask(ctx, w.author, w.chatID, other); !errors.Is(err, message.ErrIdempotencyConflict) {
		t.Fatalf("conflict = %v", err)
	}
	// Search finds the task by its description (body).
	if w.count(t, `SELECT count(*) FROM messages WHERE id=$1 AND body LIKE '%стулья%'`, created.ID) != 1 {
		t.Fatal("body without the description")
	}
	// A plain edit of the message is refused: the body follows the task.
	if _, err := w.messages.Update(ctx, w.author, created.ID, message.UpdateInput{Body: "x", ExpectedVersion: created.Version}); !errors.Is(err, message.ErrInvalid) {
		t.Fatalf("plain edit = %v", err)
	}
}

func TestCreateRules(t *testing.T) {
	w := newWorld(t)
	ctx := context.Background()
	create := func(input message.CreateTaskInput) error {
		input.ClientMsgID = uuid.NewString()
		if input.RemindBeforeDue == nil {
			input.RemindBeforeDue = ptr(false)
		}
		if input.Title == "" {
			input.Title = "x"
		}
		_, _, err := w.messages.CreateTask(ctx, w.author, w.chatID, input)
		return err
	}
	for name, actorID := range map[string]string{"agent": w.agentID, "deactivated": w.sleepyID, "outsider": w.outsider.ActorID, "unknown": uuid.NewString()} {
		if err := create(message.CreateTaskInput{Assignee: person(actorID)}); !errors.Is(err, task.ErrAssigneeInvalid) {
			t.Errorf("%s responsible: %v", name, err)
		}
		if err := create(message.CreateTaskInput{Assignee: person(w.alice.ActorID), Items: []task.ItemInput{{Text: "a", AssigneeID: ptr(actorID)}}}); !errors.Is(err, task.ErrAssigneeInvalid) {
			t.Errorf("%s item assignee: %v", name, err)
		}
	}
	// On oneself: allowed, nobody is notified.
	before := w.maxSeq(t)
	self := w.create(t, w.author, message.CreateTaskInput{Title: "Себе", Assignee: person(w.author.ActorID)})
	if n := w.notices(t, self.ID, before); len(n) != 0 {
		t.Fatalf("notices to oneself: %+v", n)
	}
	// From a message of this chat, also in a thread; not from another chat.
	root, _, err := w.messages.Create(ctx, w.bob, w.chatID, message.CreateInput{ClientMsgID: uuid.NewString(), Body: "Нужно починить кран на кухне, срочно"})
	if err != nil {
		t.Fatal(err)
	}
	reply, _, err := w.messages.Create(ctx, w.carol, w.chatID, message.CreateInput{ClientMsgID: uuid.NewString(), Body: "в треде", ThreadRootID: &root.ID})
	if err != nil {
		t.Fatal(err)
	}
	foreign, _, err := w.messages.Create(ctx, w.outsider, w.otherID, message.CreateInput{ClientMsgID: uuid.NewString(), Body: "чужое"})
	if err != nil {
		t.Fatal(err)
	}
	fromRoot := w.create(t, w.author, message.CreateTaskInput{Title: "Кран", Assignee: person(w.alice.ActorID), SourceMessageID: &root.ID})
	if s := fromRoot.Task.Source; s == nil || s.MessageID != root.ID || s.AuthorID != w.bob.ActorID || s.Excerpt != root.Body || s.Deleted {
		t.Fatalf("source = %+v", s)
	}
	w.create(t, w.author, message.CreateTaskInput{Title: "Из треда", Assignee: person(w.alice.ActorID), SourceMessageID: &reply.ID})
	var invalid *task.InvalidError
	if err := create(message.CreateTaskInput{Assignee: person(w.alice.ActorID), SourceMessageID: &foreign.ID}); !errors.As(err, &invalid) || invalid.Field != "source_message_id" {
		t.Fatalf("foreign source = %v", err)
	}
	// The source deleted: no excerpt.
	if _, err := w.messages.Delete(ctx, w.bob, root.ID); err != nil {
		t.Fatal(err)
	}
	if s := w.load(t, fromRoot.ID).Source; s == nil || !s.Deleted || s.Excerpt != "" {
		t.Fatalf("deleted source = %+v", s)
	}
	// Not a member, an agent: refused.
	if _, _, err := w.messages.CreateTask(ctx, w.outsider, w.chatID, message.CreateTaskInput{ClientMsgID: uuid.NewString(), Title: "x", Assignee: person(w.alice.ActorID), RemindBeforeDue: ptr(false)}); !errors.Is(err, message.ErrNotFound) {
		t.Fatalf("outsider = %v", err)
	}
	agent := w.author
	agent.ActorID = w.agentID
	if _, _, err := w.messages.CreateTask(ctx, agent, w.chatID, message.CreateTaskInput{ClientMsgID: uuid.NewString(), Title: "x", Assignee: person(w.alice.ActorID), RemindBeforeDue: ptr(false)}); !errors.Is(err, task.ErrForbidden) && !errors.Is(err, message.ErrForbidden) {
		t.Fatalf("agent = %v", err)
	}
	// remind_before_due is required.
	if _, _, err := w.messages.CreateTask(ctx, w.author, w.chatID, message.CreateTaskInput{ClientMsgID: uuid.NewString(), Title: "x", Assignee: person(w.alice.ActorID)}); !errors.As(err, &invalid) || invalid.Field != "remind_before_due" {
		t.Fatalf("remind required = %v", err)
	}
}

func TestOpenTaskLimits(t *testing.T) {
	w := newWorld(t)
	limits := task.DefaultLimits()
	limits.OpenPerChat = 2
	w.tasks.SetLimits(limits)
	first := w.simple(t, w.alice)
	w.simple(t, w.bob)
	_, _, err := w.messages.CreateTask(context.Background(), w.author, w.chatID, message.CreateTaskInput{ClientMsgID: uuid.NewString(), Title: "x", Assignee: person(w.alice.ActorID), RemindBeforeDue: ptr(false)})
	expectErr(t, err, task.ErrLimitReached)
	// A closed task frees a place; reopening it over the limit is refused.
	if err := w.status(t, w.author, first.ID, "done"); err != nil {
		t.Fatal(err)
	}
	w.simple(t, w.carol)
	expectErr(t, w.status(t, w.author, first.ID, "open"), task.ErrLimitReached)
}

func TestQueue(t *testing.T) {
	w := newWorld(t)
	ctx := context.Background()
	department := task.AssigneeInput{Kind: "department", DepartmentID: &w.department}
	// Without requests.address_groups: refused, checked against the database.
	if _, _, err := w.messages.CreateTask(ctx, w.alice, w.chatID, message.CreateTaskInput{ClientMsgID: uuid.NewString(), Title: "x", Assignee: department, RemindBeforeDue: ptr(false)}); !errors.Is(err, task.ErrAudienceForbidden) {
		t.Fatalf("without permission = %v", err)
	}
	if _, _, err := w.messages.CreateTask(ctx, w.author, w.chatID, message.CreateTaskInput{ClientMsgID: uuid.NewString(), Title: "x", Assignee: task.AssigneeInput{Kind: "department", DepartmentID: ptr(uuid.NewString())}, RemindBeforeDue: ptr(false)}); !errors.Is(err, task.ErrDepartmentMissing) {
		t.Fatalf("unknown department = %v", err)
	}
	before := w.maxSeq(t)
	queue := w.create(t, w.author, message.CreateTaskInput{Title: "Помыть пол", Assignee: department})
	got := queue.Task
	want := []string{w.alice.ActorID, w.carol.ActorID}
	slices.Sort(want)
	if got.Assignee.Kind != "department" || got.Assignee.ActorID != nil || got.Assignee.Label != "Кухня" || !slices.Equal(got.Assignee.CandidateIDs, want) ||
		got.Assignee.DepartmentID.Value == nil || *got.Assignee.DepartmentID.Value != w.department {
		t.Fatalf("queue = %+v", got.Assignee)
	}
	if k := kinds(w.notices(t, queue.ID, before)); len(k) != 2 || k[w.alice.ActorID] != "offered" || k[w.carol.ActorID] != "offered" {
		t.Fatalf("offered = %+v", k)
	}
	// Position: bob in the chat, the outsider is not.
	byPosition := w.create(t, w.author, message.CreateTaskInput{Title: "Обед", Assignee: task.AssigneeInput{Kind: "position", PositionID: &w.position}})
	if !slices.Equal(byPosition.Task.Assignee.CandidateIDs, []string{w.bob.ActorID}) || byPosition.Task.Assignee.Label != "Повар" {
		t.Fatalf("position queue = %+v", byPosition.Task.Assignee)
	}
	// Too many and none.
	limits := task.DefaultLimits()
	limits.MaxCandidates = 1
	w.tasks.SetLimits(limits)
	if _, _, err := w.messages.CreateTask(ctx, w.author, w.chatID, message.CreateTaskInput{ClientMsgID: uuid.NewString(), Title: "x", Assignee: department, RemindBeforeDue: ptr(false)}); !errors.Is(err, task.ErrTooManyCandidates) {
		t.Fatalf("too many = %v", err)
	}
	w.tasks.SetLimits(task.DefaultLimits())
	if _, _, err := w.messages.CreateTask(ctx, w.author, w.otherID, message.CreateTaskInput{ClientMsgID: uuid.NewString(), Title: "x", Assignee: task.AssigneeInput{Kind: "department", DepartmentID: &w.subdept}, RemindBeforeDue: ptr(false)}); !errors.Is(err, task.ErrAudienceEmpty) {
		t.Fatalf("empty = %v", err)
	}
	// Both candidates see it in «Ждут вас»; bob does not.
	if items := w.waiting(t, w.alice, "tasks"); len(items) != 1 || items[0].Message.ID != queue.ID || *items[0].MyRole != "candidate" {
		t.Fatalf("alice waiting = %+v", items)
	}
	// Not a candidate.
	_, err := w.messages.TakeTask(ctx, w.bob, queue.ID)
	expectErr(t, err, task.ErrForbidden)
	// Two candidates at once: one takes it, the other gets already taken.
	errs := make(chan error, 2)
	go func() { _, err := w.messages.TakeTask(ctx, w.alice, queue.ID); errs <- err }()
	go func() { _, err := w.messages.TakeTask(ctx, w.carol, queue.ID); errs <- err }()
	var ok, taken int
	for range 2 {
		err := <-errs
		var conflict *task.ConflictError
		switch {
		case err == nil:
			ok++
		case errors.As(err, &conflict) && conflict.Code == "task_already_taken" && conflict.Task != nil && conflict.Task.Assignee.ActorID != nil:
			taken++
		default:
			t.Fatalf("take = %v", err)
		}
	}
	if ok != 1 || taken != 1 {
		t.Fatalf("ok=%d taken=%d", ok, taken)
	}
	current := w.load(t, queue.ID)
	taker := *current.Assignee.ActorID
	loser := w.alice
	if taker == w.alice.ActorID {
		loser = w.carol
	}
	if len(w.waiting(t, loser, "tasks")) != 0 {
		t.Fatal("the task stays in the other candidate's «Ждут вас»")
	}
	if n := w.notices(t, queue.ID, before); n[len(n)-1].Kind != "taken" || n[len(n)-1].Audience != w.author.ActorID {
		t.Fatalf("taken notice = %+v", n[len(n)-1])
	}
	// A candidate who left cannot take a queue.
	other := w.create(t, w.author, message.CreateTaskInput{Title: "Ещё", Assignee: department})
	w.exec(t, `DELETE FROM chat_members WHERE chat_id=$1 AND actor_id=$2`, w.chatID, w.carol.ActorID)
	_, err = w.messages.TakeTask(ctx, w.carol, other.ID)
	expectErr(t, err, task.ErrNotMember)
	if len(w.waiting(t, w.carol, "all")) != 0 {
		t.Fatal("a member who left still sees tasks of the chat")
	}
	// The author assigns a person directly: the queue becomes a person task.
	updated, err := w.messages.UpdateTask(ctx, w.author, other.ID, task.UpdateInput{ExpectedVersion: ptr(other.Task.Version), Assignee: ptr(person(w.bob.ActorID))})
	if err != nil || updated.Task.Assignee.Kind != "person" || *updated.Task.Assignee.ActorID != w.bob.ActorID || len(updated.Task.Assignee.CandidateIDs) != 0 {
		t.Fatalf("assign queue = %+v, %v", updated.Task, err)
	}
}

func TestStatusesAndPermissions(t *testing.T) {
	w := newWorld(t)
	ctx := context.Background()
	item := w.simple(t, w.alice)
	// Others: no status changes, no edits, no nudges.
	expectErr(t, w.status(t, w.carol, item.ID, "in_progress"), task.ErrForbidden)
	_, err := w.messages.UpdateTask(ctx, w.carol, item.ID, task.UpdateInput{ExpectedVersion: ptr(1), Title: ptr("x")})
	expectErr(t, err, task.ErrForbidden)
	_, err = w.messages.NudgeTask(ctx, w.carol, item.ID)
	expectErr(t, err, task.ErrForbidden)
	// The responsible person may not cancel or edit.
	expectErr(t, w.status(t, w.alice, item.ID, "canceled"), task.ErrForbidden)
	_, err = w.messages.UpdateTask(ctx, w.alice, item.ID, task.UpdateInput{ExpectedVersion: ptr(1), Title: ptr("x")})
	expectErr(t, err, task.ErrForbidden)
	// Not a member: not found.
	_, err = w.messages.GetTask(ctx, w.outsider, item.ID)
	expectErr(t, err, task.ErrNotFound)
	expectErr(t, w.status(t, w.outsider, item.ID, "done"), task.ErrNotFound)

	before := w.maxSeq(t)
	// open → in_progress → open → done (by the responsible person) → open
	// (by the author) → canceled → open.
	steps := []struct {
		user   string
		status string
	}{{"alice", "in_progress"}, {"alice", "open"}, {"alice", "done"}, {"author", "open"}, {"author", "canceled"}, {"admin", "open"}, {"admin", "canceled"}}
	for _, step := range steps {
		actor := w.alice
		switch step.user {
		case "author":
			actor = w.author
		case "admin":
			actor = w.admin
		}
		if err := w.status(t, actor, item.ID, step.status); err != nil {
			t.Fatalf("%s → %s: %v", step.user, step.status, err)
		}
	}
	got := w.load(t, item.ID)
	if got.Status != "canceled" || *got.CanceledReason != "moderator" || *got.StatusChangedBy != w.admin.ActorID {
		t.Fatalf("after steps = %+v", got)
	}
	notes := w.notices(t, item.ID, before)
	var seen []string
	for _, note := range notes {
		seen = append(seen, note.Kind+":"+note.Audience)
	}
	want := []string{"completed:" + w.author.ActorID, "reopened:" + w.alice.ActorID}
	if !slices.Equal(seen, want) {
		t.Fatalf("notices = %v, want %v", seen, want)
	}
	// Repeating the status: no change, no events.
	seq := w.maxSeq(t)
	if err := w.status(t, w.author, item.ID, "canceled"); err != nil {
		t.Fatal(err)
	}
	if w.maxSeq(t) != seq {
		t.Fatal("a repeated status wrote events")
	}
	// Not allowed: canceled → done, canceled → in_progress.
	expectErr(t, w.status(t, w.author, item.ID, "done"), task.ErrStatusInvalid)
	expectErr(t, w.status(t, w.author, item.ID, "in_progress"), task.ErrStatusInvalid)
	// A closed task is frozen.
	_, err = w.messages.UpdateTask(ctx, w.author, item.ID, task.UpdateInput{ExpectedVersion: ptr(got.Version), Title: ptr("x")})
	expectErr(t, err, task.ErrStatusInvalid)
	_, err = w.messages.AddTaskItem(ctx, w.author, item.ID, task.AddItemInput{Text: "x"})
	expectErr(t, err, task.ErrStatusInvalid)

	// A former chat admin loses control at once.
	second := w.simple(t, w.bob)
	w.exec(t, `UPDATE chat_members SET role='member' WHERE chat_id=$1 AND actor_id=$2`, w.chatID, w.admin.ActorID)
	expectErr(t, w.status(t, w.admin, second.ID, "canceled"), task.ErrForbidden)
	// A workspace moderator in the chat counts as admin (stored grant).
	w.exec(t, `UPDATE actors SET org_role='admin' WHERE id=$1`, w.carol.ActorID)
	expectErr(t, w.status(t, w.carol, second.ID, "in_progress"), task.ErrForbidden)
	w.exec(t, `INSERT INTO actor_permissions (org_id, actor_id, permission) VALUES ($1, $2, 'chats.moderate')`, w.orgID, w.carol.ActorID)
	if err := w.status(t, w.carol, second.ID, "in_progress"); err != nil {
		t.Fatalf("moderator: %v", err)
	}
	// The session claiming a role does not help: roles are read from the database.
	expectErr(t, w.status(t, w.carol, second.ID, "in_progress"), nil)
	_, err = w.messages.UpdateTask(ctx, w.outsider, second.ID, task.UpdateInput{ExpectedVersion: ptr(1), Title: ptr("x")})
	expectErr(t, err, task.ErrNotFound)
	// The author who left loses the rights but is told why.
	w.exec(t, `DELETE FROM chat_members WHERE chat_id=$1 AND actor_id=$2`, w.chatID, w.author.ActorID)
	expectErr(t, w.status(t, w.author, second.ID, "canceled"), task.ErrNotMember)
}

func TestUpdateTask(t *testing.T) {
	w := newWorld(t)
	ctx := context.Background()
	due := w.clock.Now().Add(5 * time.Hour)
	item := w.create(t, w.author, message.CreateTaskInput{Title: "Старое", Assignee: person(w.alice.ActorID), DueAt: &due, RemindBeforeDue: ptr(true)})
	oldSoon, _ := w.jobs.one(t, task.KindDueSoon, item.ID)
	oldOverdue, _ := w.jobs.one(t, task.KindOverdue, item.ID)
	// A stale version: 409 with the current task.
	_, err := w.messages.UpdateTask(ctx, w.author, item.ID, task.UpdateInput{ExpectedVersion: ptr(9), Title: ptr("x")})
	var conflict *task.ConflictError
	if !errors.As(err, &conflict) || conflict.Code != "task_version_conflict" || conflict.Task == nil || conflict.Task.Version != 1 {
		t.Fatalf("stale = %v", err)
	}
	// The title: body rebuilt, edited_at, message.updated, no task.updated.
	before := w.maxSeq(t)
	updated, err := w.messages.UpdateTask(ctx, w.author, item.ID, task.UpdateInput{ExpectedVersion: ptr(1), Title: ptr("Новое"), Description: ptr("Описание")})
	if err != nil {
		t.Fatal(err)
	}
	if updated.Body != "Новое\n\nОписание" || updated.EditedAt == nil || updated.Task.Title != "Новое" || updated.Task.Version != 2 || updated.Version != item.Version+1 {
		t.Fatalf("updated = %+v", updated)
	}
	if w.count(t, `SELECT count(*) FROM events WHERE seq > $1 AND type='message.updated'`, before) != 1 ||
		w.count(t, `SELECT count(*) FROM events WHERE seq > $1 AND type='task.updated'`, before) != 0 ||
		len(w.notices(t, item.ID, before)) != 0 {
		t.Fatal("title change events")
	}
	// The due date: jobs rescheduled, due_changed to the responsible person.
	before = w.maxSeq(t)
	newDue := w.clock.Now().Add(48 * time.Hour)
	updated, err = w.messages.UpdateTask(ctx, w.author, item.ID, task.UpdateInput{ExpectedVersion: ptr(2), DueAt: task.OptionalTime{Set: true, Value: &newDue}})
	if err != nil {
		t.Fatal(err)
	}
	if !w.jobs.cancelled[oldSoon] || !w.jobs.cancelled[oldOverdue] {
		t.Fatal("old jobs stay")
	}
	if _, job := w.jobs.one(t, task.KindOverdue, item.ID); !job.at.Equal(newDue) {
		t.Fatal("new overdue job")
	}
	if k := kinds(w.notices(t, item.ID, before)); k[w.alice.ActorID] != "due_changed" || len(k) != 1 {
		t.Fatalf("due notices = %v", k)
	}
	if w.count(t, `SELECT count(*) FROM events WHERE seq > $1 AND type='task.updated'`, before) != 1 {
		t.Fatal("task.updated")
	}
	// Removing the due date switches the reminder off and removes the jobs.
	updated, err = w.messages.UpdateTask(ctx, w.author, item.ID, task.UpdateInput{ExpectedVersion: ptr(updated.Task.Version), DueAt: task.OptionalTime{Set: true}})
	if err != nil || updated.Task.DueAt != nil || updated.Task.RemindBeforeDue {
		t.Fatalf("no due = %+v %v", updated.Task, err)
	}
	if len(w.jobs.live(task.KindOverdue, item.ID)) != 0 || len(w.jobs.live(task.KindDueSoon, item.ID)) != 0 {
		t.Fatal("jobs without a due date")
	}
	// A reminder needs a due date more than an hour ahead.
	var invalid *task.InvalidError
	_, err = w.messages.UpdateTask(ctx, w.author, item.ID, task.UpdateInput{ExpectedVersion: ptr(updated.Task.Version), RemindBeforeDue: ptr(true)})
	if !errors.As(err, &invalid) || invalid.Field != "remind_before_due" {
		t.Fatalf("remind without due = %v", err)
	}
	// Reassign: assigned to the new one, unassigned (no push) to the old one.
	before = w.maxSeq(t)
	updated, err = w.messages.UpdateTask(ctx, w.admin, item.ID, task.UpdateInput{ExpectedVersion: ptr(updated.Task.Version), Assignee: ptr(person(w.bob.ActorID))})
	if err != nil {
		t.Fatal(err)
	}
	notes := w.notices(t, item.ID, before)
	if k := kinds(notes); k[w.bob.ActorID] != "assigned" || k[w.alice.ActorID] != "unassigned" {
		t.Fatalf("reassign notices = %v", k)
	}
	if w.count(t, `SELECT count(*) FROM notification_jobs j JOIN events e ON e.org_id=j.org_id AND e.seq=j.event_seq WHERE e.seq > $1 AND e.data->>'kind'='unassigned'`, before) != 0 {
		t.Fatal("unassigned is pushed")
	}
	// Reassign to a queue needs the permission, checked in the database.
	_, err = w.messages.UpdateTask(ctx, w.admin, item.ID, task.UpdateInput{ExpectedVersion: ptr(updated.Task.Version), Assignee: &task.AssigneeInput{Kind: "position", PositionID: &w.position}})
	expectErr(t, err, task.ErrAudienceForbidden)
}

func TestItems(t *testing.T) {
	w := newWorld(t)
	ctx := context.Background()
	item := w.create(t, w.author, message.CreateTaskInput{Title: "Чек-лист", Assignee: person(w.alice.ActorID),
		Items: []task.ItemInput{{Text: "a", AssigneeID: ptr(w.bob.ActorID)}, {Text: "b"}, {Text: "c", AssigneeID: ptr(w.carol.ActorID)}}})
	ids := []string{item.Task.Items[0].ID, item.Task.Items[1].ID, item.Task.Items[2].ID}
	// The assignee of an item checks only their own item.
	got, err := w.messages.UpdateTaskItem(ctx, w.bob, item.ID, ids[0], task.UpdateItemInput{Done: ptr(true)})
	if err != nil || got.ItemsDone != 1 || got.Items[0].DoneBy == nil || *got.Items[0].DoneBy != w.bob.ActorID {
		t.Fatalf("own item = %+v %v", got, err)
	}
	_, err = w.messages.UpdateTaskItem(ctx, w.bob, item.ID, ids[1], task.UpdateItemInput{Done: ptr(true)})
	expectErr(t, err, task.ErrForbidden)
	_, err = w.messages.UpdateTaskItem(ctx, w.bob, item.ID, ids[0], task.UpdateItemInput{Text: ptr("x")})
	expectErr(t, err, task.ErrForbidden)
	_, err = w.messages.AddTaskItem(ctx, w.bob, item.ID, task.AddItemInput{Text: "x"})
	expectErr(t, err, task.ErrForbidden)
	// Responsible: check, uncheck, move, reassign.
	got, err = w.messages.UpdateTaskItem(ctx, w.alice, item.ID, ids[0], task.UpdateItemInput{Done: ptr(false)})
	if err != nil || got.ItemsDone != 0 {
		t.Fatalf("uncheck = %+v %v", got, err)
	}
	got, err = w.messages.UpdateTaskItem(ctx, w.alice, item.ID, ids[2], task.UpdateItemInput{Position: ptr(0)})
	if err != nil || got.Items[0].ID != ids[2] || got.Items[1].ID != ids[0] || got.Items[2].ID != ids[1] {
		t.Fatalf("move up = %+v %v", got, err)
	}
	got, err = w.messages.UpdateTaskItem(ctx, w.alice, item.ID, ids[2], task.UpdateItemInput{Position: ptr(2)})
	if err != nil || got.Items[0].ID != ids[0] || got.Items[2].ID != ids[2] {
		t.Fatalf("move down = %+v %v", got, err)
	}
	before := w.maxSeq(t)
	got, err = w.messages.UpdateTaskItem(ctx, w.alice, item.ID, ids[1], task.UpdateItemInput{AssigneeID: task.OptionalString{Set: true, Value: &w.carol.ActorID}})
	if err != nil || got.Items[1].AssigneeID == nil {
		t.Fatalf("assign = %+v %v", got, err)
	}
	if k := kinds(w.notices(t, item.ID, before)); k[w.carol.ActorID] != "item_assigned" {
		t.Fatalf("item notices = %v", k)
	}
	got, err = w.messages.UpdateTaskItem(ctx, w.alice, item.ID, ids[1], task.UpdateItemInput{AssigneeID: task.OptionalString{Set: true}})
	if err != nil || got.Items[1].AssigneeID != nil {
		t.Fatalf("unassign = %+v %v", got, err)
	}
	// Add at a position, delete, repeat delete.
	got, err = w.messages.AddTaskItem(ctx, w.author, item.ID, task.AddItemInput{Text: "first", Position: ptr(0)})
	if err != nil || len(got.Items) != 4 || got.Items[0].Text != "first" {
		t.Fatalf("add = %+v %v", got, err)
	}
	if _, err := w.messages.UpdateTaskItem(ctx, w.alice, item.ID, ids[0], task.UpdateItemInput{Done: ptr(true)}); err != nil {
		t.Fatal(err)
	}
	if err := w.messages.DeleteTaskItem(ctx, w.alice, item.ID, ids[0]); err != nil {
		t.Fatal(err)
	}
	if err := w.messages.DeleteTaskItem(ctx, w.alice, item.ID, ids[0]); err != nil {
		t.Fatalf("repeat delete = %v", err)
	}
	current := w.load(t, item.ID)
	if len(current.Items) != 3 || current.ItemsDone != 0 {
		t.Fatalf("after delete = %+v", current)
	}
	for index, entry := range current.Items {
		var position int
		if err := w.pool.QueryRow(ctx, `SELECT position FROM message_task_items WHERE id=$1`, entry.ID).Scan(&position); err != nil || position != index {
			t.Fatalf("position of %d = %d", index, position)
		}
	}
	// At most 30 items.
	for len(current.Items) < 30 {
		if _, err := w.messages.AddTaskItem(ctx, w.author, item.ID, task.AddItemInput{Text: "x"}); err != nil {
			t.Fatal(err)
		}
		current = w.load(t, item.ID)
	}
	_, err = w.messages.AddTaskItem(ctx, w.author, item.ID, task.AddItemInput{Text: "x"})
	expectErr(t, err, task.ErrLimitReached)
	_, err = w.messages.AddTaskItem(ctx, w.author, item.ID, task.AddItemInput{Text: "x", AssigneeID: &w.agentID})
	expectErr(t, err, task.ErrLimitReached)
}

func TestNudge(t *testing.T) {
	w := newWorld(t)
	ctx := context.Background()
	item := w.simple(t, w.alice)
	result, err := w.messages.NudgeTask(ctx, w.author, item.ID)
	if err != nil || result.NextNudgeAt == nil {
		t.Fatalf("nudge = %+v %v", result, err)
	}
	_, err = w.messages.NudgeTask(ctx, w.author, item.ID)
	var tooSoon *task.NudgeTooSoonError
	if !errors.As(err, &tooSoon) || tooSoon.RetryAfter <= 0 {
		t.Fatalf("too soon = %v", err)
	}
	for range 4 {
		w.clock.Set(w.clock.Now().Add(2 * time.Hour))
		if _, err := w.messages.NudgeTask(ctx, w.author, item.ID); err != nil {
			t.Fatal(err)
		}
	}
	w.clock.Set(w.clock.Now().Add(2 * time.Hour))
	_, err = w.messages.NudgeTask(ctx, w.author, item.ID)
	expectErr(t, err, task.ErrLimitReached)
	if n := w.count(t, `SELECT count(*) FROM events WHERE type='task.notified' AND subject_id=$1 AND data->>'kind'='nudged'`, item.ID); n != 5 {
		t.Fatalf("nudged = %d", n)
	}
	// At most 10 nudge pushes a day to one person, from all tasks.
	w.clock.Set(time.Now().UTC().Add(100 * time.Hour))
	for range 12 {
		other := w.simple(t, w.bob)
		if _, err := w.messages.NudgeTask(ctx, w.author, other.ID); err != nil {
			t.Fatal(err)
		}
	}
	pushed := w.count(t, `SELECT count(*) FROM events e JOIN notification_jobs j ON j.org_id=e.org_id AND j.event_seq=e.seq
		WHERE e.type='task.notified' AND e.audience_actor_id=$1 AND e.data->>'kind'='nudged'`, w.bob.ActorID)
	if pushed != 10 {
		t.Fatalf("pushed nudges = %d", pushed)
	}
	// A task on the author: nobody to nudge.
	self := w.create(t, w.author, message.CreateTaskInput{Title: "Себе", Assignee: person(w.author.ActorID)})
	_, err = w.messages.NudgeTask(ctx, w.author, self.ID)
	expectErr(t, err, task.ErrForbidden)
}

func TestWaitingInboxAndCounts(t *testing.T) {
	w := newWorld(t)
	ctx := context.Background()
	now := w.clock.Now()
	soon, later := now.Add(2*time.Hour), now.Add(72*time.Hour)
	responsible := w.create(t, w.author, message.CreateTaskInput{Title: "Ответственная", Assignee: person(w.alice.ActorID), DueAt: &later})
	itemOnly := w.create(t, w.author, message.CreateTaskInput{Title: "Пункт", Assignee: person(w.bob.ActorID),
		Items: []task.ItemInput{{Text: "a", AssigneeID: &w.alice.ActorID}}, DueAt: &soon})
	noDue := w.create(t, w.author, message.CreateTaskInput{Title: "Без срока", Assignee: person(w.alice.ActorID)})
	dueRequest := now.Add(30 * time.Hour)
	req, _, err := w.messages.CreateRequest(ctx, w.author, w.chatID, message.CreateRequestInput{
		ClientMsgID: uuid.NewString(), Body: "Будете?", Audience: requestPeople(w.alice.ActorID), Answer: requestAck(), DueAt: &dueRequest,
	})
	if err != nil {
		t.Fatal(err)
	}
	// Someone else's task in another chat must not leak.
	if _, _, err := w.messages.CreateTask(ctx, w.author, w.otherID, message.CreateTaskInput{ClientMsgID: uuid.NewString(), Title: "Чужой чат", Assignee: person(w.outsider.ActorID), RemindBeforeDue: ptr(false)}); err != nil {
		t.Fatal(err)
	}
	items := w.waiting(t, w.alice, "all")
	var order []string
	for _, item := range items {
		order = append(order, item.Message.ID)
	}
	want := []string{itemOnly.ID, req.ID, responsible.ID, noDue.ID}
	if !slices.Equal(order, want) {
		t.Fatalf("order = %v, want %v", order, want)
	}
	if items[0].Kind != "task" || *items[0].MyRole != "item" || items[1].Kind != "request" || items[1].Request == nil || items[1].Viewer == nil || items[1].MyRole != nil ||
		*items[2].MyRole != "responsible" || items[0].Chat.ID != w.chatID || items[0].Author.ActorID != w.author.ActorID {
		t.Fatalf("items = %+v", items)
	}
	if len(w.waiting(t, w.alice, "requests")) != 1 || len(w.waiting(t, w.alice, "tasks")) != 3 {
		t.Fatal("kind filter")
	}
	for _, item := range w.waiting(t, w.author, "all") {
		t.Fatalf("author sees %v", item.Message.ID)
	}
	snapshot := w.unread(t, w.alice)
	if snapshot.TasksMineOpenTotal != 3 || snapshot.TasksMineHotTotal != 1 {
		t.Fatalf("totals = %d/%d", snapshot.TasksMineOpenTotal, snapshot.TasksMineHotTotal)
	}
	for _, chat := range snapshot.Chats {
		if chat.ChatID == w.chatID && (chat.TasksMineOpen != 3 || chat.TasksMineNextDueAt == nil || !chat.TasksMineNextDueAt.Equal(soon)) {
			t.Fatalf("chat counts = %+v", chat)
		}
	}
	// listMyTasks and listChatTasks agree.
	mine, err := w.messages.ListMyTasks(ctx, w.alice, task.MineListOptions{})
	if err != nil || len(mine.Items) != 3 || mine.Items[0].Message.ID != itemOnly.ID || mine.Items[0].MyRole != "item" {
		t.Fatalf("mine = %+v %v", mine, err)
	}
	authored, err := w.messages.ListMyTasks(ctx, w.author, task.MineListOptions{Role: "authored"})
	if err != nil || len(authored.Items) != 4 || authored.Items[0].MyRole != "author" {
		t.Fatalf("authored = %+v %v", authored, err)
	}
	page, err := w.messages.ListChatTasks(ctx, w.alice, w.chatID, task.ChatListOptions{})
	if err != nil || len(page.Items) != 3 || page.Counts.Open != 3 || page.Counts.Mine != 3 || page.Counts.MineHot != 1 {
		t.Fatalf("chat page = %+v %v", page.Counts, err)
	}
	if _, err := w.messages.ListChatTasks(ctx, w.outsider, w.chatID, task.ChatListOptions{}); !errors.Is(err, task.ErrNotMember) {
		t.Fatalf("outsider chat list = %v", err)
	}
	// Done: out of «Ждут вас», into «Готово за 7 дней».
	if err := w.status(t, w.author, noDue.ID, "done"); err != nil {
		t.Fatal(err)
	}
	if len(w.waiting(t, w.alice, "tasks")) != 2 {
		t.Fatal("done task waits")
	}
	done, err := w.messages.ListMyTasks(ctx, w.alice, task.MineListOptions{State: "done"})
	if err != nil || len(done.Items) != 1 || done.Items[0].Message.ID != noDue.ID {
		t.Fatalf("done = %+v %v", done, err)
	}
	closed, err := w.messages.ListChatTasks(ctx, w.alice, w.chatID, task.ChatListOptions{State: "done"})
	if err != nil || len(closed.Items) != 1 {
		t.Fatalf("chat done = %+v %v", closed, err)
	}
	// Hot boundary: due in just under 24 hours counts, just over does not.
	w.clock.Set(later.Add(-24*time.Hour - time.Minute))
	w.exec(t, `UPDATE message_tasks SET due_at = now() + interval '24 hours' - interval '1 minute' WHERE message_id=$1`, responsible.ID)
	if s := w.unread(t, w.alice); s.TasksMineHotTotal != 2 {
		t.Fatalf("hot within 24 h = %d", s.TasksMineHotTotal)
	}
	w.exec(t, `UPDATE message_tasks SET due_at = now() + interval '24 hours' + interval '1 minute' WHERE message_id=$1`, responsible.ID)
	if s := w.unread(t, w.alice); s.TasksMineHotTotal != 1 {
		t.Fatalf("hot beyond 24 h = %d", s.TasksMineHotTotal)
	}
	// The deactivated responsible person sees nothing; archive hides all.
	w.exec(t, `UPDATE chats SET archived_at=now() WHERE id=$1`, w.chatID)
	if len(w.waiting(t, w.alice, "all")) != 0 || w.unread(t, w.alice).TasksMineOpenTotal != 0 {
		t.Fatal("archived chat in «Ждут вас»")
	}
	expectErr(t, w.status(t, w.author, responsible.ID, "done"), task.ErrChatArchived)
	w.exec(t, `UPDATE chats SET archived_at=NULL WHERE id=$1`, w.chatID)
	w.exec(t, `DELETE FROM chat_members WHERE chat_id=$1 AND actor_id=$2`, w.chatID, w.alice.ActorID)
	if len(w.waiting(t, w.alice, "all")) != 0 || w.unread(t, w.alice).TasksMineOpenTotal != 0 {
		t.Fatal("a member who left still waits")
	}
	if got := w.load(t, responsible.ID); got.Assignee.InChat {
		t.Fatal("in_chat of a responsible person who left")
	}
}

func TestMessageDeletion(t *testing.T) {
	w := newWorld(t)
	ctx := context.Background()
	due := w.clock.Now().Add(5 * time.Hour)
	item := w.create(t, w.author, message.CreateTaskInput{Title: "Секретное название", Description: "секретное описание", Assignee: person(w.alice.ActorID), DueAt: &due, RemindBeforeDue: ptr(true),
		Items: []task.ItemInput{{Text: "секретный пункт"}}})
	soon, _ := w.jobs.one(t, task.KindDueSoon, item.ID)
	overdue, _ := w.jobs.one(t, task.KindOverdue, item.ID)
	before := w.maxSeq(t)
	if _, err := w.messages.Delete(ctx, w.author, item.ID); err != nil {
		t.Fatal(err)
	}
	got := w.load(t, item.ID)
	if got.Status != "canceled" || *got.CanceledReason != "message_deleted" || got.Title != "" || len(got.Items) != 0 {
		t.Fatalf("deleted task = %+v", got)
	}
	if !w.jobs.cancelled[soon] || !w.jobs.cancelled[overdue] {
		t.Fatal("jobs of a deleted task stay")
	}
	if len(w.waiting(t, w.alice, "all")) != 0 {
		t.Fatal("deleted task waits")
	}
	if w.count(t, `SELECT count(*) FROM events WHERE seq > $1 AND type IN ('message.deleted','task.updated')`, before) != 2 {
		t.Fatal("deletion events")
	}
	// A replay of every frame, old ones included, shows none of the texts.
	frames, err := eventlog.NewStore(w.pool).Replay(ctx, w.bob, "", 0, w.maxSeq(t), 1000)
	if err != nil {
		t.Fatal(err)
	}
	for _, frame := range frames {
		if strings.Contains(string(frame.Data), "секрет") {
			t.Fatalf("%s frame leaks a deleted task: %s", frame.Type, frame.Data)
		}
	}
	_, err = w.messages.GetTask(ctx, w.alice, item.ID)
	expectErr(t, err, task.ErrNotFound)
	expectErr(t, w.status(t, w.author, item.ID, "done"), task.ErrNotFound)
}

// task.notified carries ids, the kind and the due date only; task.updated
// is stored without texts and built when the frame is.
func TestNoticesCarryNoText(t *testing.T) {
	w := newWorld(t)
	ctx := context.Background()
	due := w.clock.Now().Add(5 * time.Hour)
	item := w.create(t, w.author, message.CreateTaskInput{Title: "ТАЙНА-название", Description: "ТАЙНА-описание", Assignee: person(w.alice.ActorID), DueAt: &due,
		Items: []task.ItemInput{{Text: "ТАЙНА-пункт", AssigneeID: &w.bob.ActorID}}})
	if _, err := w.messages.NudgeTask(ctx, w.author, item.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := w.messages.UpdateTaskItem(ctx, w.alice, item.ID, item.Task.Items[0].ID, task.UpdateItemInput{AssigneeID: task.OptionalString{Set: true, Value: &w.carol.ActorID}}); err != nil {
		t.Fatal(err)
	}
	if err := w.status(t, w.alice, item.ID, "done"); err != nil {
		t.Fatal(err)
	}
	rows, err := w.pool.Query(ctx, `SELECT type, data FROM events WHERE org_id=$1 AND type IN ('task.notified','task.updated')`, w.orgID)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	n := 0
	for rows.Next() {
		var eventType string
		var raw []byte
		if err := rows.Scan(&eventType, &raw); err != nil {
			t.Fatal(err)
		}
		n++
		if strings.Contains(string(raw), "ТАЙНА") {
			t.Fatalf("%s stores text: %s", eventType, raw)
		}
		var fields map[string]any
		_ = json.Unmarshal(raw, &fields)
		for key := range fields {
			allowed := map[string]bool{"message_id": true, "chat_id": true, "kind": true, "by_actor_id": true, "due_at": true, "version": true}
			if !allowed[key] {
				t.Fatalf("%s has field %s", eventType, key)
			}
		}
	}
	if n < 6 {
		t.Fatalf("only %d task events", n)
	}
	// In the frames: task.notified as stored, task.updated with the task.
	frames, err := eventlog.NewStore(w.pool).Replay(ctx, w.alice, "", 0, w.maxSeq(t), 1000)
	if err != nil {
		t.Fatal(err)
	}
	updates := 0
	for _, frame := range frames {
		switch frame.Type {
		case "task.notified":
			if strings.Contains(string(frame.Data), "ТАЙНА") {
				t.Fatalf("task.notified frame carries text: %s", frame.Data)
			}
		case "task.updated":
			updates++
			var data struct {
				MessageID string     `json:"message_id"`
				Task      *task.Task `json:"task"`
			}
			if err := json.Unmarshal(frame.Data, &data); err != nil || data.Task == nil || data.Task.Title != "ТАЙНА-название" || data.MessageID != item.ID {
				t.Fatalf("task.updated frame = %s", frame.Data)
			}
		}
	}
	if updates == 0 {
		t.Fatal("no task.updated frames")
	}
	// An outsider gets none of them.
	frames, err = eventlog.NewStore(w.pool).Replay(ctx, w.outsider, "", 0, w.maxSeq(t), 1000)
	if err != nil {
		t.Fatal(err)
	}
	for _, frame := range frames {
		if strings.HasPrefix(frame.Type, "task.") || strings.Contains(string(frame.Data), "ТАЙНА") {
			t.Fatalf("outsider got %s: %s", frame.Type, frame.Data)
		}
	}
}

func requestPeople(actorIDs ...string) request.AudienceInput {
	return request.AudienceInput{Kind: "people", ActorIDs: actorIDs}
}

func requestAck() request.AnswerSpec { return request.AnswerSpec{Preset: request.PresetAck} }

// 300 open tasks in one chat: the list and the counters stay fast.
func TestThreeHundredOpenTasks(t *testing.T) {
	w := newWorld(t)
	ctx := context.Background()
	for index := range 300 {
		due := w.clock.Now().Add(time.Duration(index+1) * time.Hour)
		assignee := w.alice
		if index%2 == 0 {
			assignee = w.bob
		}
		w.create(t, w.author, message.CreateTaskInput{Title: "Задача", Assignee: person(assignee.ActorID), DueAt: &due,
			Items: []task.ItemInput{{Text: "a", AssigneeID: &w.alice.ActorID}}})
	}
	start := time.Now()
	page, err := w.messages.ListChatTasks(ctx, w.alice, w.chatID, task.ChatListOptions{Limit: 100})
	if err != nil || len(page.Items) != 100 || page.Counts.Open != 300 || page.Counts.Mine != 300 {
		t.Fatalf("page = %d %+v %v", len(page.Items), page.Counts, err)
	}
	if elapsed := time.Since(start); elapsed > 2*time.Second {
		t.Fatalf("listChatTasks took %s", elapsed)
	}
	start = time.Now()
	if s := w.unread(t, w.alice); s.TasksMineOpenTotal != 300 {
		t.Fatalf("unread = %d", s.TasksMineOpenTotal)
	}
	if elapsed := time.Since(start); elapsed > time.Second {
		t.Fatalf("unread took %s", elapsed)
	}
	_, _, err = w.messages.CreateTask(ctx, w.author, w.chatID, message.CreateTaskInput{ClientMsgID: uuid.NewString(), Title: "301", Assignee: person(w.alice.ActorID), RemindBeforeDue: ptr(false)})
	expectErr(t, err, task.ErrLimitReached)
}
