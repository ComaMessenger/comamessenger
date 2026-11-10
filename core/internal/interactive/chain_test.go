package interactive_test

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/comamessenger/comamessenger/core/internal/interactive"
	"github.com/google/uuid"
)

// TestFollowupChainIsBoundedByDepthAndRate covers review finding 10: every
// follow-up and collection report is one generation deeper than the run that
// started it, the agent's max_chain_depth stops the chain, and an agent
// cannot schedule more than the hourly limit of follow-ups.
func TestFollowupChainIsBoundedByDepthAndRate(t *testing.T) {
	w := setup(t)
	ctx := context.Background()
	if _, err := w.pool.Exec(ctx, `UPDATE agents SET max_chain_depth=2 WHERE actor_id=$1`, w.agent.ActorID); err != nil {
		t.Fatal(err)
	}
	schedule := func(runID string) error {
		_, err := w.interactive.ScheduleFollowup(ctx, w.agent, runID, uuid.NewString(), interactive.ScheduleFollowupInput{DelaySeconds: 60})
		return err
	}
	if err := schedule(w.runID); err != nil {
		t.Fatal(err)
	}
	w.interactive.SetClock(func() time.Time { return time.Now().Add(2 * time.Minute) })
	if err := w.interactive.DispatchFollowups(ctx); err != nil {
		t.Fatal(err)
	}
	var childID string
	var childDepth int
	if err := w.pool.QueryRow(ctx, `SELECT id::text,chain_depth FROM agent_runs WHERE agent_id=$1 AND input->>'trigger_type'='followup'`, w.agent.ActorID).Scan(&childID, &childDepth); err != nil {
		t.Fatal(err)
	}
	if childDepth != 1 {
		t.Fatalf("follow-up run depth = %d, want 1", childDepth)
	}
	// Generation 2 is still allowed, generation 3 is not.
	if _, err := w.pool.Exec(ctx, `UPDATE agent_runs SET chain_depth=2 WHERE id=$1`, childID); err != nil {
		t.Fatal(err)
	}
	if err := schedule(childID); !errors.Is(err, interactive.ErrLimit) {
		t.Fatalf("follow-up beyond max_chain_depth error = %v", err)
	}
	// A follow-up scheduled before the limit was lowered is skipped, not run.
	if _, err := w.pool.Exec(ctx, `UPDATE agents SET max_chain_depth=5 WHERE actor_id=$1`, w.agent.ActorID); err != nil {
		t.Fatal(err)
	}
	if err := schedule(childID); err != nil {
		t.Fatal(err)
	}
	if _, err := w.pool.Exec(ctx, `UPDATE agents SET max_chain_depth=2 WHERE actor_id=$1`, w.agent.ActorID); err != nil {
		t.Fatal(err)
	}
	w.interactive.SetClock(func() time.Time { return time.Now().Add(4 * time.Minute) })
	if err := w.interactive.DispatchFollowups(ctx); err != nil {
		t.Fatal(err)
	}
	if got := w.count(t, `SELECT count(*) FROM agent_followups WHERE agent_id=$1 AND status='skipped' AND reason='chain_depth_exceeded'`, w.agent.ActorID); got != 1 {
		t.Fatalf("follow-ups skipped for depth = %d", got)
	}
	// The hourly limit: 20 by default, counted over everything scheduled.
	if _, err := w.pool.Exec(ctx, `UPDATE agents SET max_chain_depth=16 WHERE actor_id=$1`, w.agent.ActorID); err != nil {
		t.Fatal(err)
	}
	limited := 0
	for range 25 {
		if err := schedule(w.runID); errors.Is(err, interactive.ErrLimit) {
			limited++
		} else if err != nil {
			t.Fatal(err)
		}
	}
	if scheduled := w.count(t, `SELECT count(*) FROM agent_followups WHERE agent_id=$1`, w.agent.ActorID); scheduled != interactive.DefaultLimits().MaxFollowupsPerAgentPerHour || limited == 0 {
		t.Fatalf("scheduled in an hour = %d, limited = %d", scheduled, limited)
	}
}
