package scheduled

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/comamessenger/comamessenger/core/internal/identity"
	"github.com/comamessenger/comamessenger/core/internal/scheduledreset"
	"github.com/comamessenger/comamessenger/core/internal/workspace"
	"github.com/google/uuid"
)

// Signing out one device, a session expiring or a device removed from the
// session list never stops a scheduled message.
func TestSigningOutADeviceKeepsScheduledMessages(t *testing.T) {
	cases := map[string]func(t *testing.T, w *world){
		"logout of the scheduling device": func(t *testing.T, w *world) {
			if err := identity.NewRepository(w.pool).RevokeSession(context.Background(), w.author.User.ActorID, w.author.SessionID, time.Now()); err != nil {
				t.Fatal(err)
			}
		},
		"device removed from another device": func(t *testing.T, w *world) {
			// From a second device, the person removes the first one
			// from the session list (DELETE /sessions/{id}).
			w.secondSession(t)
			if err := identity.NewRepository(w.pool).RevokeSession(context.Background(), w.author.User.ActorID, w.author.SessionID, time.Now()); err != nil {
				t.Fatal(err)
			}
		},
		"session expired": func(t *testing.T, w *world) {
			w.exec(t, `UPDATE sessions SET created_at=now()-interval '2 days', expires_at=now()-interval '1 day' WHERE actor_id=$1`, w.author.User.ActorID)
		},
	}
	for name, signOut := range cases {
		t.Run(name, func(t *testing.T) {
			w := newWorld(t)
			item := w.create(t, w.groupID, w.input("goes out anyway"))
			signOut(t, w)
			w.makeDue(t, item.ID)
			w.deliver(t, item)
			if status := w.load(t, item.ID).Status; status != StatusSent {
				t.Fatalf("status = %s, want sent", status)
			}
			if got := w.count(t, `SELECT count(*) FROM messages WHERE client_msg_id=$1`, item.ClientMsgID); got != 1 {
				t.Fatalf("messages = %d", got)
			}
		})
	}
}

// Every security event stops the author's pending messages at once, keeps
// their text for the author and tells the author's devices.
func TestSecurityEventsStopPendingMessages(t *testing.T) {
	ctx := context.Background()
	identityRepo := func(w *world) *identity.Repository { return identity.NewRepository(w.pool) }
	cases := []struct {
		name   string
		reason string
		event  func(t *testing.T, w *world)
	}{
		{"password change", ReasonSecurityReset, func(t *testing.T, w *world) {
			if _, err := identityRepo(w).ChangePassword(ctx, w.orgID, w.author.User.ActorID, w.author.SessionID, "new-hash", uuid.NewString(), time.Now()); err != nil {
				t.Fatal(err)
			}
		}},
		{"password reset", ReasonSecurityReset, func(t *testing.T, w *world) {
			token := []byte("reset-token")
			hash := sha256.Sum256(token)
			if err := identityRepo(w).CreatePasswordReset(ctx, identity.PasswordResetRecord{
				ID: uuid.NewString(), OrgID: w.orgID, ActorID: w.author.User.ActorID, TokenHash: hash[:], Delivery: "email",
				ExpiresAt: time.Now().Add(time.Hour), AuditID: uuid.NewString(),
			}, time.Now()); err != nil {
				t.Fatal(err)
			}
			if _, err := identityRepo(w).ResetPassword(ctx, hash[:], "new-hash", uuid.NewString(), time.Now()); err != nil {
				t.Fatal(err)
			}
		}},
		{"sign out every other device", ReasonSecurityReset, func(t *testing.T, w *world) {
			if _, err := identityRepo(w).RevokeOtherSessions(ctx, w.author.User.ActorID, w.author.SessionID, time.Now()); err != nil {
				t.Fatal(err)
			}
		}},
		{"e-mail change", ReasonSecurityReset, func(t *testing.T, w *world) {
			if _, _, err := identityRepo(w).ChangeEmailImmediate(ctx, w.orgID, w.author.User.ActorID, w.author.SessionID, "new@example.test", uuid.NewString(), time.Now()); err != nil {
				t.Fatal(err)
			}
		}},
		{"administrator signs out every device", ReasonSecurityReset, func(t *testing.T, w *world) {
			if _, err := workspace.NewRepository(w.pool).RequirePasswordChange(ctx, w.orgID, w.owner.User.ActorID, w.author.User.ActorID, "owner", time.Now()); err != nil {
				t.Fatal(err)
			}
		}},
		{"deactivation", ReasonAuthorInactive, func(t *testing.T, w *world) {
			status := "deactivated"
			if _, err := workspace.NewRepository(w.pool).UpdateMember(ctx, w.orgID, w.owner.User.ActorID, w.author.User.ActorID, workspace.UpdateMemberInput{Status: &status}); err != nil {
				t.Fatal(err)
			}
		}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			w := newWorld(t)
			fileID := w.file(t, w.author)
			input := w.input("please resend me")
			input.FileIDs = []string{fileID}
			first := w.create(t, w.groupID, input)
			second := w.create(t, w.groupID, w.input("second"))
			byOther, _, err := w.service.Create(ctx, w.other, w.groupID, w.input("someone else's"))
			if err != nil {
				t.Fatal(err)
			}
			tc.event(t, w)

			for _, item := range []ScheduledMessage{first, second} {
				failed := w.load(t, item.ID)
				if failed.Status != StatusFailed || failed.FailureReason == nil || *failed.FailureReason != tc.reason || failed.Body == "" {
					t.Fatalf("record = status %s reason %v body %q", failed.Status, failed.FailureReason, failed.Body)
				}
				// The job that wakes up later sends nothing.
				w.deliver(t, item)
				if got := w.count(t, `SELECT count(*) FROM messages WHERE client_msg_id=$1`, item.ClientMsgID); got != 0 {
					t.Fatal("message sent after the security event")
				}
			}
			if w.load(t, byOther.ID).Status != StatusPending {
				t.Fatal("another person's message was stopped")
			}
			// The author's devices get the full record, text and files included.
			events := w.events(t, first.ID)
			last := events[len(events)-1]
			if last.Type != "scheduled_message.failed" || last.Audience == nil || *last.Audience != w.author.User.ActorID || last.ChatID != nil {
				t.Fatalf("event = %#v", last)
			}
			var raw []byte
			if err := w.pool.QueryRow(ctx, `SELECT data FROM events WHERE subject_id=$1 AND type='scheduled_message.failed'`, first.ID).Scan(&raw); err != nil {
				t.Fatal(err)
			}
			decoder := json.NewDecoder(bytes.NewReader(raw))
			decoder.DisallowUnknownFields()
			var payload ScheduledMessage
			if err := decoder.Decode(&payload); err != nil {
				t.Fatalf("event payload %s: %v", raw, err)
			}
			if payload.Body != "please resend me" || len(payload.Files) != 1 || payload.Files[0].ID != fileID || payload.Status != StatusFailed ||
				payload.FailureReason == nil || *payload.FailureReason != tc.reason || payload.Version != 2 {
				t.Fatalf("event payload = %#v", payload)
			}
			// The author still sees them, with text, to send again.
			if tc.reason == ReasonSecurityReset {
				list, err := w.service.List(ctx, w.author, nil)
				if err != nil || len(list) != 2 || list[0].Status != StatusFailed || list[0].Body == "" {
					t.Fatalf("List() = %#v error=%v", list, err)
				}
			}
		})
	}
}

