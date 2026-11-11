package scheduled

import (
	"context"
	"crypto/sha256"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/comamessenger/comamessenger/core/internal/identity"
	"github.com/comamessenger/comamessenger/core/internal/message"
	"github.com/comamessenger/comamessenger/core/internal/scheduledreset"
	"github.com/comamessenger/comamessenger/core/internal/workspace"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

func (w *world) identityRepo() *identity.Repository { return identity.NewRepository(w.pool) }

// secondSession signs the author in on another device, a session family of
// its own.
func (w *world) secondSession(t *testing.T) Author {
	t.Helper()
	sessionID := uuid.NewString()
	w.exec(t, `INSERT INTO sessions (id, org_id, actor_id, family_id, refresh_hash, expires_at) VALUES ($1, $2, $3, $1, sha256(convert_to(gen_random_uuid()::text, 'UTF8')), now() + interval '1 day')`,
		sessionID, w.orgID, w.author.User.ActorID)
	return Author{User: w.author.User, SessionID: sessionID}
}

func (w *world) sentCount(t *testing.T, item ScheduledMessage) int {
	t.Helper()
	return w.count(t, `SELECT count(*) FROM messages WHERE client_msg_id=$1`, MessageClientID(item.ID))
}

// Signing out on the device itself and a session expiring never stop a
// scheduled message.
func TestSigningOutKeepsScheduledMessages(t *testing.T) {
	cases := map[string]func(t *testing.T, w *world){
		"logout on the scheduling device": func(t *testing.T, w *world) {
			if err := w.identityRepo().RevokeSession(context.Background(), w.author.User.ActorID, w.author.SessionID, time.Now()); err != nil {
				t.Fatal(err)
			}
		},
		"session expired": func(t *testing.T, w *world) {
			w.exec(t, `UPDATE sessions SET created_at=now()-interval '2 days', expires_at=now()-interval '1 day' WHERE actor_id=$1`, w.author.User.ActorID)
		},
		// A client that lost the response retries the refresh after logout.
		"refresh after logout": func(t *testing.T, w *world) {
			hash := w.setRefresh(t, w.author.SessionID, "live-token", false)
			if err := w.identityRepo().RevokeSession(context.Background(), w.author.User.ActorID, w.author.SessionID, time.Now()); err != nil {
				t.Fatal(err)
			}
			if err := w.rotate(hash); !errors.Is(err, identity.ErrRefreshReuse) {
				t.Fatalf("refresh after logout error = %v", err)
			}
		},
		// An expired session presented twice: the first refresh revokes
		// the family as expired, the second looks like a replay.
		"two refreshes after expiry": func(t *testing.T, w *world) {
			hash := w.setRefresh(t, w.author.SessionID, "expired-token", true)
			if err := w.rotate(hash); !errors.Is(err, identity.ErrInvalidRefreshToken) {
				t.Fatalf("first refresh error = %v", err)
			}
			if err := w.rotate(hash); !errors.Is(err, identity.ErrRefreshReuse) {
				t.Fatalf("second refresh error = %v", err)
			}
		},
	}
	for name, signOut := range cases {
		t.Run(name, func(t *testing.T) {
			w := newWorld(t)
			item := w.create(t, w.groupID, w.input("goes out anyway"))
			signOut(t, w)
			w.makeDue(t, item.ID)
			w.deliver(t, item)
			if status := w.load(t, item.ID).Status; status != StatusSent || w.sentCount(t, item) != 1 {
				t.Fatalf("status = %s, want sent", status)
			}
			if got := w.count(t, `SELECT count(*) FROM revoked_session_families`); got != 0 {
				t.Fatalf("revoked family marks = %d, want 0", got)
			}
		})
	}
}

// Every security event stops the author's pending messages: in its own
// transaction through the epoch or the family mark, then visibly as failed
// records that keep their text, with a contentless event to the author.
func TestSecurityEventsStopPendingMessages(t *testing.T) {
	ctx := context.Background()
	cases := []struct {
		name   string
		reason string
		event  func(t *testing.T, w *world)
	}{
		{"password change", ReasonSecurityReset, func(t *testing.T, w *world) {
			if _, err := w.identityRepo().ChangePassword(ctx, w.orgID, w.author.User.ActorID, w.author.SessionID, "new-hash", uuid.NewString(), time.Now()); err != nil {
				t.Fatal(err)
			}
		}},
		{"password reset by e-mail", ReasonSecurityReset, func(t *testing.T, w *world) {
			hash := sha256.Sum256([]byte("reset-token"))
			if err := w.identityRepo().CreatePasswordReset(ctx, identity.PasswordResetRecord{
				ID: uuid.NewString(), OrgID: w.orgID, ActorID: w.author.User.ActorID, TokenHash: hash[:], Delivery: "email",
				ExpiresAt: time.Now().Add(time.Hour), AuditID: uuid.NewString(),
			}, time.Now()); err != nil {
				t.Fatal(err)
			}
			if _, err := w.identityRepo().ResetPassword(ctx, hash[:], "new-hash", uuid.NewString(), time.Now()); err != nil {
				t.Fatal(err)
			}
		}},
		{"sign out every other device", ReasonSecurityReset, func(t *testing.T, w *world) {
			if _, err := w.identityRepo().RevokeOtherSessions(ctx, w.author.User.ActorID, w.author.SessionID, time.Now()); err != nil {
				t.Fatal(err)
			}
		}},
		{"e-mail change", ReasonSecurityReset, func(t *testing.T, w *world) {
			if _, _, err := w.identityRepo().ChangeEmailImmediate(ctx, w.orgID, w.author.User.ActorID, w.author.SessionID, "new@example.test", uuid.NewString(), time.Now()); err != nil {
				t.Fatal(err)
			}
		}},
		{"e-mail change confirmed", ReasonSecurityReset, func(t *testing.T, w *world) {
			hash := sha256.Sum256([]byte("email-token"))
			if err := w.identityRepo().CreateEmailChange(ctx, identity.EmailChangeRecord{
				ID: uuid.NewString(), OrgID: w.orgID, ActorID: w.author.User.ActorID, NewEmail: "confirmed@example.test",
				TokenHash: hash[:], ExpiresAt: time.Now().Add(time.Hour), AuditID: uuid.NewString(),
			}, time.Now()); err != nil {
				t.Fatal(err)
			}
			if _, _, err := w.identityRepo().ConfirmEmailChange(ctx, w.orgID, w.author.User.ActorID, w.author.SessionID, hash[:], uuid.NewString(), time.Now()); err != nil {
				t.Fatal(err)
			}
		}},
		{"administrator requires a new password", ReasonSecurityReset, func(t *testing.T, w *world) {
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
		{"device removed from the session list", ReasonSessionRevoked, func(t *testing.T, w *world) {
			if err := w.identityRepo().RevokeDevice(ctx, w.author.User.ActorID, w.author.SessionID, time.Now()); err != nil {
				t.Fatal(err)
			}
		}},
		{"reused refresh token", ReasonSessionRevoked, func(t *testing.T, w *world) {
			// The device refreshed once; the old refresh token comes back.
			rotated := uuid.NewString()
			w.exec(t, `UPDATE sessions SET refresh_hash=sha256('stolen'::bytea) WHERE id=$1`, w.author.SessionID)
			w.exec(t, `INSERT INTO sessions (id, org_id, actor_id, family_id, refresh_hash, expires_at) VALUES ($1, $2, $3, $4, sha256('fresh'::bytea), now() + interval '1 day')`,
				rotated, w.orgID, w.author.User.ActorID, w.author.SessionID)
			w.exec(t, `UPDATE sessions SET revoked_at=now(), replaced_by=$2 WHERE id=$1`, w.author.SessionID, rotated)
			stolen := sha256.Sum256([]byte("stolen"))
			if _, err := w.identityRepo().RotateSession(ctx, stolen[:], identity.NewSession{}, time.Now()); !errors.Is(err, identity.ErrRefreshReuse) {
				t.Fatalf("RotateSession() error = %v", err)
			}
		}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			w := newWorld(t)
			input := w.input("please resend me")
			input.FileIDs = []string{w.file(t, w.author)}
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
					t.Fatalf("record = status %s reason %v body %q, want %s", failed.Status, failed.FailureReason, failed.Body, tc.reason)
				}
				w.makeDue(t, item.ID)
				w.deliver(t, item)
				if w.sentCount(t, item) != 0 {
					t.Fatal("message sent after the security event")
				}
			}
			if w.load(t, byOther.ID).Status != StatusPending {
				t.Fatal("another person's message was stopped")
			}
			events := w.events(t, first.ID)
			last := events[len(events)-1]
			if last.Type != "scheduled_message.failed" || last.Audience == nil || *last.Audience != w.author.User.ActorID || last.ChatID != nil || last.Data["failure_reason"] != tc.reason {
				t.Fatalf("event = %#v", last)
			}
			assertEventShape(t, last.Data)
			// The author still finds the text and the files to send again.
			got := w.load(t, first.ID)
			if got.Body != "please resend me" || w.count(t, `SELECT count(*) FROM scheduled_message_files WHERE scheduled_message_id=$1`, first.ID) != 1 {
				t.Fatalf("failed record lost its content: %#v", got)
			}
		})
	}
}

