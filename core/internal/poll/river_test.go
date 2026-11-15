package poll_test

import (
	"context"
	"io"
	"log/slog"
	"testing"
	"time"

	"github.com/comamessenger/comamessenger/core/internal/message"
	"github.com/comamessenger/comamessenger/core/internal/poll"
	"github.com/google/uuid"
)

// The real River client closes a poll at its due date (message_poll.close
// in the polls queue) and tells the author.
func TestRiverClosesPollAtDueDate(t *testing.T) {
	w := newWorld(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	service := poll.NewService(w.pool, nil)
	client, err := poll.NewClient(w.pool, service, slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err != nil {
		t.Fatal(err)
	}
	if err := client.Start(ctx); err != nil {
		t.Fatal(err)
	}
	defer func() {
		stopCtx, stop := context.WithTimeout(context.Background(), 5*time.Second)
		defer stop()
		_ = client.Stop(stopCtx)
	}()
	messages := message.NewService(w.pool, 64*1024, 100, nil)
	messages.SetPolls(service)
	due := time.Now().Add(11 * time.Minute)
	created, _, err := messages.CreatePoll(ctx, w.author, w.chatID, message.CreatePollInput{
		ClientMsgID: uuid.NewString(), Question: "Срок", Options: []string{"a", "b"}, Multiple: ptr(false), Anonymous: ptr(false), DueAt: &due,
	})
	if err != nil {
		t.Fatal(err)
	}
	var queue string
	if err := w.pool.QueryRow(ctx, `SELECT queue FROM river_job WHERE kind=$1 AND args->>'message_id'=$2`, poll.KindClose, created.ID).Scan(&queue); err != nil || queue != "polls" {
		t.Fatalf("job queue = %q %v", queue, err)
	}
	// Move the due date into the past and the job to now.
	w.exec(t, `UPDATE message_polls SET due_at = now() - interval '1 second' WHERE message_id = $1`, created.ID)
	w.exec(t, `UPDATE river_job SET scheduled_at = now() WHERE kind = $1 AND args->>'message_id' = $2`, poll.KindClose, created.ID)
	deadline := time.Now().Add(15 * time.Second)
	for time.Now().Before(deadline) {
		if w.count(t, `SELECT count(*) FROM message_polls WHERE message_id=$1 AND status='closed' AND closed_reason='expired'`, created.ID) == 1 {
			if w.count(t, `SELECT count(*) FROM events WHERE subject_id=$1 AND type='poll.notified' AND audience_actor_id=$2`, created.ID, w.author.ActorID) != 1 {
				t.Fatal("author not notified")
			}
			return
		}
		time.Sleep(100 * time.Millisecond)
	}
	t.Fatal("River did not close the poll")
}
