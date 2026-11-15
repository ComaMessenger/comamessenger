package reminder_test

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/comamessenger/comamessenger/core/internal/api"
	"github.com/comamessenger/comamessenger/core/internal/identity"
	"github.com/comamessenger/comamessenger/core/internal/reminder"
	"github.com/google/uuid"
)

func TestSetCreatesOneReminderPerMessageAndMovesIt(t *testing.T) {
	w := newWorld(t)
	ctx := context.Background()
	target := w.post(t, w.chatID, "Планёрка в понедельник")
	before := w.seq(t)

	first, created, err := w.service.Set(ctx, w.member, target.ID, reminder.SetInput{RemindAt: time.Now().Add(time.Hour), Note: ptr("позвонить")})
	if err != nil || !created || first.State != reminder.StatePending || first.Note != "позвонить" || first.Version != 1 ||
		first.ChatID != w.chatID || first.MessageID == nil || *first.MessageID != target.ID {
		t.Fatalf("Set() = %+v, %v, %v", first, created, err)
	}
	// Setting again moves the same reminder; an absent note keeps the note.
	moved, created, err := w.service.Set(ctx, w.member, target.ID, reminder.SetInput{RemindAt: time.Now().Add(2 * time.Hour)})
	if err != nil || created || moved.ID != first.ID || moved.Version != 2 || moved.Note != "позвонить" {
		t.Fatalf("second Set() = %+v, %v, %v", moved, created, err)
	}
	// The same time and note again change nothing and emit nothing.
	seq := w.seq(t)
	same, created, err := w.service.Set(ctx, w.member, target.ID, reminder.SetInput{RemindAt: moved.RemindAt, Note: ptr("позвонить")})
	if err != nil || created || same.Version != 2 || w.seq(t) != seq {
		t.Fatalf("repeat Set() = %+v, %v, %v; seq moved %d", same, created, err, w.seq(t)-seq)
	}
	// An empty note removes it.
	cleared, _, err := w.service.Set(ctx, w.member, target.ID, reminder.SetInput{RemindAt: moved.RemindAt, Note: ptr("")})
	if err != nil || cleared.Note != "" || cleared.Version != 3 {
		t.Fatalf("clearing Set() = %+v, %v", cleared, err)
	}
	if got := w.count(t, `SELECT count(*) FROM message_reminders WHERE actor_id = $1`, w.member.ActorID); got != 1 {
		t.Fatalf("rows = %d, want one per message", got)
	}
	events := w.eventsAfter(t, before)
	if len(events) != 3 || events[0].Type != reminder.EventCreated || events[1].Type != reminder.EventUpdated || events[2].Type != reminder.EventUpdated {
		t.Fatalf("events = %+v", events)
	}
	for _, event := range events {
		// Only the owner, never the chat; no note, no text.
		if event.Audience == nil || *event.Audience != w.member.ActorID || event.ChatID != nil {
			t.Fatalf("event %s goes to %v / chat %v", event.Type, event.Audience, event.ChatID)
		}
		if strings.Contains(event.Raw, "позвонить") || strings.Contains(event.Raw, "Планёрка") || event.Data["note"] != nil {
			t.Fatalf("event carries content: %s", event.Raw)
		}
	}

	// A fired reminder moved again is pending again, with a new version.
	w.due(t, first.ID, time.Minute)
	w.fire(t, first.ID)
	if state, _, _, _ := w.load(t, first.ID); state != reminder.StateFired {
		t.Fatalf("state = %s", state)
	}
	again, _, err := w.service.Set(ctx, w.member, target.ID, reminder.SetInput{RemindAt: time.Now().Add(time.Hour)})
	if err != nil || again.State != reminder.StatePending || again.FiredAt != nil || again.Late {
		t.Fatalf("moving a fired reminder = %+v, %v", again, err)
	}
	// Colleagues keep their own reminder on the same message.
	other := w.set(t, w.colleague, target.ID, time.Hour, nil)
	if other.ID == first.ID {
		t.Fatal("two people share one reminder")
	}
}

