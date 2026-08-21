package push

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"strings"
	"testing"
	"time"

	"github.com/comamessenger/comamessenger/core/internal/config"
	"github.com/comamessenger/comamessenger/core/internal/identity"
	"github.com/comamessenger/comamessenger/core/internal/testdb"
	"github.com/google/uuid"
)

type recordingEmailSender struct {
	recipient string
	subject   string
	body      string
	err       error
}

func (s *recordingEmailSender) EmailConfigured(context.Context, string) (bool, error) {
	return true, nil
}

func (s *recordingEmailSender) SendEmail(_ context.Context, _, recipient, subject, body string) error {
	s.recipient, s.subject, s.body = recipient, subject, body
	return s.err
}

func TestTruncateUsesRunes(t *testing.T) {
	if got := truncate("Привет", 4); got != "Прив…" {
		t.Fatalf("truncate() = %q", got)
	}
	if got := truncate("Coma", 10); got != "Coma" {
		t.Fatalf("short truncate() = %q", got)
	}
}

func TestCategoryBodyIsLocalized(t *testing.T) {
	data := []byte(`{"emoji":"🔥","role":"admin"}`)
	if got := categoryBody("reaction.added", data, "Ada", "en"); got != "Ada reacted 🔥 to your message" {
		t.Fatalf("reaction body = %q", got)
	}
	if got := categoryBody("member.updated", data, "Ада", "ru"); got != "Ада изменил(а) вашу роль в чате на admin" {
		t.Fatalf("member body = %q", got)
	}
}

func TestPushTestRequiresVAPIDConfiguration(t *testing.T) {
	_, err := NewService(nil, config.PushConfig{}).Test(context.Background(), identity.User{})
	if !errors.Is(err, ErrUnavailable) {
		t.Fatalf("Test() error = %v", err)
	}
}

func TestValidChatFolders(t *testing.T) {
	folders := []ChatFolder{{
		ID: "00000000-0000-4000-8000-000000000001", Name: " Работа ", Icon: "briefcase", Color: "violet",
		ChatIDs: []string{"00000000-0000-4000-8000-000000000002"},
	}}
	if !validChatFolders(folders) || folders[0].Name != "Работа" {
		t.Fatalf("validChatFolders() rejected or did not normalize valid input: %+v", folders)
	}
	folders[0].ChatIDs = append(folders[0].ChatIDs, folders[0].ChatIDs[0])
	if validChatFolders(folders) {
		t.Fatal("validChatFolders() accepted a duplicate chat")
	}
	folders[0].ChatIDs = folders[0].ChatIDs[:1]
	folders[0].Color = "ultraviolet"
	if validChatFolders(folders) {
		t.Fatal("validChatFolders() accepted an unsupported color")
	}
}

func TestValidPinnedChats(t *testing.T) {
	valid := []string{"00000000-0000-4000-8000-000000000001"}
	if !validPinnedChats(valid) {
		t.Fatal("validPinnedChats() rejected valid input")
	}
	if validPinnedChats([]string{valid[0], valid[0]}) {
		t.Fatal("validPinnedChats() accepted duplicate input")
	}
	tooMany := make([]string, 11)
	for index := range tooMany {
		tooMany[index] = fmt.Sprintf("00000000-0000-4000-8000-%012d", index)
	}
	if validPinnedChats(tooMany) {
		t.Fatal("validPinnedChats() accepted more than ten chats")
	}
}

func TestOptionalTimeDistinguishesMissingNullAndValue(t *testing.T) {
	var missing UpdatePreferences
	if err := json.Unmarshal([]byte(`{}`), &missing); err != nil {
		t.Fatal(err)
	}
	if missing.SnoozedUntil.Set {
		t.Fatal("missing snoozed_until was marked as set")
	}
	var cleared UpdatePreferences
	if err := json.Unmarshal([]byte(`{"snoozed_until":null}`), &cleared); err != nil {
		t.Fatal(err)
	}
	if !cleared.SnoozedUntil.Set || cleared.SnoozedUntil.Value != nil {
		t.Fatalf("null snoozed_until = %+v", cleared.SnoozedUntil)
	}
	var scheduled UpdatePreferences
	if err := json.Unmarshal([]byte(`{"snoozed_until":"2026-08-21T12:00:00Z"}`), &scheduled); err != nil {
		t.Fatal(err)
	}
	want := time.Date(2026, 8, 21, 12, 0, 0, 0, time.UTC)
	if !scheduled.SnoozedUntil.Set || scheduled.SnoozedUntil.Value == nil || !scheduled.SnoozedUntil.Value.Equal(want) {
		t.Fatalf("timestamp snoozed_until = %+v", scheduled.SnoozedUntil)
	}
}