// A security event that commits while a delivery job is waiting wins: the
// job then finds the record failed. A job that already holds the lock sends
// first, before the event commits, and the event finds nothing pending.
func TestSecurityEventRacesDelivery(t *testing.T) {
	ctx := context.Background()
	t.Run("event first", func(t *testing.T) {
		w := newWorld(t)
		item := w.create(t, w.groupID, w.input("race"))
		w.makeDue(t, item.ID)
		tx, err := w.pool.Begin(ctx)
		if err != nil {
			t.Fatal(err)
		}
		defer tx.Rollback(ctx)
		if _, err := scheduledreset.StopPendingTx(ctx, tx, w.orgID, w.author.User.ActorID, scheduledreset.ReasonSecurityReset); err != nil {
			t.Fatal(err)
		}
		done := make(chan error, 1)
		jobID := *w.load(t, item.ID).riverJobID
		go func() { done <- w.service.Deliver(ctx, item.ID, jobID) }()
		select {
		case err := <-done:
			t.Fatalf("delivery did not wait for the security event: %v", err)
		case <-time.After(300 * time.Millisecond):
		}
		if err := tx.Commit(ctx); err != nil {
			t.Fatal(err)
		}
		if err := <-done; err != nil {
			t.Fatal(err)
		}
		if got := w.count(t, `SELECT count(*) FROM messages WHERE client_msg_id=$1`, item.ClientMsgID); got != 0 {
			t.Fatal("message sent after the security event")
		}
		if reason := w.load(t, item.ID).FailureReason; reason == nil || *reason != ReasonSecurityReset {
			t.Fatalf("reason = %v", reason)
		}
	})

	t.Run("concurrent password changes and jobs", func(t *testing.T) {
		w := newWorld(t)
		repo := identity.NewRepository(w.pool)
		for round := range 15 {
			item := w.create(t, w.groupID, w.input("round"))
			w.makeDue(t, item.ID)
			jobID := *w.load(t, item.ID).riverJobID
			var wait sync.WaitGroup
			errs := make(chan error, 2)
			wait.Add(2)
			go func() {
				defer wait.Done()
				errs <- w.service.Deliver(ctx, item.ID, jobID)
			}()
			go func() {
				defer wait.Done()
				_, err := repo.ChangePassword(ctx, w.orgID, w.author.User.ActorID, w.author.SessionID, "hash", uuid.NewString(), time.Now())
				errs <- err
			}()
			wait.Wait()
			close(errs)
			for err := range errs {
				if err != nil {
					t.Fatalf("round %d: %v", round, err)
				}
			}
			record := w.load(t, item.ID)
			sent := w.count(t, `SELECT count(*) FROM messages WHERE client_msg_id=$1`, item.ClientMsgID)
			switch {
			case record.Status == StatusSent && sent == 1:
			case record.Status == StatusFailed && sent == 0 && *record.FailureReason == ReasonSecurityReset:
			default:
				t.Fatalf("round %d: status %s, messages %d", round, record.Status, sent)
			}
		}
	})
}

func TestNoLiveSessionCannotSchedule(t *testing.T) {
	w := newWorld(t)
	w.exec(t, `UPDATE sessions SET revoked_at=now() WHERE id=$1`, w.author.SessionID)
	if _, _, err := w.service.Create(context.Background(), w.author, w.groupID, w.input("x")); !errors.Is(err, ErrForbidden) {
		t.Fatalf("Create() with a revoked session error = %v", err)
	}
}

// secondSession signs the author in on another device.
func (w *world) secondSession(t *testing.T) string {
	t.Helper()
	id := uuid.NewString()
	w.exec(t, `INSERT INTO sessions (id, org_id, actor_id, family_id, refresh_hash, expires_at) VALUES ($1, $2, $3, $1, sha256(convert_to(gen_random_uuid()::text, 'UTF8')), now() + interval '1 day')`,
		id, w.orgID, w.author.User.ActorID)
	return id
}
