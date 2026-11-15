package away_test

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/comamessenger/comamessenger/core/internal/away"
	"github.com/comamessenger/comamessenger/core/internal/chat"
	"github.com/comamessenger/comamessenger/core/internal/eventlog"
	"github.com/comamessenger/comamessenger/core/internal/identity"
	"github.com/comamessenger/comamessenger/core/internal/message"
	"github.com/comamessenger/comamessenger/core/internal/workspace"
	"github.com/google/uuid"
)

func TestSetValidatesAndOnlyPeopleSet(t *testing.T) {
	w := newWorld(t)
	ctx := context.Background()
	field := func(err error) string {
		var invalid *away.InvalidError
		if errors.As(err, &invalid) {
			return invalid.Field
		}
		return ""
	}
	cases := []struct {
		name  string
		edit  func(*away.SetInput)
		field string
	}{
		{"unknown kind", func(in *away.SetInput) { in.Kind = "sick" }, "kind"},
		{"other without label", func(in *away.SetInput) { in.Kind = away.KindOther }, "label"},
		{"label of vacation", func(in *away.SetInput) { in.Label = ptr("Нет на месте") }, "label"},
		{"long label", func(in *away.SetInput) { in.Kind, in.Label = away.KindOther, ptr(strings.Repeat("я", 41)) }, "label"},
		{"no end", func(in *away.SetInput) { in.EndsAt = nil }, "ends_at"},
		{"end in the past", func(in *away.SetInput) { in.EndsAt = ptr(time.Now().Add(-time.Hour)) }, "ends_at"},
		{"longer than 180 days", func(in *away.SetInput) { in.EndsAt = ptr(time.Now().Add(181 * 24 * time.Hour)) }, "ends_at"},
		{"start too far", func(in *away.SetInput) {
			in.StartsAt = ptr(time.Now().Add(366 * 24 * time.Hour))
			in.EndsAt = ptr(time.Now().Add(367 * 24 * time.Hour))
		}, "starts_at"},
		{"end before start", func(in *away.SetInput) {
			in.StartsAt = ptr(time.Now().Add(48 * time.Hour))
			in.EndsAt = ptr(time.Now().Add(24 * time.Hour))
		}, "ends_at"},
		{"enabled auto-reply without text", func(in *away.SetInput) { in.Autoreply.Text = ptr("  ") }, "autoreply.text"},
		{"long auto-reply", func(in *away.SetInput) { in.Autoreply.Text = ptr(strings.Repeat("я", 501)) }, "autoreply.text"},
		{"no auto-reply", func(in *away.SetInput) { in.Autoreply = nil }, "autoreply"},
		{"no mute_push", func(in *away.SetInput) { in.MutePush = nil }, "mute_push"},
	}
	for _, item := range cases {
		input := vacation(10, nil, false)
		item.edit(&input)
		if _, err := w.service.Set(ctx, w.anna, input); field(err) != item.field {
			t.Errorf("%s: error = %v, want field %s", item.name, err, item.field)
		}
	}
	// The substitute: not the person, not an agent, not someone inactive or unknown.
	w.exec(t, `UPDATE actors SET status = 'deactivated' WHERE id = $1`, w.bob.ActorID)
	for name, substitute := range map[string]identity.User{"self": w.anna, "agent": w.bot, "deactivated": w.bob, "unknown": {ActorID: "6b1e1f8e-0000-4000-8000-000000000000"}} {
		if _, err := w.service.Set(ctx, w.anna, vacation(10, &substitute, false)); !errors.Is(err, away.ErrSubstituteInvalid) {
			t.Errorf("substitute %s: error = %v", name, err)
		}
	}
	w.exec(t, `UPDATE actors SET status = 'active' WHERE id = $1`, w.bob.ActorID)
	// Agents never set one (decision 11).
	if _, err := w.service.Set(ctx, w.bot, vacation(10, nil, false)); !errors.Is(err, away.ErrForbidden) {
		t.Fatalf("agent set: %v", err)
	}
	if w.count(t, `SELECT count(*) FROM actor_away`) != 0 {
		t.Fatal("a refused change was stored")
	}
	// «Другое» with its own text; a stale expected_version conflicts.
	other := vacation(1, nil, false)
	other.Kind, other.Label = away.KindOther, ptr(" Нет на месте ")
	first := w.set(t, w.anna, other)
	if first.Label != "Нет на месте" || first.Version != 1 || !first.Active {
		t.Fatalf("set = %+v", first)
	}
	other.ExpectedVersion = ptr(7)
	if _, err := w.service.Set(ctx, w.anna, other); !errors.Is(err, away.ErrVersionConflict) {
		t.Fatalf("stale version: %v", err)
	}
}