func TestNotificationScheduleValidation(t *testing.T) {
	valid := []string{
		`{"days":"all","from":"00:00","to":"00:00"}`,
		`{"days":"weekdays","from":"09:00","to":"18:30"}`,
		`{"days":[1,3,5],"from":"22:00","to":"07:00"}`,
	}
	for _, raw := range valid {
		var schedule NotificationSchedule
		if err := json.Unmarshal([]byte(raw), &schedule); err != nil || !validSchedule(schedule) {
			t.Fatalf("valid schedule %s rejected: %+v %v", raw, schedule, err)
		}
	}
	invalid := []string{
		`{"days":"holiday","from":"09:00","to":"18:00"}`,
		`{"days":[],"from":"09:00","to":"18:00"}`,
		`{"days":[1,1],"from":"09:00","to":"18:00"}`,
		`{"days":[7],"from":"09:00","to":"18:00"}`,
		`{"days":"all","from":"24:00","to":"18:00"}`,
	}
	for _, raw := range invalid {
		var schedule NotificationSchedule
		if err := json.Unmarshal([]byte(raw), &schedule); err == nil && validSchedule(schedule) {
			t.Fatalf("invalid schedule %s accepted: %+v", raw, schedule)
		}
	}

	var cleared UpdatePreferences
	if err := json.Unmarshal([]byte(`{"schedule":null}`), &cleared); err != nil {
		t.Fatal(err)
	}
	if !cleared.Schedule.Set || cleared.Schedule.Value != nil {
		t.Fatalf("null schedule = %+v", cleared.Schedule)
	}
}

