package reminder_test

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/comamessenger/comamessenger/core/internal/message"
	"github.com/comamessenger/comamessenger/core/internal/reminder"
	"github.com/google/uuid"
)

// TestReminderLockOrder runs every reminder write against message deletion,
// firing and writing in the chat, as TestSavedLockOrder does for saves: no
// deadlock, no error, and the invariants hold whoever wins.
func TestReminderLockOrder(t *testing.T) {
	w := newWorld(t)
	ctx := context.Background()
	const rounds = 30
	race := func(first, second func() error) (error, error) {
		var wait sync.WaitGroup
		var a, b error
		wait.Add(2)
		go func() { defer wait.Done(); a = first() }()
		go func() { defer wait.Done(); b = second() }()
		wait.Wait()
		return a, b
	}
	deleteMessage := func(messageID string) func() error {
		return func() error { _, err := w.messages.Delete(ctx, w.owner, messageID); return err }
	}

	t.Run("set races message deletion", func(t *testing.T) {
		for round := range rounds {
			target := w.post(t, w.chatID, "x")
			setErr, deleteErr := race(func() error {
				_, _, err := w.service.Set(ctx, w.member, target.ID, reminder.SetInput{RemindAt: time.Now().Add(time.Hour)})
				return err
			}, deleteMessage(target.ID))
			if (setErr != nil && !errors.Is(setErr, reminder.ErrNotFound)) || deleteErr != nil {
				t.Fatalf("round %d: set=%v delete=%v", round, setErr, deleteErr)
			}
			// Whoever won, a reminder without a note does not outlive its message.
			if got := w.count(t, `SELECT count(*) FROM message_reminders WHERE message_id = $1 OR (message_id IS NULL AND note = '')`, target.ID); got != 0 {
				t.Fatalf("round %d: %d reminders left", round, got)
			}
		}
	})

	t.Run("closing races message deletion", func(t *testing.T) {
		for round := range rounds {
			target := w.post(t, w.chatID, "x")
			w.set(t, w.member, target.ID, time.Hour, ptr("note"))
			closeErr, deleteErr := race(func() error { return w.service.DeleteByMessage(ctx, w.member, target.ID) }, deleteMessage(target.ID))
			if closeErr != nil || deleteErr != nil {
				t.Fatalf("round %d: close=%v delete=%v", round, closeErr, deleteErr)
			}
		}
		w.exec(t, `DELETE FROM message_reminders`)
	})

	t.Run("firing races message deletion", func(t *testing.T) {
		for round := range rounds {
			target := w.post(t, w.chatID, "x")
			noted := w.set(t, w.member, target.ID, time.Hour, ptr("note"))
			plain := w.set(t, w.colleague, target.ID, time.Hour, nil)
			w.due(t, noted.ID, time.Minute)
			w.due(t, plain.ID, time.Minute)
			before := w.seq(t)
			var wait sync.WaitGroup
			errs := make([]error, 3)
			wait.Add(3)
			go func() { defer wait.Done(); errs[0] = w.service.Fire(ctx, noted.ID, 0) }()
			go func() { defer wait.Done(); errs[1] = w.service.Fire(ctx, plain.ID, 0) }()
			go func() { defer wait.Done(); _, errs[2] = w.messages.Delete(ctx, w.owner, target.ID) }()
			wait.Wait()
			if err := errors.Join(errs...); err != nil {
				t.Fatalf("round %d: %v", round, err)
			}
			// The noted one fired exactly once and lost its message; the
			// plain one fired at most once and is gone.
			state, messageID, _, ok := w.load(t, noted.ID)
			if !ok || state != reminder.StateFired || messageID != nil {
				t.Fatalf("round %d: noted = %s %v %v", round, state, messageID, ok)
			}
			if _, _, _, ok := w.load(t, plain.ID); ok {
				t.Fatalf("round %d: plain reminder outlived its message", round)
			}
			fired := 0
			for _, event := range w.eventsAfter(t, before) {
				if event.Type == reminder.EventFired && event.Data["id"] == noted.ID {
					fired++
				}
			}
			if fired != 1 {
				t.Fatalf("round %d: noted fired %d times", round, fired)
			}
			w.exec(t, `DELETE FROM message_reminders`)
		}
	})

	t.Run("moving races firing", func(t *testing.T) {
		for round := range rounds {
			target := w.post(t, w.chatID, "x")
			item := w.set(t, w.member, target.ID, time.Hour, nil)
			w.due(t, item.ID, time.Minute)
			before := w.seq(t)
			moveErr, fireErr := race(func() error {
				_, _, err := w.service.Set(ctx, w.member, target.ID, reminder.SetInput{RemindAt: time.Now().Add(2 * time.Hour)})
				return err
			}, func() error { return w.service.Fire(ctx, item.ID, 0) })
			if moveErr != nil || fireErr != nil {
				t.Fatalf("round %d: move=%v fire=%v", round, moveErr, fireErr)
			}
			// Either it fired and was re-armed, or it was moved before firing:
			// both end pending, in the future.
			if state, _, _, _ := w.load(t, item.ID); state != reminder.StatePending {
				t.Fatalf("round %d: state = %s", round, state)
			}
			fired := 0
			for _, event := range w.eventsAfter(t, before) {
				if event.Type == reminder.EventFired {
					fired++
				}
			}
			if fired > 1 {
				t.Fatalf("round %d: fired %d times", round, fired)
			}
			w.exec(t, `DELETE FROM message_reminders`)
		}
	})

	t.Run("setting while writing in the same chat", func(t *testing.T) {
		for round := range rounds {
			target := w.post(t, w.chatID, "x")
			setErr, createErr := race(func() error {
				_, _, err := w.service.Set(ctx, w.member, target.ID, reminder.SetInput{RemindAt: time.Now().Add(time.Hour)})
				return err
			}, func() error {
				_, _, err := w.messages.Create(ctx, w.member, w.chatID, message.CreateInput{ClientMsgID: uuid.NewString(), Body: "y", BodyFormat: "plain"})
				return err
			})
			if setErr != nil || createErr != nil {
				t.Fatalf("round %d: set=%v create=%v", round, setErr, createErr)
			}
		}
		w.exec(t, `DELETE FROM message_reminders`)
	})

	t.Run("parallel sets of one person respect the limit exactly", func(t *testing.T) {
		w.service.SetPendingLimit(5)
		defer w.service.SetPendingLimit(reminder.DefaultPendingLimit)
		var wait sync.WaitGroup
		var mutex sync.Mutex
		set, refused := 0, 0
		for range 20 {
			target := w.post(t, w.chatID, "x")
			wait.Add(1)
			go func() {
				defer wait.Done()
				_, _, err := w.service.Set(ctx, w.colleague, target.ID, reminder.SetInput{RemindAt: time.Now().Add(time.Hour)})
				mutex.Lock()
				defer mutex.Unlock()
				switch {
				case err == nil:
					set++
				case errors.Is(err, reminder.ErrLimitReached):
					refused++
				default:
					t.Errorf("Set() = %v", err)
				}
			}()
		}
		wait.Wait()
		if set != 5 || refused != 15 {
			t.Fatalf("set=%d refused=%d, want 5 and 15", set, refused)
		}
	})
}
