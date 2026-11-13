package eventlog

import (
	"context"
	"testing"

	"github.com/comamessenger/comamessenger/core/internal/identity"
	"github.com/comamessenger/comamessenger/core/internal/message"
	"github.com/comamessenger/comamessenger/core/internal/testdb"
)

// Saving a message to «Important» is private: the event reaches only the
// saver's sessions, live and on replay, never other members of the chat.
// (Kept here: the message package cannot import eventlog in its tests.)
func TestSavedEventsReachOnlyTheSaver(t *testing.T) {
	pool := testdb.New(t)
	owner, member, outsider, chatID := seedEventFixture(t, pool)
	service := message.NewService(pool, 64*1024, 100, nil)
	ctx := context.Background()
	store := NewStore(pool)

	target, _, err := service.Create(ctx, owner, chatID, message.CreateInput{
		ClientMsgID: testID(t), Body: "remember me", BodyFormat: "plain",
	})
	if err != nil {
		t.Fatal(err)
	}
	for _, step := range []struct {
		name  string
		event string
		run   func() error
	}{
		{"save", "message.saved", func() error {
			_, _, err := service.SaveMessage(ctx, member, target.ID)
			return err
		}},
		{"unsave", "message.unsaved", func() error {
			_, err := service.UnsaveMessage(ctx, member, target.ID)
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
			if err != nil || len(live) != 1 {
				t.Fatalf("Live() = %+v, %v", live, err)
			}
			if got := live[0].RecipientActorIDs; len(got) != 1 || got[0] != member.ActorID {
				t.Fatalf("recipients = %v, want only the saver", got)
			}
			for _, other := range []identity.User{owner, outsider} {
				frames, err := store.Replay(ctx, other, "", before, after, 10)
				if err != nil || len(frames) != 0 {
					t.Fatalf("Replay() for %s = %+v, %v; want nothing", other.OrgRole, frames, err)
				}
			}
			frames, err := store.Replay(ctx, member, "", before, after, 10)
			if err != nil || len(frames) != 1 || frames[0].Type != step.event {
				t.Fatalf("Replay() for the saver = %+v, %v; want %s", frames, err, step.event)
			}
		})
	}
}