func TestMaterializeAppliesGlobalRulesSnoozeAndSchedule(t *testing.T) {
	pool := testdb.New(t)
	ctx := context.Background()
	orgID, senderID, recipientID := uuid.NewString(), uuid.NewString(), uuid.NewString()
	chatID, sessionID, subscriptionID := uuid.NewString(), uuid.NewString(), uuid.NewString()
	setup := []struct {
		query string
		args  []any
	}{
		{`INSERT INTO organizations(id,name,slug) VALUES($1,'Push test','push-test')`, []any{orgID}},
		{`INSERT INTO actors(id,org_id,type,org_role,display_name,handle,timezone) VALUES ($2,$1,'user','owner','Sender','sender','UTC'),($3,$1,'user','member','Recipient','recipient','UTC')`, []any{orgID, senderID, recipientID}},
		{`INSERT INTO users(actor_id,org_id,email,password_hash,preferences) VALUES ($2,$1,'sender@example.test','hash','{}'),($3,$1,'recipient@example.test','hash','{}')`, []any{orgID, senderID, recipientID}},
		{`INSERT INTO sessions(id,org_id,actor_id,family_id,refresh_hash,expires_at) VALUES($3,$1,$2,$3,decode(repeat('01',32),'hex'),now()+interval '1 day')`, []any{orgID, recipientID, sessionID}},
		{`INSERT INTO chats(id,org_id,kind,visibility,name,created_by) VALUES($3,$1,'group','private','Rules',$2)`, []any{orgID, senderID, chatID}},
		{`INSERT INTO chat_members(chat_id,actor_id,org_id,role) VALUES ($3,$2,$1,'owner'),($3,$4,$1,'member')`, []any{orgID, senderID, chatID, recipientID}},
		{`INSERT INTO web_push_subscriptions(id,org_id,actor_id,session_id,endpoint,p256dh,auth) VALUES($4,$1,$2,$3,'https://push.example.test/recipient','0123456789abcdef','0123456789abcdef')`, []any{orgID, recipientID, sessionID, subscriptionID}},
	}
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	for _, statement := range setup {
		if _, err := tx.Exec(ctx, statement.query, statement.args...); err != nil {
			_ = tx.Rollback(ctx)
			t.Fatal(err)
		}
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	worker := NewWorker(slog.New(slog.NewTextHandler(io.Discard, nil)), pool, config.PushConfig{}, nil)
	occurredAt := time.Date(2026, 8, 24, 12, 0, 0, 0, time.UTC) // Monday.
	var lastSeq int64
	materialize := func(t *testing.T, preferences map[string]any, mentioned bool) int {
		t.Helper()
		encoded, err := json.Marshal(preferences)
		if err != nil {
			t.Fatal(err)
		}
		if _, err = pool.Exec(ctx, `UPDATE users SET preferences=$2 WHERE actor_id=$1`, recipientID, encoded); err != nil {
			t.Fatal(err)
		}
		if _, err = pool.Exec(ctx, `DELETE FROM notification_snoozes WHERE org_id=$1 AND actor_id=$2`, orgID, recipientID); err != nil {
			t.Fatal(err)
		}
		if until, ok := preferences["snoozed_until"].(time.Time); ok {
			if _, err = pool.Exec(ctx, `INSERT INTO notification_snoozes(org_id,actor_id,starts_at,ends_at) VALUES($1,$2,$3,$4)`, orgID, recipientID, occurredAt.Add(-time.Minute), until); err != nil {
				t.Fatal(err)
			}
		}
		var seq int64
		if err = pool.QueryRow(ctx, `UPDATE organizations SET event_seq=event_seq+1 WHERE id=$1 RETURNING event_seq`, orgID).Scan(&seq); err != nil {
			t.Fatal(err)
		}
		lastSeq = seq
		messageID, clientID := uuid.NewString(), uuid.NewString()
		mentions := []string{}
		if mentioned {
			mentions = []string{recipientID}
		}
		if _, err = pool.Exec(ctx, `INSERT INTO messages(id,org_id,chat_id,actor_id,client_msg_id,create_fingerprint,body,body_format,created_seq,created_at,mentioned_actor_ids)
			VALUES($1,$2,$3,$4,$5,decode(repeat('02',32),'hex'),'hello','plain',$6,$7,$8)`,
			messageID, orgID, chatID, senderID, clientID, seq, occurredAt, mentions); err != nil {
			t.Fatal(err)
		}
		if _, err = pool.Exec(ctx, `INSERT INTO events(org_id,seq,type,actor_id,chat_id,subject_id,occurred_at) VALUES($1,$2,'message.created',$3,$4,$5,$6)`, orgID, seq, senderID, chatID, messageID, occurredAt); err != nil {
			t.Fatal(err)
		}
		if _, err = pool.Exec(ctx, `INSERT INTO notification_jobs(org_id,event_seq) VALUES($1,$2)`, orgID, seq); err != nil {
			t.Fatal(err)
		}
		if err = worker.materialize(ctx); err != nil {
			t.Fatal(err)
		}
		var count int
		if err = pool.QueryRow(ctx, `SELECT count(*) FROM notification_deliveries WHERE org_id=$1 AND event_seq=$2`, orgID, seq).Scan(&count); err != nil {
			t.Fatal(err)
		}
		return count
	}
	t.Run("global none", func(t *testing.T) {
		if got := materialize(t, map[string]any{"push_enabled": true, "notify_messages": "none"}, true); got != 0 {
			t.Fatalf("deliveries = %d", got)
		}
	})
	t.Run("mentions policy", func(t *testing.T) {
		if got := materialize(t, map[string]any{"push_enabled": true, "notify_messages": "direct_and_mentions"}, false); got != 0 {
			t.Fatalf("unmentioned deliveries = %d", got)
		}
		if got := materialize(t, map[string]any{"push_enabled": true, "notify_messages": "direct_and_mentions"}, true); got != 1 {
			t.Fatalf("mentioned deliveries = %d", got)
		}
	})
	t.Run("snooze is permanent for the event", func(t *testing.T) {
		if got := materialize(t, map[string]any{"push_enabled": true, "snoozed_until": occurredAt.Add(time.Hour)}, true); got != 0 {
			t.Fatalf("deliveries = %d", got)
		}
	})
	t.Run("schedule", func(t *testing.T) {
		if got := materialize(t, map[string]any{"push_enabled": true, "schedule": map[string]any{"days": "weekdays", "from": "09:00", "to": "18:00"}}, true); got != 1 {
			t.Fatalf("in-schedule deliveries = %d", got)
		}
		if got := materialize(t, map[string]any{"push_enabled": true, "schedule": map[string]any{"days": []int{0}, "from": "09:00", "to": "18:00"}}, true); got != 0 {
			t.Fatalf("out-of-schedule deliveries = %d", got)
		}
	})
	materializeCategory := func(t *testing.T, eventType string, enabled bool) int {
		t.Helper()
		preference := "notify_system"
		if eventType == "reaction.added" {
			preference = "notify_reactions"
		} else if eventType == "member.joined" {
			preference = "notify_invites"
		}
		encoded, _ := json.Marshal(map[string]any{"push_enabled": true, preference: enabled})
		if _, err := pool.Exec(ctx, `UPDATE users SET preferences=$2 WHERE actor_id=$1`, recipientID, encoded); err != nil {
			t.Fatal(err)
		}
		var seq int64
		if err := pool.QueryRow(ctx, `UPDATE organizations SET event_seq=event_seq+1 WHERE id=$1 RETURNING event_seq`, orgID).Scan(&seq); err != nil {
			t.Fatal(err)
		}
		subjectID := chatID
		data := map[string]any{"actor_id": recipientID, "role": "admin"}
		if eventType == "reaction.added" {
			subjectID = uuid.NewString()
			if _, err := pool.Exec(ctx, `INSERT INTO messages(id,org_id,chat_id,actor_id,client_msg_id,create_fingerprint,body,body_format,created_seq,created_at) VALUES($1,$2,$3,$4,$5,decode(repeat('03',32),'hex'),'mine','plain',$6,$7)`, subjectID, orgID, chatID, recipientID, uuid.NewString(), seq, occurredAt); err != nil {
				t.Fatal(err)
			}
			data = map[string]any{"emoji": "🔥"}
		}
		encodedData, _ := json.Marshal(data)
		if _, err := pool.Exec(ctx, `INSERT INTO events(org_id,seq,type,actor_id,chat_id,subject_id,data,occurred_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, orgID, seq, eventType, senderID, chatID, subjectID, encodedData, occurredAt); err != nil {
			t.Fatal(err)
		}
		if _, err := pool.Exec(ctx, `INSERT INTO notification_jobs(org_id,event_seq) VALUES($1,$2)`, orgID, seq); err != nil {
			t.Fatal(err)
		}
		if err := worker.materialize(ctx); err != nil {
			t.Fatal(err)
		}
		var count int
		if err := pool.QueryRow(ctx, `SELECT count(*) FROM notification_deliveries WHERE org_id=$1 AND event_seq=$2`, orgID, seq).Scan(&count); err != nil {
			t.Fatal(err)
		}
		return count
	}
	for _, eventType := range []string{"reaction.added", "member.joined", "member.updated", "member.removed"} {
		t.Run(eventType, func(t *testing.T) {
			if got := materializeCategory(t, eventType, false); got != 0 {
				t.Fatalf("disabled deliveries = %d", got)
			}
			if got := materializeCategory(t, eventType, true); got != 1 {
				t.Fatalf("enabled deliveries = %d", got)
			}
		})
	}
	t.Run("email digest is durable and batched without VAPID", func(t *testing.T) {
		if got := materialize(t, map[string]any{"push_enabled": false, "email_digest": true, "push_preview": true}, true); got != 0 {
			t.Fatalf("push deliveries = %d", got)
		}
		var availableAt time.Time
		if err := pool.QueryRow(ctx, `SELECT available_at FROM email_digest_items WHERE org_id=$1 AND event_seq=$2 AND actor_id=$3`, orgID, lastSeq, recipientID).Scan(&availableAt); err != nil {
			t.Fatal(err)
		}
		if !availableAt.Equal(occurredAt.Add(15 * time.Minute)) {
			t.Fatalf("available_at = %s", availableAt)
		}
		if _, err := pool.Exec(ctx, `UPDATE email_digest_items SET available_at=now() WHERE org_id=$1 AND event_seq=$2`, orgID, lastSeq); err != nil {
			t.Fatal(err)
		}
		sender := &recordingEmailSender{}
		worker.emailSender = sender
		if err := worker.deliverDigests(ctx); err != nil {
			t.Fatal(err)
		}
		if sender.recipient != "recipient@example.test" || !strings.Contains(sender.subject, "1 уведомлений") || !strings.Contains(sender.body, "hello") {
			t.Fatalf("email = recipient %q, subject %q, body %q", sender.recipient, sender.subject, sender.body)
		}
		var sentAt *time.Time
		if err := pool.QueryRow(ctx, `SELECT sent_at FROM email_digest_items WHERE org_id=$1 AND event_seq=$2 AND actor_id=$3`, orgID, lastSeq, recipientID).Scan(&sentAt); err != nil || sentAt == nil {
			t.Fatalf("sent_at = %v, error = %v", sentAt, err)
		}
	})
}
