package scheduled

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/comamessenger/comamessenger/core/internal/message"
	"github.com/google/uuid"
)

// failNow makes the record fail as the delivery job would: its time passed
// long ago, so it missed it.
func (w *world) failNow(t *testing.T, item ScheduledMessage) ScheduledMessage {
	t.Helper()
	w.exec(t, `UPDATE scheduled_messages SET send_at = now() - interval '1 hour' WHERE id = $1`, item.ID)
	w.deliver(t, item)
	record := w.load(t, item.ID)
	if record.Status != StatusFailed || record.FailureReason == nil || *record.FailureReason != ReasonMissedSendTime {
		t.Fatalf("record did not fail: %#v", record)
	}
	return record
}

func notRetryable(t *testing.T, err error, reason string) {
	t.Helper()
	var refusal *NotRetryableError
	if !errors.Is(err, ErrNotRetryable) || !errors.As(err, &refusal) || refusal.Reason != reason {
		t.Fatalf("error = %v, want not retryable because of %s", err, reason)
	}
}

func fileIDs(item ScheduledMessage) []string {
	result := []string{}
	for _, file := range item.Files {
		result = append(result, file.ID)
	}
	return result
}

func TestUpdateReplacesFiles(t *testing.T) {
	w := newWorld(t)
	ctx := context.Background()
	first, second := w.file(t, w.author), w.file(t, w.author)
	input := w.input("with a file")
	input.FileIDs = []string{first}
	item := w.create(t, w.groupID, input)

	replace := func(version int, ids ...string) (ScheduledMessage, error) {
		return w.service.Update(ctx, w.author, item.ID, UpdateInput{ExpectedVersion: version, FileIDs: &ids})
	}
	updated, err := replace(item.Version, second, first)
	if err != nil {
		t.Fatal(err)
	}
	if got := fileIDs(updated); len(got) != 2 || got[0] != second || got[1] != first {
		t.Fatalf("files = %v", got)
	}
	updated, err = replace(updated.Version, second)
	if err != nil {
		t.Fatal(err)
	}
	// The dropped file is unattached again and falls under the ordinary cleanup.
	if got := w.count(t, `SELECT count(*) FROM scheduled_message_files WHERE file_id=$1`, first); got != 0 {
		t.Fatalf("dropped file still attached: %d", got)
	}
	if _, err := replace(item.Version, first); !errors.Is(err, ErrVersionConflict) {
		t.Fatalf("stale version: %v", err)
	}

	refused := map[string][]string{}
	refused["someone else's file"] = []string{w.file(t, w.other)}
	notReady := w.file(t, w.author)
	w.exec(t, `UPDATE files SET status='pending', ready_at=NULL WHERE id=$1`, notReady)
	refused["a file not ready yet"] = []string{notReady}
	many := []string{}
	for range 11 {
		many = append(many, w.file(t, w.author))
	}
	refused["more than ten files"] = many
	other := w.input("another")
	elsewhere := w.file(t, w.author)
	other.FileIDs = []string{elsewhere}
	w.create(t, w.groupID, other)
	refused["a file of another scheduled message"] = []string{elsewhere}
	sentFile := w.file(t, w.author)
	if _, _, err := w.messages.Create(ctx, w.author.User, w.groupID, message.CreateInput{ClientMsgID: uuid.NewString(), FileIDs: []string{sentFile}}); err != nil {
		t.Fatal(err)
	}
	refused["a file of a sent message"] = []string{sentFile}
	for name, ids := range refused {
		if _, err := replace(updated.Version, ids...); !errors.Is(err, ErrInvalid) {
			t.Errorf("%s: error = %v, want invalid", name, err)
		}
	}
	if got := fileIDs(w.mustGet(t, item.ID)); len(got) != 1 || got[0] != second {
		t.Fatalf("a refused change touched the files: %v", got)
	}

	// Creation applies the same rule.
	again := w.input("reuse")
	again.FileIDs = []string{elsewhere}
	if _, _, err := w.service.Create(ctx, w.author, w.groupID, again); !errors.Is(err, ErrInvalid) {
		t.Fatalf("Create() with a taken file: %v", err)
	}

	// Removing every file is allowed when there is text; delivery then
	// carries the files the record has at that moment.
	updated, err = replace(updated.Version, second)
	if err != nil {
		t.Fatal(err)
	}
	w.makeDue(t, item.ID)
	w.deliver(t, item)
	if got := w.count(t, `SELECT count(*) FROM message_files mf JOIN messages m ON m.id=mf.message_id WHERE m.client_msg_id=$1 AND mf.file_id=$2`, MessageClientID(item.ID), second); got != 1 {
		t.Fatal("the sent message does not carry the file")
	}
	empty := []string{}
	if _, err := w.service.Update(ctx, w.author, item.ID, UpdateInput{ExpectedVersion: w.load(t, item.ID).Version, FileIDs: &empty}); !errors.Is(err, ErrClosed) {
		t.Fatalf("change after sending: %v", err)
	}
}