func TestSetKeepsThePeriodUnlessTheDatesChange(t *testing.T) {
	w := newWorld(t)
	input := vacation(10, nil, false)
	w.set(t, w.anna, input)
	var firstID string
	if err := w.pool.QueryRow(context.Background(), `SELECT id::text FROM actor_away`).Scan(&firstID); err != nil {
		t.Fatal(err)
	}
	w.post(t, w.colleague, w.annaColleague, "Привет")
	w.drain(t)
	if w.count(t, `SELECT count(*) FROM actor_away_autoreplies`) != 1 {
		t.Fatal("no auto-reply mark")
	}
	// A new text, the start left out: the running period stays, so does the mark.
	input.Autoreply.Text = ptr("Новый текст")
	second := w.set(t, w.anna, input)
	var secondID string
	if err := w.pool.QueryRow(context.Background(), `SELECT id::text FROM actor_away`).Scan(&secondID); err != nil {
		t.Fatal(err)
	}
	if secondID != firstID || second.Version != 2 || w.count(t, `SELECT count(*) FROM actor_away_autoreplies`) != 1 {
		t.Fatalf("editing the text restarted the period: %s → %s, version %d", firstID, secondID, second.Version)
	}
	// New dates: a new period, the marks start over.
	input.EndsAt = ptr(time.Now().Add(20 * 24 * time.Hour))
	third := w.set(t, w.anna, input)
	var thirdID string
	if err := w.pool.QueryRow(context.Background(), `SELECT id::text FROM actor_away`).Scan(&thirdID); err != nil {
		t.Fatal(err)
	}
	if thirdID == firstID || third.Version != 3 || w.count(t, `SELECT count(*) FROM actor_away_autoreplies`) != 0 {
		t.Fatalf("new dates kept the period: %s, version %d", thirdID, third.Version)
	}
	// Remove: 204 twice, one event.
	seq := w.seq(t)
	for range 2 {
		if err := w.service.Clear(context.Background(), w.anna); err != nil {
			t.Fatal(err)
		}
	}
	if events := w.ofType(t, seq, away.EventUpdated); len(events) != 1 || events[0].Data["away"] != nil {
		t.Fatalf("clear events = %+v", events)
	}
	if _, ok, err := w.service.Get(context.Background(), w.anna); err != nil || ok {
		t.Fatalf("get after clear: %v %v", ok, err)
	}
}