// The marks alone stop delivery: even if marking the records failed right
// after the event did not happen, the job refuses, and the sweep marks them.
func TestSecurityMarksBlockWithoutReconcile(t *testing.T) {
	ctx := context.Background()
	w := newWorld(t)
	byEpoch := w.create(t, w.groupID, w.input("epoch"))
	other := w.secondSession(t)
	byFamily, _, err := w.service.Create(ctx, other, w.groupID, w.input("family"))
	if err != nil {
		t.Fatal(err)
	}
	tx, err := w.pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if err := scheduledreset.RevokeFamilyTx(ctx, tx, w.orgID, w.author.User.ActorID, other.SessionID, scheduledreset.FamilyDeviceRevoked); err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	if w.load(t, byFamily.ID).Status != StatusPending {
		t.Fatal("test setup: reconcile ran")
	}
	if removed, err := w.service.Cleanup(ctx); err != nil || removed != 0 {
		t.Fatalf("Cleanup() = %d %v", removed, err)
	}
	if reason := w.load(t, byFamily.ID).FailureReason; reason == nil || *reason != ReasonSessionRevoked {
		t.Fatalf("sweep reason = %v", reason)
	}
	if w.load(t, byEpoch.ID).Status != StatusPending {
		t.Fatal("the device mark stopped another device's message")
	}
	w.exec(t, `UPDATE users SET security_epoch=security_epoch+1 WHERE actor_id=$1`, w.author.User.ActorID)
	w.makeDue(t, byEpoch.ID)
	w.deliver(t, byEpoch)
	if reason := w.load(t, byEpoch.ID).FailureReason; reason == nil || *reason != ReasonSecurityReset || w.sentCount(t, byEpoch) != 0 {
		t.Fatalf("delivery after epoch bump: reason %v", reason)
	}
}