func (w *world) mustGet(t *testing.T, id string) ScheduledMessage {
	t.Helper()
	item, err := w.service.Get(context.Background(), w.author, id)
	if err != nil {
		t.Fatal(err)
	}
	return item
}

func TestSendFailedAgain(t *testing.T) {
	ctx := context.Background()

	t.Run("only the author with a live session", func(t *testing.T) {
		w := newWorld(t)
		failed := w.failNow(t, w.create(t, w.groupID, w.input("again")))
		for _, stranger := range []Author{w.other, w.admin, w.owner} {
			if _, err := w.service.SendNow(ctx, stranger, failed.ID); !errors.Is(err, ErrNotFound) {
				t.Fatalf("someone else sent it: %v", err)
			}
			at := time.Now().Add(time.Hour)
			if _, err := w.service.Update(ctx, stranger, failed.ID, UpdateInput{ExpectedVersion: failed.Version, SendAt: &at}); !errors.Is(err, ErrNotFound) {
				t.Fatalf("someone else rescheduled it: %v", err)
			}
		}
		if _, err := w.service.SendNow(ctx, Author{User: w.author.User}, failed.ID); !errors.Is(err, ErrForbidden) {
			t.Fatalf("API key sent it: %v", err)
		}
		w.exec(t, `UPDATE sessions SET revoked_at=now() WHERE id=$1`, w.author.SessionID)
		if _, err := w.service.SendNow(ctx, w.author, failed.ID); !errors.Is(err, ErrForbidden) {
			t.Fatalf("revoked session sent it: %v", err)
		}
		if record := w.load(t, failed.ID); record.Status != StatusFailed || record.Version != failed.Version {
			t.Fatalf("a refusal changed the record: %#v", record)
		}
	})

	t.Run("send now", func(t *testing.T) {
		w := newWorld(t)
		failed := w.failNow(t, w.create(t, w.groupID, w.input("again")))
		result, err := w.service.SendNow(ctx, w.author, failed.ID)
		if err != nil {
			t.Fatal(err)
		}
		if result.Status != StatusSent || w.sentCount(t, failed) != 1 {
			t.Fatalf("SendNow() = %#v", result)
		}
		events := w.events(t, failed.ID)
		last := events[len(events)-1]
		if last.Type != "scheduled_message.sent" || *last.Audience != w.author.User.ActorID {
			t.Fatalf("events = %#v", events)
		}
		for _, item := range events {
			assertEventShape(t, item.Data)
		}
		if _, err := w.service.SendNow(ctx, w.author, failed.ID); !errors.Is(err, ErrClosed) {
			t.Fatalf("sent twice: %v", err)
		}
	})

	t.Run("edit then send now", func(t *testing.T) {
		w := newWorld(t)
		failed := w.failNow(t, w.create(t, w.groupID, w.input("typo")))
		body := "fixed"
		edited, err := w.service.Update(ctx, w.author, failed.ID, UpdateInput{ExpectedVersion: failed.Version, Body: &body})
		if err != nil {
			t.Fatal(err)
		}
		if edited.Status != StatusFailed || edited.Body != "fixed" || edited.Version != failed.Version+1 {
			t.Fatalf("edit of a failed message = %#v", edited)
		}
		if _, err := w.service.SendNow(ctx, w.author, failed.ID); err != nil {
			t.Fatal(err)
		}
		if got := w.count(t, `SELECT count(*) FROM messages WHERE client_msg_id=$1 AND body='fixed'`, MessageClientID(failed.ID)); got != 1 {
			t.Fatal("the edited text was not sent")
		}
	})

	t.Run("reschedule re-stamps the request", func(t *testing.T) {
		w := newWorld(t)
		item := w.create(t, w.groupID, w.input("after the reset"))
		// The password changes on this very device: the message stops, the
		// device keeps its session.
		if _, err := w.identityRepo().ChangePassword(ctx, w.orgID, w.author.User.ActorID, w.author.SessionID, "hash", uuid.NewString(), time.Now()); err != nil {
			t.Fatal(err)
		}
		failed := w.load(t, item.ID)
		if failed.Status != StatusFailed || *failed.FailureReason != ReasonSecurityReset {
			t.Fatalf("record = %#v", failed)
		}
		at := time.Now().Add(time.Hour)
		result, err := w.service.Update(ctx, w.author, item.ID, UpdateInput{ExpectedVersion: failed.Version, SendAt: &at})
		if err != nil {
			t.Fatal(err)
		}
		record := w.load(t, item.ID)
		if result.Status != StatusPending || result.FailureReason != nil || result.FailedAt != nil || record.riverJobID == nil {
			t.Fatalf("rescheduled = %#v", result)
		}
		var epoch int64
		if err := w.pool.QueryRow(ctx, `SELECT security_epoch FROM users WHERE actor_id=$1`, w.author.User.ActorID).Scan(&epoch); err != nil {
			t.Fatal(err)
		}
		if record.securityEpoch != epoch {
			t.Fatalf("epoch %d, want %d", record.securityEpoch, epoch)
		}
		w.makeDue(t, item.ID)
		w.deliver(t, item)
		if w.sentCount(t, item) != 1 {
			t.Fatal("the rescheduled message was not sent")
		}
	})

	t.Run("causes that still hold", func(t *testing.T) {
		cases := []struct {
			name   string
			break_ func(w *world, item ScheduledMessage)
			reason string
		}{
			{"chat archived", func(w *world, _ ScheduledMessage) {
				w.exec(t, `UPDATE chats SET archived_at=now() WHERE id=$1`, w.groupID)
			}, ReasonChatUnavailable},
			{"left the chat", func(w *world, _ ScheduledMessage) {
				w.exec(t, `DELETE FROM chat_members WHERE chat_id=$1 AND actor_id=$2`, w.groupID, w.author.User.ActorID)
			}, ReasonNotMember},
			{"may no longer write", func(w *world, _ ScheduledMessage) {
				w.exec(t, `UPDATE chats SET kind='channel' WHERE id=$1`, w.groupID)
			}, ReasonForbidden},
			{"attachment deleted", func(w *world, item ScheduledMessage) {
				w.exec(t, `UPDATE files SET status='deleted', deleted_at=now() WHERE id IN (SELECT file_id FROM scheduled_message_files WHERE scheduled_message_id=$1)`, item.ID)
			}, ReasonAttachmentUnavailable},
			{"reply target deleted", func(w *world, item ScheduledMessage) {
				w.exec(t, `UPDATE messages SET deleted_at=now() WHERE id=$1`, *item.ReplyToID)
			}, ReasonReferenceUnavailable},
		}
		for _, tc := range cases {
			t.Run(tc.name, func(t *testing.T) {
				w := newWorld(t)
				target, _, err := w.messages.Create(ctx, w.other.User, w.groupID, message.CreateInput{ClientMsgID: uuid.NewString(), Body: "original"})
				if err != nil {
					t.Fatal(err)
				}
				input := w.input("doomed")
				input.FileIDs = []string{w.file(t, w.author)}
				input.ReplyToID = &target.ID
				failed := w.failNow(t, w.create(t, w.groupID, input))
				tc.break_(w, failed)
				_, err = w.service.SendNow(ctx, w.author, failed.ID)
				notRetryable(t, err, tc.reason)
				at := time.Now().Add(time.Hour)
				_, err = w.service.Update(ctx, w.author, failed.ID, UpdateInput{ExpectedVersion: failed.Version, SendAt: &at})
				notRetryable(t, err, tc.reason)
				if record := w.load(t, failed.ID); record.Status != StatusFailed || record.Version != failed.Version || *record.FailureReason != ReasonMissedSendTime {
					t.Fatalf("a refused retry changed the record: %#v", record)
				}
				if w.sentCount(t, failed) != 0 {
					t.Fatal("a refused retry sent the message")
				}
			})
		}
	})

	t.Run("limits count the record coming back", func(t *testing.T) {
		w := newWorld(t)
		failed := w.failNow(t, w.create(t, w.groupID, w.input("again")))
		w.service.SetLimits(Limits{PerAuthor: 10, PerChat: 1})
		w.create(t, w.groupID, w.input("waiting"))
		at := time.Now().Add(time.Hour)
		if _, err := w.service.Update(ctx, w.author, failed.ID, UpdateInput{ExpectedVersion: failed.Version, SendAt: &at}); !errors.Is(err, ErrLimitReached) {
			t.Fatalf("reschedule over the limit: %v", err)
		}
		if _, err := w.service.SendNow(ctx, w.author, failed.ID); !errors.Is(err, ErrLimitReached) {
			t.Fatalf("send now over the limit: %v", err)
		}
	})
}

