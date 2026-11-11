package agenttool

import (
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/comamessenger/comamessenger/core/internal/eventlog"
	"github.com/comamessenger/comamessenger/core/internal/identity"
	"github.com/comamessenger/comamessenger/core/internal/interactive"
	"github.com/comamessenger/comamessenger/core/internal/message"
	"github.com/comamessenger/comamessenger/core/internal/permission"
	"github.com/google/uuid"
)

// An agent that only writes to a chat gets, by realtime, what message.Get
// and message.ListReactions give it: its own messages and the reactions and
// pins on them, never the people's messages, live or replayed.
func TestWriteOnlyAgentGetsOnlyItsOwnMessageEvents(t *testing.T) {
	w := newDirectWorld(t, interactive.DefaultLimits(), time.Date(2026, 11, 12, 12, 0, 0, 0, time.UTC))
	ctx := t.Context()
	if _, err := w.pool.Exec(ctx, `UPDATE agents SET write_only_chat_ids=ARRAY[$2::uuid] WHERE actor_id=$1`, w.agentID, w.groupChat); err != nil {
		t.Fatal(err)
	}
	owner := identity.User{ActorID: w.ownerID, OrgID: w.orgID, OrgRole: "owner", Status: "active", Permissions: permission.Effective("owner", nil)}
	store := eventlog.NewStore(w.pool)
	start, err := store.Current(ctx, w.orgID)
	if err != nil {
		t.Fatal(err)
	}

	secret, _, err := w.messages.Create(ctx, owner, w.groupChat, message.CreateInput{ClientMsgID: uuid.NewString(), Body: "код сейфа 4711", BodyFormat: "plain"})
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := w.messages.PutReaction(ctx, owner, secret.ID, "👍"); err != nil {
		t.Fatal(err)
	}
	if _, _, err := w.messages.PutPin(ctx, owner, secret.ID); err != nil {
		t.Fatal(err)
	}
	edited := "код сейфа 4712"
	if _, err := w.messages.Update(ctx, owner, secret.ID, message.UpdateInput{Body: edited, BodyFormat: "plain", ExpectedVersion: 1}); err != nil {
		t.Fatal(err)
	}
	runID, _, _ := w.run(t, w.groupChat, "")
	card, _, err := w.messages.CreateForAgentRun(ctx, w.agentUser, w.groupChat, message.CreateInput{ClientMsgID: uuid.NewString(), Body: "Отметьтесь", BodyFormat: "plain"}, message.AgentProvenance{RunID: runID})
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := w.messages.PutReaction(ctx, owner, card.ID, "✅"); err != nil {
		t.Fatal(err)
	}
	if _, err := w.messages.Delete(ctx, owner, secret.ID); err != nil {
		t.Fatal(err)
	}
	current, err := store.Current(ctx, w.orgID)
	if err != nil {
		t.Fatal(err)
	}

	type seen struct{ kind, subject string }
	want := []seen{{"message.created", card.ID}, {"reaction.added", card.ID}}
	live, err := store.Live(ctx, w.orgID, start, current, 100)
	if err != nil {
		t.Fatal(err)
	}
	var liveForAgent []seen
	ownerCount := 0
	for _, item := range live {
		if item.Frame.ChatID == nil || *item.Frame.ChatID != w.groupChat {
			continue
		}
		if slices.Contains(item.RecipientActorIDs, w.ownerID) {
			ownerCount++
		}
		if slices.Contains(item.RecipientActorIDs, w.agentID) {
			liveForAgent = append(liveForAgent, seen{item.Frame.Type, item.Frame.SubjectID})
		}
	}
	if !slices.Equal(liveForAgent, want) {
		t.Fatalf("live events for the write-only agent = %v, want %v", liveForAgent, want)
	}
	// People keep getting everything: 2 creates, 2 reactions, pin, update, delete.
	if ownerCount < 7 {
		t.Fatalf("owner live events in the chat = %d, want at least 7", ownerCount)
	}
	replayed, err := store.Replay(ctx, w.agentUser, "", start, current, 100)
	if err != nil {
		t.Fatal(err)
	}
	var replayForAgent []seen
	for _, frame := range replayed {
		if frame.ChatID != nil && *frame.ChatID == w.groupChat {
			replayForAgent = append(replayForAgent, seen{frame.Type, frame.SubjectID})
		}
		if strings.Contains(string(frame.Data), "4711") || strings.Contains(string(frame.Data), "4712") {
			t.Fatalf("replayed frame leaks the people's message: %s", frame.Data)
		}
	}
	if !slices.Equal(replayForAgent, want) {
		t.Fatalf("replayed events for the write-only agent = %v, want %v", replayForAgent, want)
	}

	// With the chat readable again, the agent gets the people's messages.
	if _, err := w.pool.Exec(ctx, `UPDATE agents SET write_only_chat_ids='{}' WHERE actor_id=$1`, w.agentID); err != nil {
		t.Fatal(err)
	}
	readable, err := store.Replay(ctx, w.agentUser, "", start, current, 100)
	if err != nil {
		t.Fatal(err)
	}
	var created int
	for _, frame := range readable {
		if frame.Type == "message.created" && frame.ChatID != nil && *frame.ChatID == w.groupChat {
			created++
		}
	}
	if created != 2 {
		t.Fatalf("reading agent replay message.created = %d, want 2", created)
	}
	live, err = store.Live(ctx, w.orgID, start, current, 100)
	if err != nil {
		t.Fatal(err)
	}
	for _, item := range live {
		if item.Frame.SubjectID == secret.ID && item.Frame.Type == "message.created" && !slices.Contains(item.RecipientActorIDs, w.agentID) {
			t.Fatalf("reading agent lacks the live message: %v", item.RecipientActorIDs)
		}
	}
}