// Revoking one device stops only what that device scheduled or last changed.
func TestDeviceRevocationStopsOnlyItsFamily(t *testing.T) {
	ctx := context.Background()
	w := newWorld(t)
	phone := w.secondSession(t)
	fromLaptop := w.create(t, w.groupID, w.input("laptop"))
	fromPhone, _, err := w.service.Create(ctx, phone, w.groupID, w.input("phone"))
	if err != nil {
		t.Fatal(err)
	}
	// Editing from the laptop moves the phone's message to the laptop.
	editedOnLaptop, _, err := w.service.Create(ctx, phone, w.groupID, w.input("phone, then laptop"))
	if err != nil {
		t.Fatal(err)
	}
	body := "edited on the laptop"
	if _, err := w.service.Update(ctx, w.author, editedOnLaptop.ID, UpdateInput{ExpectedVersion: 1, Body: &body}); err != nil {
		t.Fatal(err)
	}
	if err := w.identityRepo().RevokeDevice(ctx, w.author.User.ActorID, phone.SessionID, time.Now()); err != nil {
		t.Fatal(err)
	}
	if reason := w.load(t, fromPhone.ID).FailureReason; reason == nil || *reason != ReasonSessionRevoked {
		t.Fatalf("phone message reason = %v", reason)
	}
	for _, item := range []ScheduledMessage{fromLaptop, editedOnLaptop} {
		w.makeDue(t, item.ID)
		w.deliver(t, item)
		if w.load(t, item.ID).Status != StatusSent {
			t.Fatalf("%s: laptop message stopped", item.ID)
		}
	}
	// The revoked device can no longer schedule.
	if _, _, err := w.service.Create(ctx, phone, w.groupID, w.input("again")); !errors.Is(err, ErrForbidden) {
		t.Fatalf("Create() from a revoked device error = %v", err)
	}
}