func TestAutoreplyOncePerPeerInDirectChatsOnly(t *testing.T) {
	w := newWorld(t)
	ctx := context.Background()
	w.set(t, w.anna, vacation(10, nil, false))
	// Two messages from the colleague: one auto-reply.
	w.post(t, w.colleague, w.annaColleague, "Привет")
	w.post(t, w.colleague, w.annaColleague, "Ты тут?")
	w.drain(t)
	w.post(t, w.colleague, w.annaColleague, "Ещё вопрос")
	w.drain(t)
	replies := func(chatID string) int {
		return w.count(t, `SELECT count(*) FROM messages WHERE chat_id = $1 AND actor_id = $2 AND auto_reply`, chatID, w.anna.ActorID)
	}
	if got := replies(w.annaColleague); got != 1 {
		t.Fatalf("auto-replies to the colleague = %d, want 1", got)
	}
	var body string
	var silent bool
	if err := w.pool.QueryRow(ctx, `SELECT body, silent FROM messages WHERE chat_id = $1 AND auto_reply`, w.annaColleague).Scan(&body, &silent); err != nil {
		t.Fatal(err)
	}
	if body != secret || !silent {
		t.Fatalf("auto-reply = %q silent %v", body, silent)
	}
	// The feed marks it; the owner's read cursor did not move.
	page, err := w.messages.List(ctx, w.colleague, w.annaColleague, message.ListOptions{Limit: 50})
	if err != nil {
		t.Fatal(err)
	}
	marked := 0
	for _, item := range page.Messages {
		if item.AutoReply {
			marked++
		}
	}
	if marked != 1 {
		t.Fatalf("auto_reply in the feed = %d", marked)
	}
	if w.count(t, `SELECT count(*) FROM chat_reads WHERE actor_id = $1`, w.anna.ActorID) != 0 {
		t.Fatal("the auto-reply moved the owner's read cursor")
	}
	// Not in a group, not to an agent.
	w.post(t, w.colleague, w.group, "@anna вопрос")
	w.post(t, w.bot, w.annaBot, "Я робот")
	if jobs := w.scheduler.take(); len(jobs) != 0 {
		t.Fatalf("jobs for a group or an agent: %+v", jobs)
	}
	if replies(w.group) != 0 || replies(w.annaBot) != 0 {
		t.Fatal("auto-reply in a group or to an agent")
	}
	// A job for an agent peer, however it came, does nothing.
	var awayID string
	if err := w.pool.QueryRow(ctx, `SELECT id::text FROM actor_away`).Scan(&awayID); err != nil {
		t.Fatal(err)
	}
	if err := w.service.SendAutoreply(ctx, away.AutoreplyArgs{OrgID: w.orgID, AwayID: awayID, ChatID: w.annaBot, PeerID: w.bot.ActorID}); err != nil {
		t.Fatal(err)
	}
	if replies(w.annaBot) != 0 {
		t.Fatal("auto-reply to an agent")
	}
	// No ping-pong: bob is away too; anna's auto-reply to bob does not make
	// bob's auto-reply, bob's own message does make anna's.
	w.set(t, w.bob, vacation(5, nil, false))
	w.post(t, w.bob, w.annaBob, "Пишу тебе")
	w.drain(t)
	w.drain(t)
	if got := replies(w.annaBob); got != 1 {
		t.Fatalf("anna's auto-replies to bob = %d", got)
	}
	if got := w.count(t, `SELECT count(*) FROM messages WHERE chat_id = $1 AND actor_id = $2 AND auto_reply`, w.annaBob, w.bob.ActorID); got != 0 {
		t.Fatalf("bob answered anna's auto-reply %d times", got)
	}
	// An archived chat gets none.
	w.exec(t, `UPDATE chats SET archived_at = now() WHERE id = $1`, w.annaBoss)
	if err := w.service.SendAutoreply(ctx, away.AutoreplyArgs{OrgID: w.orgID, AwayID: awayID, ChatID: w.annaBoss, PeerID: w.boss.ActorID}); err != nil {
		t.Fatal(err)
	}
	if replies(w.annaBoss) != 0 {
		t.Fatal("auto-reply into an archived chat")
	}
	// A planned status and a disabled auto-reply answer nobody.
	w.exec(t, `UPDATE chats SET archived_at = NULL WHERE id = $1`, w.annaBoss)
	off := vacation(10, nil, false)
	off.Autoreply.Enabled = ptr(false)
	w.set(t, w.anna, off)
	w.post(t, w.boss, w.annaBoss, "Есть минута?")
	w.drain(t)
	if replies(w.annaBoss) != 0 {
		t.Fatal("auto-reply while disabled")
	}
	planned := vacation(10, nil, false)
	planned.StartsAt, planned.EndsAt = ptr(time.Now().Add(48*time.Hour)), ptr(time.Now().Add(96*time.Hour))
	w.set(t, w.anna, planned)
	w.post(t, w.boss, w.annaBoss, "А сейчас?")
	w.drain(t)
	if replies(w.annaBoss) != 0 {
		t.Fatal("auto-reply before the start")
	}
}

