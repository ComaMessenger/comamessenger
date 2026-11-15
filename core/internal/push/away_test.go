package push

import (
	"context"
	"encoding/base64"
	"io"
	"log/slog"
	"strings"
	"testing"
	"time"

	"github.com/comamessenger/comamessenger/core/internal/away"
	"github.com/comamessenger/comamessenger/core/internal/config"
	"github.com/comamessenger/comamessenger/core/internal/identity"
	"github.com/comamessenger/comamessenger/core/internal/message"
	"github.com/comamessenger/comamessenger/core/internal/reminder"
	"github.com/comamessenger/comamessenger/core/internal/request"
	"github.com/comamessenger/comamessenger/core/internal/task"
	"github.com/comamessenger/comamessenger/core/internal/testdb"
	"github.com/google/uuid"
)

// While anna is away with «Не присылать уведомления» she gets no push and
// no digest, but her own reminders (with sound) and direct messages from
// the owner (without sound). The substitute is told «Вы замещаете».
func TestAwayMutesPushExceptRemindersAndAdminDirectMessages(t *testing.T) {
	pool := testdb.New(t)
	ctx := context.Background()
	orgID := uuid.NewString()
	owner, anna, colleague, marina := uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString()
	group, ownerDirect, colleagueDirect := uuid.NewString(), uuid.NewString(), uuid.NewString()
	sessions := map[string]string{anna: uuid.NewString(), marina: uuid.NewString()}
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	for _, statement := range []struct {
		query string
		args  []any
	}{
		{`INSERT INTO organizations(id,name,slug) VALUES($1,'Away','away')`, []any{orgID}},
		{`INSERT INTO actors(id,org_id,type,org_role,display_name,handle) VALUES ($2,$1,'user','owner','Boss','boss'),($3,$1,'user','member','Anna','anna'),($4,$1,'user','member','Colleague','colleague'),($5,$1,'user','member','Marina','marina')`, []any{orgID, owner, anna, colleague, marina}},
		{`INSERT INTO users(actor_id,org_id,email,password_hash,preferences) VALUES ($2,$1,'boss@example.test','hash','{}'),($3,$1,'anna@example.test','hash','{"email_digest":true}'),($4,$1,'colleague@example.test','hash','{}'),($5,$1,'marina@example.test','hash','{}')`, []any{orgID, owner, anna, colleague, marina}},
		{`INSERT INTO sessions(id,org_id,actor_id,family_id,refresh_hash,expires_at) VALUES($3,$1,$2,$3,decode(repeat('01',32),'hex'),now()+interval '1 day'),($5,$1,$4,$5,decode(repeat('02',32),'hex'),now()+interval '1 day')`, []any{orgID, anna, sessions[anna], marina, sessions[marina]}},
		{`INSERT INTO chats(id,org_id,kind,visibility,name,created_by) VALUES($3,$1,'group','private','Team',$2)`, []any{orgID, owner, group}},
		{`INSERT INTO chats(id,org_id,kind,visibility,direct_pair_key,created_by) VALUES($3,$1,'direct','private','boss:anna',$2),($4,$1,'direct','private','colleague:anna',$2)`, []any{orgID, owner, ownerDirect, colleagueDirect}},
		{`INSERT INTO chat_members(chat_id,actor_id,org_id,role) VALUES ($2,$3,$1,'owner'),($2,$4,$1,'member'),($2,$5,$1,'member'),($6,$3,$1,'member'),($6,$4,$1,'member'),($7,$5,$1,'member'),($7,$4,$1,'member')`, []any{orgID, group, owner, anna, colleague, ownerDirect, colleagueDirect}},
	} {
		if _, err := tx.Exec(ctx, statement.query, statement.args...); err != nil {
			_ = tx.Rollback(ctx)
			t.Fatal(err)
		}
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	cfg := config.PushConfig{RelayURL: "https://relay.example.test", PollInterval: time.Second}
	keys := map[string][]byte{}
	for actor, session := range sessions {
		key := []byte(strings.Repeat(actor[:1], 32))
		keys[actor] = key
		if _, err := NewService(pool, cfg).RegisterMobileDevice(ctx, identity.User{OrgID: orgID, ActorID: actor}, session, MobileDeviceInput{
			Platform: "ios", RelayHandle: strings.Repeat(actor[:1], 43), NotificationKey: base64.StdEncoding.EncodeToString(key), AppVersion: "0.1.0",
		}); err != nil {
			t.Fatal(err)
		}
	}
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	messages := message.NewService(pool, 4096, 100, nil)
	users := map[string]identity.User{}
	for actor, role := range map[string]string{owner: "owner", anna: "member", colleague: "member", marina: "member"} {
		users[actor] = identity.User{ActorID: actor, OrgID: orgID, OrgRole: role, Status: "active"}
	}
	relay := &recordingRelay{}
	mail := &recordingEmailSender{}
	worker := NewWorker(logger, pool, cfg, nil, mail).WithRelay(relay)
	count := func(query string, args ...any) int {
		t.Helper()
		var value int
		if err := pool.QueryRow(ctx, query, args...).Scan(&value); err != nil {
			t.Fatal(err)
		}
		return value
	}
	deliveriesOf := func(actor string) int {
		return count(`SELECT count(*) FROM mobile_push_deliveries p JOIN mobile_push_devices d ON d.id=p.device_id WHERE d.actor_id=$1`, actor)
	}
	send := func(author, chatID string, mentions ...string) message.Message {
		t.Helper()
		result, _, err := messages.Create(ctx, users[author], chatID, message.CreateInput{ClientMsgID: uuid.NewString(), Body: "текст", BodyFormat: "plain", MentionedActorIDs: mentions})
		if err != nil {
			t.Fatal(err)
		}
		if err := worker.materialize(ctx); err != nil {
			t.Fatal(err)
		}
		return result
	}
	// A digest item queued before the status started is not mailed either.
	early := send(colleague, colleagueDirect)
	if count(`SELECT count(*) FROM email_digest_items WHERE actor_id=$1`, anna) != 1 {
		t.Fatal("no digest item before the status")
	}
	pool.Exec(ctx, `DELETE FROM mobile_push_deliveries`)
	_ = early

	statuses := away.NewService(pool, messages, nil, logger)
	enabled, text, mute := false, "", true
	ends := time.Now().Add(72 * time.Hour)
	if _, err := statuses.Set(ctx, users[anna], away.SetInput{
		Kind: away.KindVacation, EndsAt: &ends, Autoreply: &away.AutoreplyInput{Enabled: &enabled, Text: &text}, MutePush: &mute, SubstituteID: &marina,
	}); err != nil {
		t.Fatal(err)
	}
	if err := worker.materialize(ctx); err != nil {
		t.Fatal(err)
	}
	pool.Exec(ctx, `UPDATE email_digest_items SET available_at=now()`)
	if err := worker.deliverDigests(ctx); err != nil {
		t.Fatal(err)
	}
	if got := count(`SELECT count(*) FROM email_digest_items WHERE actor_id=$1 AND last_error='suppressed_away'`, anna); got != 1 || mail.recipient != "" {
		t.Fatalf("queued digest items suppressed = %d, want 1; mailed to %q", got, mail.recipient)
	}

	// The substitute: one push, category away, «Вы замещаете: Anna».
	if got := deliveriesOf(marina); got != 1 {
		t.Fatalf("substitute deliveries = %d, want 1", got)
	}
	if err := worker.deliverMobile(ctx); err != nil {
		t.Fatal(err)
	}
	if len(relay.messages) != 1 {
		t.Fatalf("relay messages = %d", len(relay.messages))
	}
	assigned := openPayload(t, keys[marina], relay.messages[0].Ciphertext)
	if assigned.Title != "Вы замещаете: Anna" || !strings.HasPrefix(assigned.Body, "с ") || assigned.URL != "/people/"+anna {
		t.Fatalf("substitute push = %+v", assigned)
	}
	relay.messages = nil

	// Group, mention, a colleague's direct message: nothing for anna.
	send(colleague, group)
	send(colleague, group, anna)
	send(colleague, colleagueDirect)
	if got := deliveriesOf(anna); got != 0 {
		t.Fatalf("muted deliveries = %d, want 0", got)
	}
	// A request to her and a task for her: nothing either.
	requests := request.NewService(pool, nil)
	tasks := task.NewService(pool, nil)
	messages.SetRequests(requests)
	messages.SetTasks(tasks)
	if _, _, err := messages.CreateRequest(ctx, users[colleague], group, message.CreateRequestInput{
		ClientMsgID: uuid.NewString(), Body: "Подтвердите", Audience: request.AudienceInput{Kind: "people", ActorIDs: []string{anna}},
		Answer: request.AnswerSpec{Preset: request.PresetAck},
	}); err != nil {
		t.Fatal(err)
	}
	remind, due := false, time.Now().Add(5*time.Hour)
	if _, _, err := messages.CreateTask(ctx, users[colleague], group, message.CreateTaskInput{
		ClientMsgID: uuid.NewString(), Title: "Отчёт", DueAt: &due, RemindBeforeDue: &remind,
		Assignee: task.AssigneeInput{Kind: "person", ActorID: &anna},
	}); err != nil {
		t.Fatal(err)
	}
	for range 3 {
		if err := worker.materialize(ctx); err != nil {
			t.Fatal(err)
		}
	}
	if count(`SELECT count(*) FROM events WHERE type='task.notified' AND audience_actor_id=$1`, anna) != 1 ||
		count(`SELECT count(*) FROM message_request_recipients WHERE actor_id=$1`, anna) != 1 {
		t.Fatal("the request or the task does not concern anna")
	}
	if got := deliveriesOf(anna); got != 0 {
		t.Fatalf("request or task deliveries while muted = %d, want 0", got)
	}
	if got := count(`SELECT count(*) FROM email_digest_items WHERE actor_id=$1 AND sent_at IS NULL`, anna); got != 0 {
		t.Fatalf("digest items while away = %d", got)
	}
	// The owner's direct message: delivered, quietly; still no digest.
	send(owner, ownerDirect)
	if got := deliveriesOf(anna); got != 1 {
		t.Fatalf("owner's direct message deliveries = %d, want 1", got)
	}
	if got := count(`SELECT count(*) FROM email_digest_items WHERE actor_id=$1 AND sent_at IS NULL`, anna); got != 0 {
		t.Fatalf("digest items while away = %d", got)
	}
	if err := worker.deliverMobile(ctx); err != nil {
		t.Fatal(err)
	}
	if len(relay.messages) != 1 || !relay.messages[0].Silent {
		t.Fatalf("owner's direct message push = %+v", relay.messages)
	}
	relay.messages = nil
	// Her own reminder rings, with sound.
	target := send(colleague, group)
	reminders := reminder.NewService(pool, nil, logger)
	item, _, err := reminders.Set(ctx, users[anna], target.ID, reminder.SetInput{RemindAt: time.Now().Add(time.Hour)})
	if err != nil {
		t.Fatal(err)
	}
	pool.Exec(ctx, `UPDATE message_reminders SET remind_at=now() WHERE id=$1`, item.ID)
	if err := reminders.Fire(ctx, item.ID, 0); err != nil {
		t.Fatal(err)
	}
	if err := worker.materialize(ctx); err != nil {
		t.Fatal(err)
	}
	if err := worker.deliverMobile(ctx); err != nil {
		t.Fatal(err)
	}
	if len(relay.messages) != 1 || relay.messages[0].Silent {
		t.Fatalf("reminder push = %+v", relay.messages)
	}
	relay.messages = nil

	// Without «no notifications» the status changes nothing.
	mute = false
	if _, err := statuses.Set(ctx, users[anna], away.SetInput{
		Kind: away.KindVacation, EndsAt: &ends, Autoreply: &away.AutoreplyInput{Enabled: &enabled, Text: &text}, MutePush: &mute, SubstituteID: &marina,
	}); err != nil {
		t.Fatal(err)
	}
	send(colleague, colleagueDirect)
	if err := worker.deliverMobile(ctx); err != nil {
		t.Fatal(err)
	}
	if len(relay.messages) != 1 || relay.messages[0].Silent {
		t.Fatalf("push without mute_push = %+v", relay.messages)
	}
}

func TestAwayPeriodText(t *testing.T) {
	moscow, _ := time.LoadLocation("Europe/Moscow")
	at := func(month time.Month, day, hour int) time.Time { return time.Date(2026, month, day, hour, 0, 0, 0, moscow) }
	for _, item := range []struct {
		start, end time.Time
		locale     string
		want       string
	}{
		{at(11, 20, 0), at(12, 1, 0), "ru", "с 20 по 30 ноября"},
		{at(11, 28, 9), at(12, 6, 0), "ru", "с 28 ноября по 5 декабря"},
		{at(11, 20, 9), at(11, 20, 14), "ru", "20 ноября до 14:00"},
		{at(11, 20, 0), at(12, 1, 0), "en", "from Nov 20 to Nov 30"},
	} {
		if got := awayPeriod(item.start, item.end, item.locale); got != item.want {
			t.Errorf("awayPeriod = %q, want %q", got, item.want)
		}
	}
}