// Deactivating and reactivating before the send time does not revive what
// was scheduled before.
func TestDeactivationThenReactivationStillStops(t *testing.T) {
	ctx := context.Background()
	w := newWorld(t)
	item := w.create(t, w.groupID, w.input("before"))
	repo := workspace.NewRepository(w.pool)
	for _, status := range []string{"deactivated", "active"} {
		if _, err := repo.UpdateMember(ctx, w.orgID, w.owner.User.ActorID, w.author.User.ActorID, workspace.UpdateMemberInput{Status: &status}); err != nil {
			t.Fatal(err)
		}
	}
	w.makeDue(t, item.ID)
	w.deliver(t, item)
	if w.sentCount(t, item) != 0 || w.load(t, item.ID).Status != StatusFailed {
		t.Fatal("reactivation revived a stopped message")
	}
	// Without the visible marking, the epoch alone stops it.
	w.exec(t, `UPDATE scheduled_messages SET status='pending', failure_reason=NULL, failed_at=NULL WHERE id=$1`, item.ID)
	w.makeDue(t, item.ID)
	w.deliver(t, item)
	if reason := w.load(t, item.ID).FailureReason; reason == nil || *reason != ReasonSecurityReset || w.sentCount(t, item) != 0 {
		t.Fatalf("reason = %v", reason)
	}
	// Scheduling after the reactivation works.
	again := w.create(t, w.groupID, w.input("after"))
	w.makeDue(t, again.ID)
	w.deliver(t, again)
	if w.load(t, again.ID).Status != StatusSent {
		t.Fatal("new message after reactivation not sent")
	}
}