func TestAutoreplyTextAndPrivateSettingsDoNotLeak(t *testing.T) {
	w := newWorld(t)
	ctx := context.Background()
	seq := w.seq(t)
	w.set(t, w.anna, vacation(10, &w.marina, true))
	w.post(t, w.colleague, w.annaColleague, "Привет")
	w.drain(t)
	// No event but the auto-reply message itself carries the text; no away
	// event carries mute_push or the auto-reply at all.
	for _, item := range w.eventsAfter(t, seq) {
		if strings.Contains(item.Raw, "SECRET") {
			t.Errorf("%s carries the auto-reply text: %s", item.Type, item.Raw)
		}
		if strings.HasPrefix(item.Type, "actor.away") || strings.HasPrefix(item.Type, "away.") {
			for _, key := range []string{"autoreply", "autoreply_text", "mute_push", "text"} {
				if strings.Contains(item.Raw, `"`+key+`"`) {
					t.Errorf("%s carries %s: %s", item.Type, key, item.Raw)
				}
			}
		}
	}
	updated := w.ofType(t, seq, away.EventUpdated)
	if len(updated) != 1 || updated[0].Audience != nil || updated[0].ChatID != nil {
		t.Fatalf("actor.away.updated = %+v", updated)
	}
	// Frames: marina and bob replay everything they may see; the text is
	// nowhere. The colleague sees it only as anna's message in their chat.
	store := eventlog.NewStore(w.pool)
	high := w.seq(t)
	for _, reader := range []identity.User{w.marina, w.bob, w.boss} {
		frames, err := store.Replay(ctx, reader, "", 0, high, 1000)
		if err != nil {
			t.Fatal(err)
		}
		encoded, _ := json.Marshal(frames)
		if strings.Contains(string(encoded), "SECRET") || strings.Contains(string(encoded), "mute_push") {
			t.Fatalf("frames of %s leak the private settings", reader.ActorID)
		}
	}
	frames, err := store.Replay(ctx, w.colleague, "", 0, high, 1000)
	if err != nil {
		t.Fatal(err)
	}
	encoded, _ := json.Marshal(frames)
	if !strings.Contains(string(encoded), `"auto_reply":true`) {
		t.Fatalf("the colleague's frame of the auto-reply is not marked: %s", encoded)
	}
	// Every read of people: no text, no mute_push.
	chats := chat.NewService(w.pool)
	reads := map[string]any{}
	page, err := chats.ListActors(ctx, w.bob, "", "", 100)
	if err != nil {
		t.Fatal(err)
	}
	reads["actors"] = page
	// bob's direct chat with anna: bob did not write, so no auto-reply.
	direct, err := chats.Get(ctx, w.bob, w.annaBob)
	if err != nil {
		t.Fatal(err)
	}
	reads["direct"] = direct
	members, err := chats.ListMembers(ctx, w.bob, w.group)
	if err != nil {
		t.Fatal(err)
	}
	reads["members"] = members
	people, err := workspace.NewRepository(w.pool).Members(ctx, w.orgID)
	if err != nil {
		t.Fatal(err)
	}
	reads["workspace"] = people
	substituting, err := w.service.Substituting(ctx, w.marina)
	if err != nil {
		t.Fatal(err)
	}
	reads["substituting"] = substituting
	user, err := identity.NewRepository(w.pool).FindUserByEmail(ctx, "anna@example.test")
	if err != nil {
		t.Fatal(err)
	}
	reads["me"] = user
	for name, value := range reads {
		encoded, _ := json.Marshal(value)
		if strings.Contains(string(encoded), "SECRET") || strings.Contains(string(encoded), "mute_push") || strings.Contains(string(encoded), "autoreply") {
			t.Errorf("%s leaks the private settings: %s", name, encoded)
		}
		if !strings.Contains(string(encoded), `"notifications_off":true`) {
			t.Errorf("%s has no away: %s", name, encoded)
		}
	}
	// Only the owner reads them.
	own, ok, err := w.service.Get(ctx, w.anna)
	if err != nil || !ok || own.Autoreply.Text != secret || !own.MutePush || own.SubstituteID == nil {
		t.Fatalf("owner's get = %+v %v %v", own, ok, err)
	}
	if _, ok, _ := w.service.Get(ctx, w.boss); ok {
		t.Fatal("someone else's get found a status")
	}
}