// Retention removes failed records after a month. A retry that locked the
// record first and made it pending again must survive the removal that
// picked it before.
func TestRetryRacesRetention(t *testing.T) {
	ctx := context.Background()
	t.Run("removal waits for the retry and rechecks", func(t *testing.T) {
		w := newWorld(t)
		failed := w.failNow(t, w.create(t, w.groupID, w.input("old")))
		w.exec(t, `UPDATE scheduled_messages SET updated_at = now() - interval '31 days' WHERE id=$1`, failed.ID)
		tx, err := w.pool.Begin(ctx)
		if err != nil {
			t.Fatal(err)
		}
		defer tx.Rollback(ctx)
		// What prepareSendNow does under the record lock.
		if _, err := tx.Exec(ctx, `UPDATE scheduled_messages SET status='pending', failure_reason=NULL, failed_at=NULL, send_at=now(), version=version+1, updated_at=now() WHERE id=$1`, failed.ID); err != nil {
			t.Fatal(err)
		}
		done := make(chan error, 1)
		go func() { _, err := w.service.Cleanup(ctx); done <- err }()
		w.waitForLock(t)
		if err := tx.Commit(ctx); err != nil {
			t.Fatal(err)
		}
		if err := <-done; err != nil {
			t.Fatal(err)
		}
		if got := w.count(t, `SELECT count(*) FROM scheduled_messages WHERE id=$1`, failed.ID); got != 1 {
			t.Fatal("retention removed a message being sent again")
		}
	})
	t.Run("rounds", func(t *testing.T) {
		w := newWorld(t)
		for round := range 10 {
			failed := w.failNow(t, w.create(t, w.groupID, w.input("old")))
			w.exec(t, `UPDATE scheduled_messages SET updated_at = now() - interval '31 days' WHERE id=$1`, failed.ID)
			var wait sync.WaitGroup
			var sendErr, cleanupErr error
			wait.Add(2)
			go func() { defer wait.Done(); _, sendErr = w.service.SendNow(ctx, w.author, failed.ID) }()
			go func() { defer wait.Done(); _, cleanupErr = w.service.Cleanup(ctx) }()
			wait.Wait()
			if cleanupErr != nil {
				t.Fatal(cleanupErr)
			}
			exists := w.count(t, `SELECT count(*) FROM scheduled_messages WHERE id=$1`, failed.ID) == 1
			sent := w.sentCount(t, failed)
			switch {
			case sendErr == nil && exists && sent == 1 && w.load(t, failed.ID).Status == StatusSent:
			case errors.Is(sendErr, ErrNotFound) && !exists && sent == 0:
			default:
				t.Fatalf("round %d: send error %v, record exists %v, messages %d", round, sendErr, exists, sent)
			}
		}
	})
}