// A security event in flight while a job delivers: the job waits for the
// event and then sends nothing; concurrent rounds never send after the
// event and never deadlock.
func TestSecurityEventRacesDelivery(t *testing.T) {
	ctx := context.Background()
	t.Run("event holds its transaction", func(t *testing.T) {
		w := newWorld(t)
		item := w.create(t, w.groupID, w.input("race"))
		w.makeDue(t, item.ID)
		tx, err := w.pool.Begin(ctx)
		if err != nil {
			t.Fatal(err)
		}
		defer tx.Rollback(ctx)
		if err := scheduledreset.BumpEpochTx(ctx, tx, w.orgID, w.author.User.ActorID); err != nil {
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
		if w.sentCount(t, item) != 0 {
			t.Fatal("message sent after the security event")
		}
	})

	rounds := func(t *testing.T, w *world, event func() error) {
		t.Helper()
		for round := range 12 {
			item := w.create(t, w.groupID, w.input("round"))
			w.makeDue(t, item.ID)
			jobID := *w.load(t, item.ID).riverJobID
			var wait sync.WaitGroup
			errs := make(chan error, 2)
			wait.Add(2)
			go func() { defer wait.Done(); errs <- w.service.Deliver(ctx, item.ID, jobID) }()
			go func() { defer wait.Done(); errs <- event() }()
			wait.Wait()
			close(errs)
			for err := range errs {
				if err != nil {
					t.Fatalf("round %d: %v", round, err)
				}
			}
			record := w.load(t, item.ID)
			sent := w.sentCount(t, item)
			if !(record.Status == StatusSent && sent == 1) && !(record.Status == StatusFailed && sent == 0) {
				t.Fatalf("round %d: status %s, messages %d", round, record.Status, sent)
			}
		}
	}
	t.Run("password changes", func(t *testing.T) {
		w := newWorld(t)
		rounds(t, w, func() error {
			_, err := w.identityRepo().ChangePassword(ctx, w.orgID, w.author.User.ActorID, w.author.SessionID, "hash", uuid.NewString(), time.Now())
			return err
		})
	})
	t.Run("deactivation and reactivation without deadlock", func(t *testing.T) {
		w := newWorld(t)
		repo := workspace.NewRepository(w.pool)
		rounds(t, w, func() error {
			for _, status := range []string{"deactivated", "active"} {
				if _, err := repo.UpdateMember(ctx, w.orgID, w.owner.User.ActorID, w.author.User.ActorID, workspace.UpdateMemberInput{Status: &status}); err != nil {
					return err
				}
			}
			return nil
		})
	})
}

// A security event in flight while the author schedules: Create waits for
// it and is refused, or Create commits first and the event stops the record.
func TestSecurityEventRacesCreate(t *testing.T) {
	ctx := context.Background()
	t.Run("event holds its transaction", func(t *testing.T) {
		w := newWorld(t)
		phone := w.secondSession(t)
		tx, err := w.pool.Begin(ctx)
		if err != nil {
			t.Fatal(err)
		}
		defer tx.Rollback(ctx)
		// Signing out every other device from the laptop.
		if err := scheduledreset.BumpEpochTx(ctx, tx, w.orgID, w.author.User.ActorID); err != nil {
			t.Fatal(err)
		}
		if _, err := tx.Exec(ctx, `UPDATE sessions SET revoked_at=now() WHERE id=$1`, phone.SessionID); err != nil {
			t.Fatal(err)
		}
		done := make(chan error, 1)
		go func() {
			_, _, err := w.service.Create(ctx, phone, w.groupID, w.input("from the phone"))
			done <- err
		}()
		select {
		case err := <-done:
			t.Fatalf("Create did not wait for the security event: %v", err)
		case <-time.After(300 * time.Millisecond):
		}
		if err := tx.Commit(ctx); err != nil {
			t.Fatal(err)
		}
		if err := <-done; !errors.Is(err, ErrForbidden) {
			t.Fatalf("Create() after the event error = %v", err)
		}
	})
	t.Run("concurrent rounds", func(t *testing.T) {
		w := newWorld(t)
		for round := range 12 {
			phone := w.secondSession(t)
			var wait sync.WaitGroup
			var created ScheduledMessage
			var createErr, eventErr error
			wait.Add(2)
			go func() {
				defer wait.Done()
				created, _, createErr = w.service.Create(ctx, phone, w.groupID, w.input("racing"))
			}()
			go func() {
				defer wait.Done()
				_, eventErr = w.identityRepo().RevokeOtherSessions(ctx, w.author.User.ActorID, w.author.SessionID, time.Now())
			}()
			wait.Wait()
			if eventErr != nil {
				t.Fatalf("round %d: %v", round, eventErr)
			}
			if createErr != nil {
				if !errors.Is(createErr, ErrForbidden) {
					t.Fatalf("round %d: %v", round, createErr)
				}
				continue
			}
			w.makeDue(t, created.ID)
			w.deliver(t, created)
			if w.sentCount(t, created) != 0 {
				t.Fatalf("round %d: message scheduled across the event was sent", round)
			}
		}
	})
}

// Item 10: a hundred messages due at the same second all go out, through
// concurrent jobs, without deadlocks.
func TestManyMessagesAtTheSameTime(t *testing.T) {
	ctx := context.Background()
	w := newWorld(t)
	w.service.SetLimits(Limits{PerAuthor: 1000, PerChat: 1000})
	items := make([]ScheduledMessage, 0, 100)
	for range 100 {
		items = append(items, w.create(t, w.groupID, w.input("together")))
	}
	w.exec(t, `UPDATE scheduled_messages SET send_at = date_trunc('second', now()) - interval '1 second'`)
	work := make(chan ScheduledMessage)
	errs := make(chan error, len(items))
	var wait sync.WaitGroup
	for range 8 {
		wait.Add(1)
		go func() {
			defer wait.Done()
			for item := range work {
				errs <- w.service.Deliver(ctx, item.ID, *w.load(t, item.ID).riverJobID)
			}
		}()
	}
	for _, item := range items {
		work <- item
	}
	close(work)
	wait.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatal(err)
		}
	}
	if got := w.count(t, `SELECT count(*) FROM scheduled_messages WHERE status='sent'`); got != 100 {
		t.Fatalf("sent = %d, want 100", got)
	}
}