func TestSubstituteIsShownWhileAvailable(t *testing.T) {
	w := newWorld(t)
	ctx := context.Background()
	chats := chat.NewService(w.pool)
	seq := w.seq(t)
	w.set(t, w.anna, vacation(10, &w.marina, false))
	assigned := w.ofType(t, seq, away.EventSubstituteAssigned)
	if len(assigned) != 1 || assigned[0].Audience == nil || *assigned[0].Audience != w.marina.ActorID {
		t.Fatalf("assigned = %+v", assigned)
	}
	if w.count(t, `SELECT count(*) FROM notification_jobs WHERE org_id = $1`, w.orgID) != 1 {
		t.Fatal("no push job for the substitute")
	}
	list, err := w.service.Substituting(ctx, w.marina)
	if err != nil || len(list.Items) != 1 || list.Items[0].ActorID != w.anna.ActorID {
		t.Fatalf("substituting = %+v %v", list, err)
	}
	substituteOf := func() *string {
		t.Helper()
		direct, err := chats.Get(ctx, w.colleague, w.annaColleague)
		if err != nil {
			t.Fatal(err)
		}
		if direct.DirectPeer == nil || direct.DirectPeer.Away == nil {
			t.Fatalf("direct peer has no away: %+v", direct.DirectPeer)
		}
		return direct.DirectPeer.Away.SubstituteID
	}
	if got := substituteOf(); got == nil || *got != w.marina.ActorID {
		t.Fatalf("substitute = %v", got)
	}
	// Marina away herself: hidden; back: shown; deactivated: hidden.
	w.set(t, w.marina, vacation(1, nil, false))
	if got := substituteOf(); got != nil {
		t.Fatal("an away substitute is shown")
	}
	if err := w.service.Clear(ctx, w.marina); err != nil {
		t.Fatal(err)
	}
	if got := substituteOf(); got == nil {
		t.Fatal("the substitute is not back")
	}
	w.exec(t, `UPDATE actors SET status = 'deactivated' WHERE id = $1`, w.marina.ActorID)
	if got := substituteOf(); got != nil {
		t.Fatal("a deactivated substitute is shown")
	}
	w.exec(t, `UPDATE actors SET status = 'active' WHERE id = $1`, w.marina.ActorID)
	// Another substitute: marina is told she is removed, bob that he is named.
	seq = w.seq(t)
	w.set(t, w.anna, vacation(10, &w.bob, false))
	removed := w.ofType(t, seq, away.EventSubstituteRemoved)
	assigned = w.ofType(t, seq, away.EventSubstituteAssigned)
	if len(removed) != 1 || *removed[0].Audience != w.marina.ActorID || len(assigned) != 1 || *assigned[0].Audience != w.bob.ActorID {
		t.Fatalf("removed %+v assigned %+v", removed, assigned)
	}
	// Removing the status tells bob.
	seq = w.seq(t)
	if err := w.service.Clear(ctx, w.anna); err != nil {
		t.Fatal(err)
	}
	if removed := w.ofType(t, seq, away.EventSubstituteRemoved); len(removed) != 1 || *removed[0].Audience != w.bob.ActorID {
		t.Fatalf("removed on clear = %+v", removed)
	}
}

