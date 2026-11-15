package task_test

import (
	"context"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/comamessenger/comamessenger/core/internal/message"
	"github.com/comamessenger/comamessenger/core/internal/task"
	"github.com/google/uuid"
)

// Every task write, a River job and a message deletion run at once on the
// same task: no deadlock, no unexpected error, and the counters stay right.
func TestConcurrentActionsDoNotDeadlock(t *testing.T) {
	w := newWorld(t)
	ctx := context.Background()
	expected := []error{task.ErrNotFound, task.ErrStatusInvalid, task.ErrForbidden, task.ErrLimitReached,
		task.ErrNudgeTooSoon, message.ErrNotFound, message.ErrVersionConflict}
	for round := range 15 {
		due := w.clock.Now().Add(3 * time.Hour)
		item := w.create(t, w.author, message.CreateTaskInput{Title: "Гонка", Assignee: task.AssigneeInput{Kind: "department", DepartmentID: &w.department},
			DueAt: &due, RemindBeforeDue: ptr(true), Items: []task.ItemInput{{Text: "a", AssigneeID: &w.bob.ActorID}, {Text: "b"}, {Text: "c"}}})
		items := item.Task.Items
		jobID, _ := w.jobs.one(t, task.KindOverdue, item.ID)
		actions := []func() error{
			func() error { _, err := w.messages.TakeTask(ctx, w.alice, item.ID); return err },
			func() error { _, err := w.messages.TakeTask(ctx, w.carol, item.ID); return err },
			func() error {
				_, err := w.messages.UpdateTaskItem(ctx, w.bob, item.ID, items[0].ID, task.UpdateItemInput{Done: ptr(true)})
				return err
			},
			func() error {
				_, err := w.messages.UpdateTaskItem(ctx, w.author, item.ID, items[2].ID, task.UpdateItemInput{Position: ptr(0)})
				return err
			},
			func() error { return w.messages.DeleteTaskItem(ctx, w.admin, item.ID, items[1].ID) },
			func() error {
				_, err := w.messages.AddTaskItem(ctx, w.author, item.ID, task.AddItemInput{Text: "d"})
				return err
			},
			func() error { _, err := w.messages.NudgeTask(ctx, w.author, item.ID); return err },
			func() error {
				_, err := w.messages.SetTaskStatus(ctx, w.author, item.ID, task.StatusInput{Status: "in_progress"})
				return err
			},
			func() error {
				_, err := w.messages.UpdateTask(ctx, w.author, item.ID, task.UpdateInput{ExpectedVersion: ptr(1), Title: ptr("Новое")})
				var conflict *task.ConflictError
				if errors.As(err, &conflict) {
					return nil
				}
				return err
			},
			func() error { return w.tasks.Overdue(ctx, item.ID, jobID) },
			func() error {
				if round%3 != 0 {
					return nil
				}
				_, err := w.messages.Delete(ctx, w.author, item.ID)
				return err
			},
			func() error {
				_, _, err := w.messages.CreateTask(ctx, w.author, w.chatID, message.CreateTaskInput{ClientMsgID: uuid.NewString(), Title: "Ещё", Assignee: person(w.bob.ActorID), RemindBeforeDue: ptr(false)})
				return err
			},
			func() error {
				_, err := w.messages.WaitingInbox(ctx, w.alice, message.WaitingInboxOptions{})
				return err
			},
		}
		var group sync.WaitGroup
		errs := make(chan error, len(actions))
		for _, action := range actions {
			group.Add(1)
			go func() {
				defer group.Done()
				errs <- action()
			}()
		}
		group.Wait()
		close(errs)
		for err := range errs {
			if err == nil {
				continue
			}
			var conflict *task.ConflictError
			var snooze task.Snooze
			if errors.As(err, &conflict) || errors.As(err, &snooze) {
				continue
			}
			known := false
			for _, want := range expected {
				if errors.Is(err, want) {
					known = true
				}
			}
			if !known || strings.Contains(err.Error(), "deadlock") {
				t.Fatalf("round %d: %v", round, err)
			}
		}
		var total, done, counted, checked int
		if err := w.pool.QueryRow(ctx, `SELECT items_total, items_done,
			(SELECT count(*) FROM message_task_items WHERE message_id=$1),
			(SELECT count(*) FROM message_task_items WHERE message_id=$1 AND done_at IS NOT NULL)
			FROM message_tasks WHERE message_id=$1`, item.ID).Scan(&total, &done, &counted, &checked); err != nil {
			t.Fatal(err)
		}
		if total != counted || done != checked {
			t.Fatalf("round %d: counters %d/%d, rows %d/%d", round, total, done, counted, checked)
		}
		if w.count(t, `SELECT count(*) FROM (SELECT position FROM message_task_items WHERE message_id=$1 GROUP BY position HAVING count(*) > 1) d`, item.ID) != 0 {
			t.Fatalf("round %d: duplicate positions", round)
		}
	}
}