// Item 7: a message that could not go out in time fails instead of arriving
// late.
func TestLateDeliveryFails(t *testing.T) {
	w := newWorld(t)
	item := w.create(t, w.groupID, w.input("too late"))
	w.exec(t, `UPDATE scheduled_messages SET send_at = now() - interval '16 minutes' WHERE id=$1`, item.ID)
	w.deliver(t, item)
	if reason := w.load(t, item.ID).FailureReason; reason == nil || *reason != ReasonMissedSendTime || w.sentCount(t, item) != 0 {
		t.Fatalf("reason = %v", reason)
	}
	onTime := w.create(t, w.groupID, w.input("a bit late"))
	w.exec(t, `UPDATE scheduled_messages SET send_at = now() - interval '14 minutes' WHERE id=$1`, onTime.ID)
	w.deliver(t, onTime)
	if w.load(t, onTime.ID).Status != StatusSent {
		t.Fatal("message within the window was not sent")
	}
}

// Item 8: an edit based on a version older than a send-now reports a
// version conflict.
func TestEditAfterSendNowIsAVersionConflict(t *testing.T) {
	ctx := context.Background()
	w := newWorld(t)
	item := w.create(t, w.groupID, w.input("now"))
	if _, err := w.service.SendNow(ctx, w.author, item.ID); err != nil {
		t.Fatal(err)
	}
	body := "too late"
	if _, err := w.service.Update(ctx, w.author, item.ID, UpdateInput{ExpectedVersion: item.Version, Body: &body}); !errors.Is(err, ErrVersionConflict) {
		t.Fatalf("Update() error = %v, want ErrVersionConflict", err)
	}
	sent := w.load(t, item.ID)
	if _, err := w.service.Update(ctx, w.author, item.ID, UpdateInput{ExpectedVersion: sent.Version, Body: &body}); !errors.Is(err, ErrClosed) {
		t.Fatalf("Update() with the current version error = %v, want ErrClosed", err)
	}
}

func TestNoLiveSessionCannotSchedule(t *testing.T) {
	w := newWorld(t)
	w.exec(t, `UPDATE sessions SET revoked_at=now() WHERE id=$1`, w.author.SessionID)
	if _, _, err := w.service.Create(context.Background(), w.author, w.groupID, w.input("x")); !errors.Is(err, ErrForbidden) {
		t.Fatalf("Create() with a revoked session error = %v", err)
	}
	w2 := newWorld(t)
	w2.exec(t, `UPDATE users SET must_change_password_at=now() WHERE actor_id=$1`, w2.author.User.ActorID)
	if _, _, err := w2.service.Create(context.Background(), w2.author, w2.groupID, w2.input("x")); !errors.Is(err, ErrForbidden) {
		t.Fatalf("Create() with a required password change error = %v", err)
	}
}