func TestPlannedStatusStartsAndEndsWithTheSweep(t *testing.T) {
	w := newWorld(t)
	ctx := context.Background()
	chats := chat.NewService(w.pool)
	identities := identity.NewRepository(w.pool)
	annaSeen := func() chat.Actor {
		t.Helper()
		page, err := chats.ListActors(ctx, w.bob, "anna", "", 10)
		if err != nil || len(page.Actors) != 1 {
			t.Fatalf("actors = %+v %v", page, err)
		}
		return page.Actors[0]
	}
	planned := vacation(10, &w.marina, false)
	planned.StartsAt = ptr(time.Now().Add(48 * time.Hour))
	status := w.set(t, w.anna, planned)
	if status.Active {
		t.Fatal("a planned status is active")
	}
	seen := annaSeen()
	if seen.Away == nil || seen.Away.Active || seen.StatusEmoji != "🎯" {
		t.Fatalf("planned: %+v / %+v", seen, seen.Away)
	}
	// The start comes: the sweep announces it once.
	w.exec(t, `UPDATE actor_away SET starts_at = now() - interval '1 minute', ends_at = now() + interval '3 days'`)
	seq := w.seq(t)
	if _, err := w.service.Sweep(ctx, time.Now()); err != nil {
		t.Fatal(err)
	}
	if _, err := w.service.Sweep(ctx, time.Now()); err != nil {
		t.Fatal(err)
	}
	started := w.ofType(t, seq, away.EventUpdated)
	if len(started) != 1 || started[0].Data["away"].(map[string]any)["active"] != true {
		t.Fatalf("start events = %+v", started)
	}
	seen = annaSeen()
	if seen.StatusEmoji != "🌴" || !strings.HasPrefix(seen.StatusText, "В отпуске до ") || seen.StatusExpiresAt == nil {
		t.Fatalf("others see %q %q", seen.StatusEmoji, seen.StatusText)
	}
	// The person sees her own custom status.
	me, err := identities.FindUserByEmail(ctx, "anna@example.test")
	if err != nil || me.StatusEmoji != "🎯" || me.StatusText != "Готовлю отчёт" || me.Away == nil || !me.Away.Active {
		t.Fatalf("own user = %+v %v", me, err)
	}
	// presence filters.
	absent, err := chats.ListActors(ctx, w.bob, "", "", 100, chat.PresenceAway)
	if err != nil || len(absent.Actors) != 1 || absent.Actors[0].ID != w.anna.ActorID {
		t.Fatalf("presence=away: %+v %v", absent, err)
	}
	here, err := chats.ListActors(ctx, w.bob, "", "", 100, chat.PresenceHere)
	if err != nil || len(here.Actors) != 5 {
		t.Fatalf("presence=here: %d %v", len(here.Actors), err)
	}
	if _, err := chats.ListActors(ctx, w.bob, "", "", 100, "sick"); !errors.Is(err, chat.ErrInvalid) {
		t.Fatalf("presence=sick: %v", err)
	}
	// The end: removed, null event, the substitute told, the custom status back.
	w.exec(t, `UPDATE actor_away SET starts_at = now() - interval '2 days', ends_at = now() - interval '1 minute'`)
	seq = w.seq(t)
	if _, err := w.service.Sweep(ctx, time.Now()); err != nil {
		t.Fatal(err)
	}
	ended := w.ofType(t, seq, away.EventUpdated)
	removed := w.ofType(t, seq, away.EventSubstituteRemoved)
	if len(ended) != 1 || ended[0].Data["away"] != nil || len(removed) != 1 {
		t.Fatalf("end events %+v %+v", ended, removed)
	}
	if w.count(t, `SELECT count(*) FROM actor_away`) != 0 {
		t.Fatal("the ended status is kept")
	}
	seen = annaSeen()
	if seen.Away != nil || seen.StatusEmoji != "🎯" || seen.StatusText != "Готовлю отчёт" {
		t.Fatalf("after the end: %+v", seen)
	}
}

func TestDeactivationRemovesTheStatus(t *testing.T) {
	w := newWorld(t)
	w.set(t, w.anna, vacation(10, nil, false))
	w.exec(t, `UPDATE actors SET status = 'deactivated' WHERE id = $1`, w.anna.ActorID)
	if _, err := w.service.Sweep(context.Background(), time.Now()); err != nil {
		t.Fatal(err)
	}
	if w.count(t, `SELECT count(*) FROM actor_away`) != 0 {
		t.Fatal("a deactivated person keeps the status")
	}
}