func TestSetValidatesTimeAndNote(t *testing.T) {
	w := newWorld(t)
	ctx := context.Background()
	target := w.post(t, w.chatID, "x")
	for name, input := range map[string]reminder.SetInput{
		"in the past":        {RemindAt: time.Now().Add(-time.Minute)},
		"in 30 seconds":      {RemindAt: time.Now().Add(30 * time.Second)},
		"beyond a year":      {RemindAt: time.Now().Add(366 * 24 * time.Hour)},
		"zero":               {},
		"note of 201 runes":  {RemindAt: time.Now().Add(time.Hour), Note: ptr(strings.Repeat("я", 201))},
		"note with nul byte": {RemindAt: time.Now().Add(time.Hour), Note: ptr("a\x00b")},
	} {
		if _, _, err := w.service.Set(ctx, w.member, target.ID, input); !errors.Is(err, reminder.ErrInvalid) {
			t.Errorf("%s: error = %v, want invalid", name, err)
		}
	}
	if _, _, err := w.service.Set(ctx, w.member, "nope", reminder.SetInput{RemindAt: time.Now().Add(time.Hour)}); !errors.Is(err, reminder.ErrInvalid) {
		t.Fatalf("bad id: %v", err)
	}
	// Exactly a minute ahead, a year ahead and a 200-character note are fine.
	if _, _, err := w.service.Set(ctx, w.member, target.ID, reminder.SetInput{RemindAt: time.Now().Add(time.Minute), Note: ptr(strings.Repeat("я", 200))}); err != nil {
		t.Fatalf("one minute ahead: %v", err)
	}
	if _, _, err := w.service.Set(ctx, w.member, target.ID, reminder.SetInput{RemindAt: time.Now().Add(364 * 24 * time.Hour)}); err != nil {
		t.Fatalf("a year ahead: %v", err)
	}
	if got := w.count(t, `SELECT count(*) FROM message_reminders`); got != 1 {
		t.Fatalf("rows = %d", got)
	}
}