// setRefresh gives a session a known refresh token, live or expired.
func (w *world) setRefresh(t *testing.T, sessionID, token string, expired bool) []byte {
	t.Helper()
	hash := sha256.Sum256([]byte(token))
	expires := "now() + interval '1 day'"
	if expired {
		expires = "now() - interval '1 minute'"
	}
	w.exec(t, `UPDATE sessions SET refresh_hash=$2, created_at=now() - interval '2 days', expires_at=`+expires+` WHERE id=$1`, sessionID, hash[:])
	return hash[:]
}

func (w *world) rotate(hash []byte) error {
	fresh := sha256.Sum256([]byte(uuid.NewString()))
	_, err := w.identityRepo().RotateSession(context.Background(), hash, identity.NewSession{
		ID: uuid.NewString(), RefreshHash: fresh[:], ExpiresAt: time.Now().Add(time.Hour),
	}, time.Now())
	return err
}

// Item 8: an edit that reaches the server between "send now" committing and
// the delivery is a version conflict, and the text the author saw goes out.
func TestEditBetweenSendNowAndDeliveryConflicts(t *testing.T) {
	ctx := context.Background()
	w := newWorld(t)
	item := w.create(t, w.groupID, w.input("as seen"))
	if err := w.service.prepareSendNow(ctx, w.author, item.ID); err != nil {
		t.Fatal(err)
	}
	if got := w.load(t, item.ID); got.Version != item.Version+1 || got.Status != StatusPending {
		t.Fatalf("after prepare: version %d status %s", got.Version, got.Status)
	}
	body := "slipped in"
	if _, err := w.service.Update(ctx, w.author, item.ID, UpdateInput{ExpectedVersion: item.Version, Body: &body}); !errors.Is(err, ErrVersionConflict) {
		t.Fatalf("Update() error = %v, want ErrVersionConflict", err)
	}
	if err := w.service.Deliver(ctx, item.ID, 0); err != nil {
		t.Fatal(err)
	}
	sent := w.load(t, item.ID)
	var text string
	if err := w.pool.QueryRow(ctx, `SELECT body FROM messages WHERE id=$1`, *sent.MessageID).Scan(&text); err != nil || text != "as seen" {
		t.Fatalf("sent text = %q error=%v", text, err)
	}
	events := w.events(t, item.ID)
	if len(events) < 2 || events[1].Type != "scheduled_message.updated" {
		t.Fatalf("send now did not announce the new version: %#v", events)
	}
}

// Item 3 of the first review, probed again: the reserved id stays reserved
// after delivery, and after retention it can only replay the delivered
// message, never create a second one.
func TestReservedClientIDAfterDeliveryAndRetention(t *testing.T) {
	ctx := context.Background()
	w := newWorld(t)
	item := w.create(t, w.groupID, w.input("reserved"))
	clientID := MessageClientID(item.ID)
	if _, _, err := w.messages.Create(ctx, w.other.User, w.groupID, message.CreateInput{ClientMsgID: clientID, Body: "other", BodyFormat: "plain"}); err != nil {
		t.Fatalf("another author with the same uuid: %v", err)
	}
	w.makeDue(t, item.ID)
	w.deliver(t, item)
	if _, _, err := w.messages.Create(ctx, w.author.User, w.groupID, message.CreateInput{ClientMsgID: clientID, Body: "reserved", BodyFormat: "plain"}); !errors.Is(err, message.ErrIdempotencyConflict) {
		t.Fatalf("reserved id after delivery: %v", err)
	}
	w.exec(t, `DELETE FROM scheduled_messages WHERE id=$1`, item.ID)
	if _, created, err := w.messages.Create(ctx, w.author.User, w.groupID, message.CreateInput{ClientMsgID: clientID, Body: "reserved", BodyFormat: "plain"}); created {
		t.Fatalf("after retention: a second message (err=%v)", err)
	}
	if got := w.count(t, `SELECT count(*) FROM messages WHERE actor_id=$1 AND client_msg_id=$2`, w.author.User.ActorID, clientID); got != 1 {
		t.Fatalf("author's messages with the id = %d, want 1", got)
	}
}