func TestStatusTextForOlderClients(t *testing.T) {
	w := newWorld(t)
	var text string
	query := `SELECT actor_away_status_text($1, $2, $3::timestamptz, 'Europe/Moscow', $4::timestamptz)`
	for _, item := range []struct {
		kind, label, ends, at, want string
	}{
		{"vacation", "", "2026-11-30T21:00:00Z", "2026-11-20T09:00:00Z", "В отпуске до 30 ноября"},
		{"appointment", "", "2026-11-20T11:00:00Z", "2026-11-20T09:00:00Z", "На приёме до 14:00"},
		{"other", "Нет на месте", "2026-12-02T15:00:00Z", "2026-11-20T09:00:00Z", "Нет на месте до 2 декабря, 18:00"},
	} {
		if err := w.pool.QueryRow(context.Background(), query, item.kind, item.label, item.ends, item.at).Scan(&text); err != nil {
			t.Fatal(err)
		}
		if text != item.want {
			t.Errorf("%s = %q, want %q", item.kind, text, item.want)
		}
	}
	// An unknown time zone does not break the read.
	if err := w.pool.QueryRow(context.Background(), `SELECT actor_away_status_text('trip', '', now() + interval '1 hour', 'Mars/Olympus', now())`).Scan(&text); err != nil || !strings.HasPrefix(text, "На выезде до ") {
		t.Fatalf("unknown zone: %q %v", text, err)
	}
}

func TestParallelMessagesMakeOneAutoreply(t *testing.T) {
	w := newWorld(t)
	ctx := context.Background()
	w.set(t, w.anna, vacation(10, nil, false))
	var wg sync.WaitGroup
	for range 4 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if _, _, err := w.messages.Create(ctx, w.colleague, w.annaColleague, message.CreateInput{ClientMsgID: uuid.NewString(), Body: "Срочно", BodyFormat: "plain"}); err != nil {
				t.Error(err)
			}
		}()
	}
	wg.Wait()
	jobs := w.scheduler.take()
	if len(jobs) == 0 {
		t.Fatal("no job scheduled")
	}
	errs := make(chan error, len(jobs)*2+2)
	for _, job := range append(jobs, jobs...) {
		wg.Add(1)
		go func() {
			defer wg.Done()
			errs <- w.service.SendAutoreply(ctx, job)
		}()
	}
	// Meanwhile anna edits her status and the sweep runs: no deadlock.
	wg.Add(2)
	go func() {
		defer wg.Done()
		input := vacation(10, nil, false)
		input.Autoreply.Text = ptr("Другой текст")
		_, err := w.service.Set(ctx, w.anna, input)
		errs <- err
	}()
	go func() {
		defer wg.Done()
		_, err := w.service.Sweep(ctx, time.Now())
		errs <- err
	}()
	wg.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatal(err)
		}
	}
	if got := w.count(t, `SELECT count(*) FROM messages WHERE chat_id = $1 AND auto_reply`, w.annaColleague); got != 1 {
		t.Fatalf("auto-replies = %d, want 1", got)
	}
}

func TestDailyAutoreplyLimit(t *testing.T) {
	w := newWorld(t)
	w.set(t, w.anna, vacation(10, nil, false))
	w.exec(t, `INSERT INTO messages (id, org_id, chat_id, actor_id, client_msg_id, create_fingerprint, body, body_format, created_seq, auto_reply)
		SELECT gen_random_uuid(), $1, $2, $3, gen_random_uuid(), decode(repeat('00', 32), 'hex'), 'x', 'plain', 1000000 + g, true FROM generate_series(1, $4::int) g`,
		w.orgID, w.annaBob, w.anna.ActorID, away.DailyAutoreplyLimit)
	w.post(t, w.colleague, w.annaColleague, "Привет")
	w.drain(t)
	if got := w.count(t, `SELECT count(*) FROM messages WHERE chat_id = $1 AND auto_reply`, w.annaColleague); got != 0 {
		t.Fatalf("auto-replies over the daily limit = %d", got)
	}
}