// waitForLock waits until some query of the test database waits for a row
// lock.
func (w *world) waitForLock(t *testing.T) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if w.count(t, `SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock'`) > 0 {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("nothing waited for the lock")
}

func TestTwoRetriesAtOnce(t *testing.T) {
	ctx := context.Background()
	w := newWorld(t)
	for round := range 10 {
		failed := w.failNow(t, w.create(t, w.groupID, w.input("twice")))
		at := time.Now().Add(time.Hour)
		errs := make([]error, 4)
		var wait sync.WaitGroup
		wait.Add(4)
		go func() { defer wait.Done(); _, errs[0] = w.service.SendNow(ctx, w.author, failed.ID) }()
		go func() { defer wait.Done(); _, errs[1] = w.service.SendNow(ctx, w.author, failed.ID) }()
		go func() {
			defer wait.Done()
			_, errs[2] = w.service.Update(ctx, w.author, failed.ID, UpdateInput{ExpectedVersion: failed.Version, SendAt: &at})
		}()
		go func() {
			defer wait.Done()
			_, errs[3] = w.service.Update(ctx, w.author, failed.ID, UpdateInput{ExpectedVersion: failed.Version, SendAt: &at})
		}()
		wait.Wait()
		for i, err := range errs {
			if err != nil && !errors.Is(err, ErrClosed) && !errors.Is(err, ErrVersionConflict) {
				t.Fatalf("round %d, retry %d: %v", round, i, err)
			}
		}
		// Of the two edits from the same version, at most one wins.
		if errs[2] == nil && errs[3] == nil {
			t.Fatalf("round %d: both edits of version %d succeeded", round, failed.Version)
		}
		if sent := w.sentCount(t, failed); sent > 1 {
			t.Fatalf("round %d: sent %d times", round, sent)
		}
		record := w.load(t, failed.ID)
		if record.Status == StatusSent && w.sentCount(t, failed) != 1 {
			t.Fatalf("round %d: sent record without its message", round)
		}
		if record.Status == StatusPending && w.sentCount(t, failed) != 0 {
			t.Fatalf("round %d: pending record already sent", round)
		}
	}
}

