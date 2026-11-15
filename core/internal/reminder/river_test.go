package reminder_test

import (
	"context"
	"io"
	"log/slog"
	"testing"
	"time"

	"github.com/comamessenger/comamessenger/core/internal/reminder"
)

// startRiver runs the real River client of reminders. The service clock is
// set back so a reminder a few seconds ahead passes the one-minute rule.
func startRiver(t *testing.T, w *world) {
	t.Helper()
	client, err := reminder.NewClient(w.pool, w.service, slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	if err := client.Start(ctx); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		cancel()
		stopCtx, stop := context.WithTimeout(context.Background(), 5*time.Second)
		defer stop()
		_ = client.Stop(stopCtx)
	})
	w.service.SetClock(func() time.Time { return time.Now().Add(-2 * time.Minute) })
}

func waitFor(t *testing.T, what string, check func() bool) {
	t.Helper()
	deadline := time.Now().Add(30 * time.Second)
	for !check() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", what)
		}
		time.Sleep(100 * time.Millisecond)
	}
}

func TestRiverFiresOnTime(t *testing.T) {
	w := newWorld(t)
	startRiver(t, w)
	ctx := context.Background()
	target := w.post(t, w.chatID, "x")
	before := w.seq(t)
	item, _, err := w.service.Set(ctx, w.member, target.ID, reminder.SetInput{RemindAt: time.Now().Add(2 * time.Second)})
	if err != nil {
		t.Fatal(err)
	}
	if got := w.count(t, `SELECT count(*) FROM river_job j JOIN message_reminders r ON r.river_job_id = j.id
		WHERE r.id = $1 AND j.kind = 'message_reminder.fire' AND j.queue = 'reminders' AND j.max_attempts = 8
		  AND j.args::text NOT LIKE '%x%'`, item.ID); got != 1 {
		t.Fatalf("fire jobs = %d", got)
	}
	// Not before its time.
	time.Sleep(time.Second)
	if state, _, _, _ := w.load(t, item.ID); state != reminder.StatePending {
		t.Fatalf("fired early: %s", state)
	}
	waitFor(t, "the reminder to fire", func() bool {
		state, _, _, _ := w.load(t, item.ID)
		return state == reminder.StateFired
	})
	var firedAt, remindAt time.Time
	if err := w.pool.QueryRow(ctx, `SELECT fired_at, remind_at FROM message_reminders WHERE id = $1`, item.ID).Scan(&firedAt, &remindAt); err != nil {
		t.Fatal(err)
	}
	if firedAt.Before(remindAt) || firedAt.Sub(remindAt) > 10*time.Second {
		t.Fatalf("fired at %s for %s", firedAt, remindAt)
	}
	fired := 0
	for _, event := range w.eventsAfter(t, before) {
		if event.Type == reminder.EventFired {
			fired++
		}
	}
	if fired != 1 {
		t.Fatalf("fired events = %d", fired)
	}
}

func TestRiverMovedReminderFiresOnlyAtTheNewTime(t *testing.T) {
	w := newWorld(t)
	startRiver(t, w)
	ctx := context.Background()
	target := w.post(t, w.chatID, "x")
	item, _, err := w.service.Set(ctx, w.member, target.ID, reminder.SetInput{RemindAt: time.Now().Add(2 * time.Second)})
	if err != nil {
		t.Fatal(err)
	}
	var firstJob int64
	if err := w.pool.QueryRow(ctx, `SELECT river_job_id FROM message_reminders WHERE id = $1`, item.ID).Scan(&firstJob); err != nil {
		t.Fatal(err)
	}
	// Moved an hour ahead: the old job is cancelled and, if it ran anyway,
	// would find a newer job id and do nothing.
	if _, _, err := w.service.Set(ctx, w.member, target.ID, reminder.SetInput{RemindAt: time.Now().Add(time.Hour)}); err != nil {
		t.Fatal(err)
	}
	if got := w.count(t, `SELECT count(*) FROM river_job WHERE id = $1 AND state = 'cancelled'`, firstJob); got != 1 {
		t.Fatal("the job of the old time was not cancelled")
	}
	if err := w.service.Fire(ctx, item.ID, firstJob); err != nil {
		t.Fatal(err)
	}
	time.Sleep(3 * time.Second)
	if state, _, _, _ := w.load(t, item.ID); state != reminder.StatePending {
		t.Fatalf("moved reminder fired at the old time: %s", state)
	}
	// Closed: its job is cancelled too.
	var secondJob int64
	if err := w.pool.QueryRow(ctx, `SELECT river_job_id FROM message_reminders WHERE id = $1`, item.ID).Scan(&secondJob); err != nil {
		t.Fatal(err)
	}
	if err := w.service.DeleteByMessage(ctx, w.member, target.ID); err != nil {
		t.Fatal(err)
	}
	if got := w.count(t, `SELECT count(*) FROM river_job WHERE id = $1 AND state = 'cancelled'`, secondJob); got != 1 {
		t.Fatal("the job of a closed reminder was not cancelled")
	}
}

// A transient failure is retried by River; the retry fires the reminder
// once.
func TestRiverRetriesAfterAFailure(t *testing.T) {
	w := newWorld(t)
	// The first attempt to mark the reminder fired fails, as a lost
	// connection would. A sequence is not rolled back with the attempt.
	w.exec(t, `CREATE SEQUENCE fire_attempts`)
	w.exec(t, `CREATE FUNCTION fail_first_fire() RETURNS trigger LANGUAGE plpgsql AS $$
		BEGIN
			IF NEW.state = 'fired' AND OLD.state = 'pending' AND nextval('fire_attempts') = 1 THEN
				RAISE EXCEPTION 'simulated failure';
			END IF;
			RETURN NEW;
		END $$`)
	w.exec(t, `CREATE TRIGGER fail_first_fire BEFORE UPDATE ON message_reminders FOR EACH ROW EXECUTE FUNCTION fail_first_fire()`)
	startRiver(t, w)
	ctx := context.Background()
	target := w.post(t, w.chatID, "x")
	before := w.seq(t)
	item, _, err := w.service.Set(ctx, w.member, target.ID, reminder.SetInput{RemindAt: time.Now().Add(time.Second)})
	if err != nil {
		t.Fatal(err)
	}
	waitFor(t, "the retried reminder to fire", func() bool {
		state, _, _, _ := w.load(t, item.ID)
		return state == reminder.StateFired
	})
	if got := w.count(t, `SELECT count(*) FROM river_job j JOIN message_reminders r ON r.id = $1
		WHERE j.kind = 'message_reminder.fire' AND j.attempt >= 2 AND j.args->>'reminder_id' = $1::text`, item.ID); got != 1 {
		t.Fatalf("retried jobs = %d", got)
	}
	fired := 0
	for _, event := range w.eventsAfter(t, before) {
		if event.Type == reminder.EventFired {
			fired++
		}
	}
	if fired != 1 {
		t.Fatalf("fired events = %d", fired)
	}
	if got := w.count(t, `SELECT count(*) FROM notification_jobs WHERE org_id = $1 AND event_seq > $2`, w.owner.OrgID, before); got != 1 {
		t.Fatalf("push jobs = %d", got)
	}
}