// Item 4: stale revoked family marks go; a mark a pending message still
// refers to stays, even past the horizon.
func TestRevokedFamilyMarksAreCleanedUp(t *testing.T) {
	ctx := context.Background()
	w := newWorld(t)
	phone := w.secondSession(t)
	if _, _, err := w.service.Create(ctx, phone, w.groupID, w.input("waits")); err != nil {
		t.Fatal(err)
	}
	oldUnused, recent := uuid.NewString(), uuid.NewString()
	w.exec(t, `INSERT INTO revoked_session_families (family_id, org_id, actor_id, reason, revoked_at) VALUES
		($1, $4, $5, 'device_revoked', now() - interval '400 days'),
		($2, $4, $5, 'device_revoked', now() - interval '400 days'),
		($3, $4, $5, 'device_revoked', now())`, oldUnused, phone.SessionID, recent, w.orgID, w.author.User.ActorID)
	// Keep the phone's message pending, as if the sweep had not reached it.
	reconcileStopped = func(context.Context, *pgxpool.Pool, string, string) (int64, error) { return 0, nil }
	defer func() { reconcileStopped = scheduledreset.Reconcile }()
	if _, err := w.service.Cleanup(ctx); err != nil {
		t.Fatal(err)
	}
	for family, want := range map[string]int{oldUnused: 0, recent: 1, phone.SessionID: 1} {
		if got := w.count(t, `SELECT count(*) FROM revoked_session_families WHERE family_id=$1`, family); got != want {
			t.Fatalf("mark %s: count %d, want %d", family, got, want)
		}
	}
	// Once the message is failed, the mark goes on the next pass.
	reconcileStopped = scheduledreset.Reconcile
	if _, err := w.service.Cleanup(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err := w.service.Cleanup(ctx); err != nil {
		t.Fatal(err)
	}
	if got := w.count(t, `SELECT count(*) FROM revoked_session_families WHERE family_id=$1`, phone.SessionID); got != 0 {
		t.Fatal("mark kept after its message failed")
	}
}

// Item 5: one person's failing reconcile does not stop the pass, and the
// step after a security event wakes realtime.
func TestCleanupSurvivesReconcileErrorsAndWakesRealtime(t *testing.T) {
	ctx := context.Background()
	w := newWorld(t)
	stopped := w.create(t, w.groupID, w.input("stopped"))
	old := w.create(t, w.groupID, w.input("old"))
	if err := w.service.MarkDeliveryFailed(ctx, old.ID, 0); err != nil {
		t.Fatal(err)
	}
	w.exec(t, `UPDATE scheduled_messages SET updated_at = now() - interval '31 days' WHERE id=$1`, old.ID)
	w.exec(t, `UPDATE users SET security_epoch = security_epoch + 1 WHERE actor_id=$1`, w.author.User.ActorID)
	broken := errors.New("reconcile broke")
	reconcileStopped = func(context.Context, *pgxpool.Pool, string, string) (int64, error) { return 0, broken }
	defer func() { reconcileStopped = scheduledreset.Reconcile }()
	removed, err := w.service.Cleanup(ctx)
	if !errors.Is(err, broken) || removed != 1 {
		t.Fatalf("Cleanup() = %d, %v; want the old record removed and the error reported", removed, err)
	}
	if w.load(t, stopped.ID).Status != StatusPending {
		t.Fatal("test setup: the broken reconcile changed the record")
	}

	var woke []int64
	scheduledreset.SetAfterCommit(func(orgID string, seq int64) {
		if orgID == w.orgID {
			woke = append(woke, seq)
		}
	})
	defer scheduledreset.SetAfterCommit(nil)
	if _, err := w.identityRepo().ChangePassword(ctx, w.orgID, w.author.User.ActorID, w.author.SessionID, "hash", uuid.NewString(), time.Now()); err != nil {
		t.Fatal(err)
	}
	if len(woke) != 1 || woke[0] == 0 {
		t.Fatalf("realtime wake-ups = %v", woke)
	}
	if w.load(t, stopped.ID).Status != StatusFailed {
		t.Fatal("record not failed right after the event")
	}
}