// A retry and a new security event at the same time: either the retry is
// stamped after the event and may go, or the event stops it again. Nothing
// authorized before the event is sent.
func TestRetryRacesSecurityEvent(t *testing.T) {
	ctx := context.Background()
	w := newWorld(t)
	device := w.secondSession(t)
	for round := range 12 {
		item, _, err := w.service.Create(ctx, device, w.groupID, w.input("retry"))
		if err != nil {
			t.Fatal(err)
		}
		failed := w.failNow(t, item)
		var wait sync.WaitGroup
		var sendErr, eventErr error
		wait.Add(2)
		go func() { defer wait.Done(); _, sendErr = w.service.SendNow(ctx, device, failed.ID) }()
		go func() {
			defer wait.Done()
			// Signing out every other device ends the retrying device.
			_, eventErr = w.identityRepo().ChangePassword(ctx, w.orgID, w.author.User.ActorID, w.author.SessionID, "hash", uuid.NewString(), time.Now())
		}()
		wait.Wait()
		if eventErr != nil {
			t.Fatal(eventErr)
		}
		record := w.load(t, failed.ID)
		sent := w.sentCount(t, failed)
		switch {
		case sendErr == nil && record.Status == StatusSent && sent == 1:
			// The retry committed before the event.
		case sendErr == nil && record.Status == StatusFailed && *record.FailureReason == ReasonSecurityReset && sent == 0:
			// The event came between the retry and its delivery.
		case errors.Is(sendErr, ErrForbidden) && record.Status == StatusFailed && sent == 0:
			// The event came first: the device is signed out.
		default:
			t.Fatalf("round %d: send error %v, status %s, messages %d", round, sendErr, record.Status, sent)
		}
		if record.Status == StatusPending {
			t.Fatalf("round %d: a stale retry is still pending", round)
		}
		// The next round needs the device signed in again.
		device = w.secondSession(t)
	}
}

