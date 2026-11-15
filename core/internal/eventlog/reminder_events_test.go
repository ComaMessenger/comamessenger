package eventlog

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/comamessenger/comamessenger/core/internal/identity"
	"github.com/comamessenger/comamessenger/core/internal/message"
	"github.com/comamessenger/comamessenger/core/internal/reminder"
	"github.com/comamessenger/comamessenger/core/internal/testdb"
)

// A personal reminder is private: every reminder.* event reaches only the
// owner's sessions, live and on replay, and carries neither the note nor the
// text. Other members — the chat owner and the message author included —
// learn nothing.
func TestReminderEventsReachOnlyTheOwner(t *testing.T) {
	pool := testdb.New(t)
	owner, member, outsider, chatID := seedEventFixture(t, pool)
	messages := message.NewService(pool, 64*1024, 100, nil)
	reminders := reminder.NewService(pool, nil, nil)
	ctx := context.Background()
	store := NewStore(pool)
	post := func() message.Message {
		target, _, err := messages.Create(ctx, owner, chatID, message.CreateInput{ClientMsgID: testID(t), Body: "secret plan", BodyFormat: "plain"})
		if err != nil {
			t.Fatal(err)
		}
		return target
	}
	target, deleted := post(), post()
	note := "private note"
	var reminderID string
	for _, step := range []struct {
		name   string
		events []string
		run    func() error
	}{
		{"create", []string{"reminder.created"}, func() error {
			item, _, err := reminders.Set(ctx, member, target.ID, reminder.SetInput{RemindAt: time.Now().Add(time.Hour), Note: &note})
			reminderID = item.ID
			return err
		}},
		{"move", []string{"reminder.updated"}, func() error {
			_, _, err := reminders.Set(ctx, member, target.ID, reminder.SetInput{RemindAt: time.Now().Add(2 * time.Hour)})
			return err
		}},
		{"fire", []string{"reminder.fired"}, func() error {
			if _, err := pool.Exec(ctx, `UPDATE message_reminders SET remind_at = now() - interval '1 minute' WHERE id = $1`, reminderID); err != nil {
				return err
			}
			return reminders.Fire(ctx, reminderID, 0)
		}},
		{"close", []string{"reminder.deleted"}, func() error { return reminders.DeleteByMessage(ctx, member, target.ID) }},
		{"message deleted", []string{"reminder.created", "message.deleted", "reminder.updated"}, func() error {
			if _, _, err := reminders.Set(ctx, member, deleted.ID, reminder.SetInput{RemindAt: time.Now().Add(time.Hour), Note: &note}); err != nil {
				return err
			}
			_, err := messages.Delete(ctx, owner, deleted.ID)
			return err
		}},
	} {
		t.Run(step.name, func(t *testing.T) {
			before, err := store.Current(ctx, owner.OrgID)
			if err != nil {
				t.Fatal(err)
			}
			if err := step.run(); err != nil {
				t.Fatal(err)
			}
			after, err := store.Current(ctx, owner.OrgID)
			if err != nil {
				t.Fatal(err)
			}
			live, err := store.Live(ctx, owner.OrgID, before, after, 10)
			if err != nil {
				t.Fatal(err)
			}
			wanted := step.events[len(step.events)-1]
			found := false
			for _, event := range live {
				if !strings.HasPrefix(event.Frame.Type, "reminder.") {
					continue
				}
				found = found || event.Frame.Type == wanted
				if got := event.RecipientActorIDs; len(got) != 1 || got[0] != member.ActorID {
					t.Fatalf("%s recipients = %v, want only the owner", event.Frame.Type, got)
				}
				if strings.Contains(string(event.Frame.Data), note) || strings.Contains(string(event.Frame.Data), "secret plan") {
					t.Fatalf("%s carries content: %s", event.Frame.Type, event.Frame.Data)
				}
			}
			if !found {
				t.Fatalf("no %s among %+v", wanted, live)
			}
			for _, other := range []identity.User{owner, outsider} {
				frames, err := store.Replay(ctx, other, "", before, after, 10)
				if err != nil {
					t.Fatal(err)
				}
				for _, frame := range frames {
					if strings.HasPrefix(frame.Type, "reminder.") {
						t.Fatalf("%s replays %s", other.OrgRole, frame.Type)
					}
				}
			}
			frames, err := store.Replay(ctx, member, "", before, after, 10)
			if err != nil {
				t.Fatal(err)
			}
			got := []string{}
			for _, frame := range frames {
				got = append(got, frame.Type)
			}
			if strings.Join(got, ",") != strings.Join(step.events, ",") {
				t.Fatalf("owner replays %v, want %v", got, step.events)
			}
		})
	}
}
