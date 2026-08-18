package eventlog

import (
	"bytes"
	"context"
	"log/slog"
	"testing"
	"time"

	"github.com/comamessenger/comamessenger/core/internal/message"
	"github.com/comamessenger/comamessenger/core/internal/testdb"
)

func TestRetentionWorkerKeepsTimeWindowAndCountFloor(t *testing.T) {
	pool := testdb.New(t)
	owner, member, _, chatID := seedEventFixture(t, pool)
	service := message.NewService(pool, 64*1024, 100, nil)
	ctx := context.Background()
	for i := 0; i < 8; i++ {
		if _, _, err := service.Create(ctx, member, chatID, message.CreateInput{
			ClientMsgID: testID(t), Body: "retention", BodyFormat: "plain",
		}); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := pool.Exec(ctx, `
		UPDATE events SET occurred_at = CASE
			WHEN seq <= 6 THEN now() - interval '100 hours'
			ELSE now() - interval '1 hour'
		END
		WHERE org_id = $1`, owner.OrgID); err != nil {
		t.Fatal(err)
	}

	var logs bytes.Buffer
	worker := NewRetentionWorker(
		slog.New(slog.NewTextHandler(&logs, nil)), NewStore(pool),
		72*time.Hour, time.Minute, 3, 2,
	)
	worker.sweep(ctx)
	stats := worker.Stats()
	if stats.Sweeps != 1 || stats.DeletedEvents != 5 || stats.Errors != 0 {
		t.Fatalf("retention stats = %+v; logs: %s", stats, logs.String())
	}

	rows, err := pool.Query(ctx, `SELECT seq FROM events WHERE org_id = $1 ORDER BY seq`, owner.OrgID)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var sequences []int64
	for rows.Next() {
		var sequence int64
		if err := rows.Scan(&sequence); err != nil {
			t.Fatal(err)
		}
		sequences = append(sequences, sequence)
	}
	if len(sequences) != 3 || sequences[0] != 6 || sequences[1] != 7 || sequences[2] != 8 {
		t.Fatalf("retained sequences = %v, want [6 7 8]", sequences)
	}
	var messages int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM messages WHERE org_id = $1`, owner.OrgID).Scan(&messages); err != nil {
		t.Fatal(err)
	}
	if messages != 8 {
		t.Fatalf("messages after retention = %d, want 8", messages)
	}
	bounds, err := worker.store.Bounds(ctx, owner.OrgID)
	if err != nil {
		t.Fatal(err)
	}
	if bounds.CurrentSeq != 8 || bounds.MinRetainedSeq != 5 {
		t.Fatalf("bounds after retention = %+v", bounds)
	}

	worker.sweep(ctx)
	stats = worker.Stats()
	if stats.Sweeps != 2 || stats.DeletedEvents != 5 || stats.Errors != 0 {
		t.Fatalf("idempotent retention stats = %+v", stats)
	}
}