// Delete checks the session in the service too, not only at the HTTP layer.
func TestDeleteNeedsALiveSession(t *testing.T) {
	ctx := context.Background()
	w := newWorld(t)
	item := w.create(t, w.groupID, w.input("keep me"))
	if err := w.service.Delete(ctx, Author{User: w.author.User}, item.ID); !errors.Is(err, ErrForbidden) {
		t.Fatalf("delete without a session: %v", err)
	}
	device := w.secondSession(t)
	w.exec(t, `UPDATE sessions SET revoked_at=now() WHERE id=$1`, device.SessionID)
	if err := w.service.Delete(ctx, device, item.ID); !errors.Is(err, ErrForbidden) {
		t.Fatalf("delete from a revoked session: %v", err)
	}
	w.exec(t, `INSERT INTO revoked_session_families (family_id, org_id, actor_id, reason) VALUES ($1, $2, $3, 'device_revoked')`,
		w.author.SessionID, w.orgID, w.author.User.ActorID)
	if err := w.service.Delete(ctx, w.author, item.ID); !errors.Is(err, ErrForbidden) {
		t.Fatalf("delete from a revoked family: %v", err)
	}
	if got := w.count(t, `SELECT count(*) FROM scheduled_messages WHERE id=$1`, item.ID); got != 1 {
		t.Fatal("a refused delete removed the record")
	}
	if got := w.count(t, `SELECT count(*) FROM events WHERE subject_id=$1 AND type='scheduled_message.deleted'`, item.ID); got != 0 {
		t.Fatal("a refused delete told the devices")
	}
	// A live session of the author still can.
	if err := w.service.Delete(ctx, w.secondSession(t), item.ID); err != nil {
		t.Fatal(err)
	}
}

// A file belongs to one message or one scheduled message: an ordinary send
// cannot take a file waiting on a pending or failed scheduled message.
func TestOrdinarySendRefusesScheduledFiles(t *testing.T) {
	ctx := context.Background()
	w := newWorld(t)
	send := func(fileID string) error {
		_, _, err := w.messages.Create(ctx, w.author.User, w.groupID, message.CreateInput{ClientMsgID: uuid.NewString(), FileIDs: []string{fileID}})
		return err
	}
	waiting := w.file(t, w.author)
	input := w.input("with a file")
	input.FileIDs = []string{waiting}
	item := w.create(t, w.groupID, input)
	if err := send(waiting); !errors.Is(err, message.ErrInvalid) {
		t.Fatalf("pending: %v", err)
	}
	failed := w.failNow(t, item)
	if err := send(waiting); !errors.Is(err, message.ErrInvalid) {
		t.Fatalf("failed: %v", err)
	}
	// The failed message can still be sent again with its file, once.
	if _, err := w.service.SendNow(ctx, w.author, failed.ID); err != nil {
		t.Fatal(err)
	}
	if got := w.count(t, `SELECT count(*) FROM message_files WHERE file_id=$1`, waiting); got != 1 {
		t.Fatalf("file is in %d messages", got)
	}
	// A file of no scheduled message, or of a deleted one, sends as usual.
	if err := send(w.file(t, w.author)); err != nil {
		t.Fatal(err)
	}
	other := w.file(t, w.author)
	input = w.input("deleted")
	input.FileIDs = []string{other}
	deleted := w.create(t, w.groupID, input)
	if err := w.service.Delete(ctx, w.author, deleted.ID); err != nil {
		t.Fatal(err)
	}
	if err := send(other); err != nil {
		t.Fatalf("after deletion: %v", err)
	}
	// Forwarding carries no files and is not affected.
	sent, _, err := w.messages.Create(ctx, w.other.User, w.groupID, message.CreateInput{ClientMsgID: uuid.NewString(), Body: "forward me"})
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := w.messages.Forward(ctx, w.author.User, sent.ID, message.ForwardInput{ChatID: w.groupID, ClientMsgID: uuid.NewString()}); err != nil {
		t.Fatalf("forward: %v", err)
	}
}