func TestPendingLimit(t *testing.T) {
	w := newWorld(t)
	ctx := context.Background()
	w.service.SetPendingLimit(3)
	var reminders []reminder.Reminder
	for range 3 {
		reminders = append(reminders, w.set(t, w.member, w.post(t, w.chatID, "x").ID, time.Hour, nil))
	}
	extra := w.post(t, w.chatID, "x")
	if _, _, err := w.service.Set(ctx, w.member, extra.ID, reminder.SetInput{RemindAt: time.Now().Add(time.Hour)}); !errors.Is(err, reminder.ErrLimitReached) {
		t.Fatalf("over the limit: %v", err)
	}
	// Moving a pending one is always allowed.
	if _, _, err := w.service.Set(ctx, w.member, *reminders[0].MessageID, reminder.SetInput{RemindAt: time.Now().Add(3 * time.Hour)}); err != nil {
		t.Fatalf("moving at the limit: %v", err)
	}
	// Another person has their own limit.
	w.set(t, w.colleague, extra.ID, time.Hour, nil)
	// A fired one does not count; making it pending again does.
	w.due(t, reminders[0].ID, time.Minute)
	w.fire(t, reminders[0].ID)
	w.set(t, w.member, extra.ID, time.Hour, nil)
	if _, _, err := w.service.Set(ctx, w.member, *reminders[0].MessageID, reminder.SetInput{RemindAt: time.Now().Add(time.Hour)}); !errors.Is(err, reminder.ErrLimitReached) {
		t.Fatalf("re-arming over the limit: %v", err)
	}
	if _, err := w.service.Update(ctx, w.member, reminders[0].ID, reminder.SetInput{RemindAt: time.Now().Add(time.Hour)}); !errors.Is(err, reminder.ErrLimitReached) {
		t.Fatalf("re-arming by id over the limit: %v", err)
	}
	// Closing one frees a place.
	if err := w.service.DeleteByMessage(ctx, w.member, extra.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := w.service.Update(ctx, w.member, reminders[0].ID, reminder.SetInput{RemindAt: time.Now().Add(time.Hour)}); err != nil {
		t.Fatalf("re-arming after closing one: %v", err)
	}
}

func TestRemindersArePrivate(t *testing.T) {
	w := newWorld(t)
	ctx := context.Background()
	target := w.post(t, w.chatID, "secret")
	mine := w.set(t, w.member, target.ID, time.Hour, ptr("my note"))

	// Nobody else lists, reads the bell of, changes or removes it: not the
	// chat owner, not a colleague, not a workspace admin outside the chat.
	for _, other := range []identity.User{w.owner, w.colleague, w.outsider} {
		for _, state := range []string{reminder.StatePending, reminder.StateFired} {
			page, err := w.service.List(ctx, other, reminder.ListOptions{State: state})
			if err != nil || len(page.Items) != 0 {
				t.Fatalf("%s lists %+v, %v", other.OrgRole, page.Items, err)
			}
		}
		if _, err := w.service.Update(ctx, other, mine.ID, reminder.SetInput{RemindAt: time.Now().Add(2 * time.Hour), Note: ptr("hacked")}); !errors.Is(err, reminder.ErrNotFound) {
			t.Fatalf("%s Update() = %v, want not found", other.OrgRole, err)
		}
		before := w.seq(t)
		if err := w.service.Delete(ctx, other, mine.ID); err != nil {
			t.Fatalf("%s Delete() = %v, want silent success", other.OrgRole, err)
		}
		if err := w.service.DeleteByMessage(ctx, other, target.ID); err != nil {
			t.Fatalf("%s DeleteByMessage() = %v", other.OrgRole, err)
		}
		if w.seq(t) != before {
			t.Fatalf("%s: a no-op delete wrote an event", other.OrgRole)
		}
	}
	for _, other := range []identity.User{w.owner, w.colleague} {
		ids, err := w.service.IDs(ctx, other, w.chatID)
		if err != nil || len(ids) != 0 {
			t.Fatalf("%s IDs() = %v, %v", other.OrgRole, ids, err)
		}
	}
	// Outside the chat: no bell, no reminder on its messages.
	if _, err := w.service.IDs(ctx, w.outsider, w.chatID); !errors.Is(err, reminder.ErrNotFound) {
		t.Fatalf("outsider IDs() = %v", err)
	}
	if _, _, err := w.service.Set(ctx, w.outsider, target.ID, reminder.SetInput{RemindAt: time.Now().Add(time.Hour)}); !errors.Is(err, reminder.ErrNotFound) {
		t.Fatalf("outsider Set() = %v", err)
	}
	// Unknown and malformed ids.
	if _, _, err := w.service.Set(ctx, w.member, uuid.NewString(), reminder.SetInput{RemindAt: time.Now().Add(time.Hour)}); !errors.Is(err, reminder.ErrNotFound) {
		t.Fatalf("unknown message: %v", err)
	}
	if err := w.service.Delete(ctx, w.member, "not-a-uuid"); err != nil {
		t.Fatalf("malformed delete: %v", err)
	}
	state, _, version, ok := w.load(t, mine.ID)
	if !ok || state != reminder.StatePending || version != 1 {
		t.Fatalf("someone else changed the reminder: %s v%d %v", state, version, ok)
	}
	page, err := w.service.List(ctx, w.member, reminder.ListOptions{})
	if err != nil || len(page.Items) != 1 || page.Items[0].Note != "my note" {
		t.Fatalf("owner list = %+v, %v", page, err)
	}
	ids, err := w.service.IDs(ctx, w.member, w.chatID)
	if err != nil || len(ids) != 1 || ids[0].MessageID != target.ID {
		t.Fatalf("owner IDs() = %+v, %v", ids, err)
	}
}

func TestListOrderAndPages(t *testing.T) {
	w := newWorld(t)
	ctx := context.Background()
	var ids []string
	for index := range 5 {
		item := w.set(t, w.member, w.post(t, w.chatID, "x").ID, time.Duration(5-index)*time.Hour, nil)
		ids = append([]string{item.ID}, ids...) // soonest first
	}
	var got []string
	var cursor *string
	for {
		page, err := w.service.List(ctx, w.member, reminder.ListOptions{State: reminder.StatePending, Cursor: cursor, Limit: 2})
		if err != nil {
			t.Fatal(err)
		}
		for _, item := range page.Items {
			got = append(got, item.ID)
		}
		if page.NextCursor == nil {
			break
		}
		cursor = page.NextCursor
	}
	if strings.Join(got, ",") != strings.Join(ids, ",") {
		t.Fatalf("pending order %v, want %v", got, ids)
	}
	// Fired: latest first.
	for index, reminderID := range ids[:3] {
		w.due(t, reminderID, time.Duration(10-index)*time.Minute)
		w.fire(t, reminderID)
	}
	page, err := w.service.List(ctx, w.member, reminder.ListOptions{State: reminder.StateFired, Limit: 2})
	if err != nil || len(page.Items) != 2 || page.Items[0].ID != ids[2] || page.Items[1].ID != ids[1] || page.NextCursor == nil {
		t.Fatalf("fired page = %+v, %v", page, err)
	}
	rest, err := w.service.List(ctx, w.member, reminder.ListOptions{State: reminder.StateFired, Limit: 2, Cursor: page.NextCursor})
	if err != nil || len(rest.Items) != 1 || rest.Items[0].ID != ids[0] || rest.NextCursor != nil {
		t.Fatalf("fired rest = %+v, %v", rest, err)
	}
	for name, options := range map[string]reminder.ListOptions{
		"state": {State: "all"}, "limit": {Limit: 101}, "cursor": {Cursor: ptr("@@@")},
		"cursor out of range": {Cursor: ptr(base64.RawURLEncoding.EncodeToString([]byte("-300000000000000000." + uuid.NewString())))},
	} {
		if _, err := w.service.List(ctx, w.member, options); !errors.Is(err, reminder.ErrInvalid) {
			t.Errorf("%s: %v", name, err)
		}
	}
}

func TestFire(t *testing.T) {
	w := newWorld(t)
	ctx := context.Background()
	target := w.post(t, w.chatID, "x")

	t.Run("fires once, on time, with one event and one push job", func(t *testing.T) {
		item := w.set(t, w.member, target.ID, time.Hour, ptr("note"))
		w.due(t, item.ID, time.Minute)
		before := w.seq(t)
		w.fire(t, item.ID)
		// Repeats (a River retry after a success, the sweep) do nothing.
		w.fire(t, item.ID)
		w.fire(t, item.ID)
		events := w.eventsAfter(t, before)
		if len(events) != 1 || events[0].Type != reminder.EventFired || events[0].Data["late"] != false ||
			*events[0].Audience != w.member.ActorID || events[0].ChatID != nil || strings.Contains(events[0].Raw, "note") {
			t.Fatalf("events = %+v", events)
		}
		if got := w.count(t, `SELECT count(*) FROM notification_jobs WHERE org_id = $1 AND event_seq > $2`, w.owner.OrgID, before); got != 1 {
			t.Fatalf("push jobs = %d", got)
		}
		if state, _, version, _ := w.load(t, item.ID); state != reminder.StateFired || version != 2 {
			t.Fatalf("state = %s v%d", state, version)
		}
		if err := w.service.DeleteByMessage(ctx, w.member, target.ID); err != nil {
			t.Fatal(err)
		}
	})

	t.Run("late after 15 minutes", func(t *testing.T) {
		item := w.set(t, w.member, target.ID, time.Hour, nil)
		w.due(t, item.ID, 20*time.Minute)
		before := w.seq(t)
		w.fire(t, item.ID)
		if events := w.eventsAfter(t, before); len(events) != 1 || events[0].Data["late"] != true {
			t.Fatalf("events = %+v", events)
		}
		page, _ := w.service.List(ctx, w.member, reminder.ListOptions{State: reminder.StateFired})
		if len(page.Items) != 1 || !page.Items[0].Late {
			t.Fatalf("fired list = %+v", page.Items)
		}
		if err := w.service.DeleteByMessage(ctx, w.member, target.ID); err != nil {
			t.Fatal(err)
		}
	})

	t.Run("a stale job does nothing, an early one snoozes", func(t *testing.T) {
		item := w.set(t, w.member, target.ID, time.Hour, nil)
		w.exec(t, `UPDATE message_reminders SET river_job_id = 42 WHERE id = $1`, item.ID)
		before := w.seq(t)
		// The job of an earlier time.
		if err := w.service.Fire(ctx, item.ID, 41); err != nil {
			t.Fatal(err)
		}
		// The current job, woken early by clock skew.
		var snooze reminder.Snooze
		if err := w.service.Fire(ctx, item.ID, 42); !errors.As(err, &snooze) || snooze.Delay < 50*time.Minute {
			t.Fatalf("early Fire() = %v", err)
		}
		w.due(t, item.ID, time.Second)
		if err := w.service.Fire(ctx, item.ID, 41); err != nil {
			t.Fatal(err)
		}
		if w.seq(t) != before {
			t.Fatal("a stale or early job fired")
		}
		if err := w.service.Fire(ctx, item.ID, 42); err != nil {
			t.Fatal(err)
		}
		if state, _, _, _ := w.load(t, item.ID); state != reminder.StateFired {
			t.Fatalf("state = %s", state)
		}
		if err := w.service.DeleteByMessage(ctx, w.member, target.ID); err != nil {
			t.Fatal(err)
		}
	})

	t.Run("an inactive owner's reminder goes without firing", func(t *testing.T) {
		person := identity.User{ActorID: uuid.NewString(), OrgID: w.owner.OrgID, OrgRole: "member", Status: "active"}
		w.exec(t, `INSERT INTO actors (id, org_id, type, org_role, display_name, handle) VALUES ($1, $2, 'user', 'member', 'Gone', 'gone')`, person.ActorID, person.OrgID)
		w.exec(t, `INSERT INTO chat_members (chat_id, actor_id, org_id, role) VALUES ($1, $2, $3, 'member')`, w.chatID, person.ActorID, person.OrgID)
		item := w.set(t, person, target.ID, time.Hour, ptr("note"))
		w.exec(t, `UPDATE actors SET status = 'deactivated' WHERE id = $1`, person.ActorID)
		w.due(t, item.ID, time.Minute)
		before := w.seq(t)
		w.fire(t, item.ID)
		if _, _, _, ok := w.load(t, item.ID); ok {
			t.Fatal("the reminder of an inactive person is still there")
		}
		if got := w.count(t, `SELECT count(*) FROM events WHERE org_id = $1 AND seq > $2 AND type = 'reminder.fired'`, w.owner.OrgID, before); got != 0 {
			t.Fatal("an inactive person's reminder fired")
		}
		if got := w.count(t, `SELECT count(*) FROM notification_jobs WHERE org_id = $1 AND event_seq > $2`, w.owner.OrgID, before); got != 0 {
			t.Fatal("an inactive person's reminder queued a push")
		}
	})

	t.Run("lost access does not stop it", func(t *testing.T) {
		item := w.set(t, w.colleague, target.ID, time.Hour, ptr("call back"))
		w.exec(t, `DELETE FROM chat_members WHERE chat_id = $1 AND actor_id = $2`, w.chatID, w.colleague.ActorID)
		w.due(t, item.ID, time.Minute)
		w.fire(t, item.ID)
		if state, messageID, _, _ := w.load(t, item.ID); state != reminder.StateFired || messageID == nil {
			t.Fatalf("state = %s, message = %v", state, messageID)
		}
		// Without access no new reminder on the message, but the own one
		// can still be closed.
		if _, _, err := w.service.Set(ctx, w.colleague, target.ID, reminder.SetInput{RemindAt: time.Now().Add(time.Hour)}); !errors.Is(err, reminder.ErrNotFound) {
			t.Fatalf("Set() after leaving = %v", err)
		}
		if _, err := w.service.IDs(ctx, w.colleague, w.chatID); !errors.Is(err, reminder.ErrNotFound) {
			t.Fatalf("IDs() after leaving = %v", err)
		}
		if err := w.service.DeleteByMessage(ctx, w.colleague, target.ID); err != nil {
			t.Fatal(err)
		}
		if _, _, _, ok := w.load(t, item.ID); ok {
			t.Fatal("closing after leaving did not remove it")
		}
	})
}

func TestMessageDeletion(t *testing.T) {
	w := newWorld(t)
	ctx := context.Background()
	target := w.post(t, w.chatID, "to be deleted")
	plain := w.set(t, w.member, target.ID, time.Hour, nil)
	noted := w.set(t, w.colleague, target.ID, time.Hour, ptr("ask about the budget"))
	before := w.seq(t)
	if _, err := w.messages.Delete(ctx, w.owner, target.ID); err != nil {
		t.Fatal(err)
	}
	if _, _, _, ok := w.load(t, plain.ID); ok {
		t.Fatal("a reminder without a note outlived its message")
	}
	state, messageID, version, ok := w.load(t, noted.ID)
	if !ok || messageID != nil || state != reminder.StatePending || version != 2 {
		t.Fatalf("noted reminder = %s %v v%d %v", state, messageID, version, ok)
	}
	events := w.eventsAfter(t, before)
	if len(events) != 2 {
		t.Fatalf("events = %+v", events)
	}
	for _, event := range events {
		switch event.Type {
		case reminder.EventDeleted:
			if *event.Audience != w.member.ActorID || event.Data["reason"] != reminder.ReasonMessageDeleted {
				t.Fatalf("deleted event = %+v", event)
			}
		case reminder.EventUpdated:
			if *event.Audience != w.colleague.ActorID || event.Data["message_id"] != nil {
				t.Fatalf("updated event = %+v", event)
			}
		default:
			t.Fatalf("unexpected event %s", event.Type)
		}
		if event.ChatID != nil || strings.Contains(event.Raw, "budget") {
			t.Fatalf("event leaks: %s", event.Raw)
		}
	}
	// It still fires, with its note, and can be moved or closed by id.
	if ids, err := w.service.IDs(ctx, w.colleague, w.chatID); err != nil || len(ids) != 0 {
		t.Fatalf("bell of a deleted message: %v %v", ids, err)
	}
	if _, err := w.service.Update(ctx, w.colleague, noted.ID, reminder.SetInput{RemindAt: time.Now().Add(time.Hour), Note: ptr("")}); !errors.Is(err, reminder.ErrInvalid) {
		t.Fatalf("removing the only content: %v", err)
	}
	moved, err := w.service.Update(ctx, w.colleague, noted.ID, reminder.SetInput{RemindAt: time.Now().Add(3 * time.Hour)})
	if err != nil || moved.Note != "ask about the budget" || moved.MessageID != nil {
		t.Fatalf("Update() = %+v, %v", moved, err)
	}
	w.due(t, noted.ID, time.Minute)
	w.fire(t, noted.ID)
	if state, _, _, _ := w.load(t, noted.ID); state != reminder.StateFired {
		t.Fatalf("state = %s", state)
	}
	if err := w.service.Delete(ctx, w.colleague, noted.ID); err != nil {
		t.Fatal(err)
	}
	if _, _, _, ok := w.load(t, noted.ID); ok {
		t.Fatal("Delete() kept the reminder")
	}
	// A reminder on a deleted message cannot be created.
	if _, _, err := w.service.Set(ctx, w.member, target.ID, reminder.SetInput{RemindAt: time.Now().Add(time.Hour)}); !errors.Is(err, reminder.ErrNotFound) {
		t.Fatalf("Set() on a deleted message = %v", err)
	}
}

func TestCleanup(t *testing.T) {
	w := newWorld(t)
	ctx := context.Background()
	old := w.set(t, w.member, w.post(t, w.chatID, "x").ID, time.Hour, nil)
	recent := w.set(t, w.member, w.post(t, w.chatID, "x").ID, time.Hour, nil)
	for _, item := range []reminder.Reminder{old, recent} {
		w.due(t, item.ID, time.Minute)
		w.fire(t, item.ID)
	}
	w.exec(t, `UPDATE message_reminders SET fired_at = now() - interval '91 days', remind_at = now() - interval '91 days' WHERE id = $1`, old.ID)
	// A pending reminder whose job is gone (River gave up) is fired by the sweep.
	lost := w.set(t, w.member, w.post(t, w.chatID, "x").ID, time.Hour, nil)
	w.due(t, lost.ID, 20*time.Minute)
	// A pending reminder whose time has not come yet is left alone.
	future := w.set(t, w.member, w.post(t, w.chatID, "x").ID, time.Hour, nil)
	removed, err := w.service.Cleanup(ctx)
	if err != nil || removed != 1 {
		t.Fatalf("Cleanup() = %d, %v", removed, err)
	}
	if _, _, _, ok := w.load(t, old.ID); ok {
		t.Fatal("a reminder fired 91 days ago is kept")
	}
	if state, _, _, ok := w.load(t, recent.ID); !ok || state != reminder.StateFired {
		t.Fatal("a recent fired reminder was removed")
	}
	if state, _, _, _ := w.load(t, lost.ID); state != reminder.StateFired {
		t.Fatalf("the sweep did not fire the lost reminder: %s", state)
	}
	if state, _, _, _ := w.load(t, future.ID); state != reminder.StatePending {
		t.Fatalf("the sweep fired a future reminder: %s", state)
	}
	if got := w.count(t, `SELECT count(*) FROM message_reminders WHERE id = $1 AND fired_late`, lost.ID); got != 1 {
		t.Fatal("the swept reminder is not marked late")
	}
	total, err := reminder.FiredTotal(ctx, w.pool, w.member.OrgID, w.member.ActorID)
	if err != nil || total != 2 {
		t.Fatalf("FiredTotal() = %d, %v", total, err)
	}
}

// Every reminder event this package writes decodes into the generated
// contract type without unknown fields.
func TestEventsMatchTheContract(t *testing.T) {
	w := newWorld(t)
	ctx := context.Background()
	before := w.seq(t)
	target := w.post(t, w.chatID, "x")
	noted := w.set(t, w.member, target.ID, time.Hour, ptr("n"))
	w.set(t, w.member, target.ID, 2*time.Hour, nil)
	w.set(t, w.colleague, target.ID, time.Hour, nil)
	w.due(t, noted.ID, time.Minute)
	w.fire(t, noted.ID)
	if _, err := w.messages.Delete(ctx, w.owner, target.ID); err != nil {
		t.Fatal(err)
	}
	other := w.post(t, w.chatID, "y")
	w.set(t, w.member, other.ID, time.Hour, nil)
	if err := w.service.DeleteByMessage(ctx, w.member, other.ID); err != nil {
		t.Fatal(err)
	}
	seen := map[string]bool{}
	for _, event := range w.eventsAfter(t, before) {
		seen[event.Type] = true
		decoder := json.NewDecoder(strings.NewReader(event.Raw))
		decoder.DisallowUnknownFields()
		if event.Type == reminder.EventFired {
			var data api.RealtimeReminderFiredEventV1
			if err := decoder.Decode(&data); err != nil || data.Version < 1 || data.FiredAt.IsZero() {
				t.Fatalf("%s: %v %s", event.Type, err, event.Raw)
			}
			continue
		}
		var data api.RealtimeReminderEventV1
		if err := decoder.Decode(&data); err != nil || data.Version < 1 || data.RemindAt.IsZero() {
			t.Fatalf("%s: %v %s", event.Type, err, event.Raw)
		}
		for _, field := range []string{"id", "message_id", "chat_id", "remind_at", "state", "version"} {
			if _, ok := event.Data[field]; !ok {
				t.Fatalf("%s lacks %s: %s", event.Type, field, event.Raw)
			}
		}
		if _, hasReason := event.Data["reason"]; hasReason != (event.Type == reminder.EventDeleted) {
			t.Fatalf("%s reason: %s", event.Type, event.Raw)
		}
	}
	for _, eventType := range []string{reminder.EventCreated, reminder.EventUpdated, reminder.EventDeleted, reminder.EventFired} {
		if !seen[eventType] {
			t.Errorf("no %s checked", eventType)
		}
	}
}

// Fired reminders the owner never closes are capped: firing one more drops
// the oldest, with an event, so the owner's devices follow.
func TestFiredCap(t *testing.T) {
	w := newWorld(t)
	target := w.post(t, w.chatID, "x")
	w.exec(t, `
		INSERT INTO message_reminders (id, org_id, actor_id, chat_id, note, remind_at, state, fired_at)
		SELECT gen_random_uuid(), $1, $2, $3, 'old', now() - make_interval(hours => n + 1), 'fired', now() - make_interval(hours => n)
		FROM generate_series(1, $4::int) AS n`, w.member.OrgID, w.member.ActorID, w.chatID, reminder.MaxFired)
	var oldest string
	if err := w.pool.QueryRow(context.Background(), `SELECT id FROM message_reminders WHERE actor_id = $1 ORDER BY fired_at LIMIT 1`, w.member.ActorID).Scan(&oldest); err != nil {
		t.Fatal(err)
	}
	item := w.set(t, w.member, target.ID, time.Hour, nil)
	w.due(t, item.ID, time.Minute)
	before := w.seq(t)
	w.fire(t, item.ID)
	if got := w.count(t, `SELECT count(*) FROM message_reminders WHERE actor_id = $1 AND state = 'fired'`, w.member.ActorID); got != reminder.MaxFired {
		t.Fatalf("fired kept = %d", got)
	}
	if _, _, _, ok := w.load(t, oldest); ok {
		t.Fatal("the oldest fired reminder is kept")
	}
	events := w.eventsAfter(t, before)
	if len(events) != 2 || events[0].Type != reminder.EventFired || events[1].Type != reminder.EventDeleted || events[1].Data["id"] != oldest {
		t.Fatalf("events = %+v", events)
	}
	// Someone else's fired reminders are not touched.
	if got := w.count(t, `SELECT count(*) FROM message_reminders WHERE actor_id <> $1`, w.member.ActorID); got != 0 {
		t.Fatalf("others = %d", got)
	}
}
