package interactive

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/comamessenger/comamessenger/core/internal/identity"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

type ScheduleFollowupInput struct {
	At           *time.Time      `json:"at"`
	DelaySeconds int             `json:"delay_seconds"`
	ChatID       string          `json:"chat_id"`
	ThreadRootID *string         `json:"thread_root_id"`
	Note         string          `json:"note"`
	Context      json.RawMessage `json:"context"`
}

type Followup struct {
	ID           string          `json:"id"`
	AgentID      string          `json:"agent_id"`
	SourceRunID  string          `json:"source_run_id"`
	ChatID       string          `json:"chat_id"`
	ThreadRootID *string         `json:"thread_root_id"`
	DueAt        time.Time       `json:"due_at"`
	Note         string          `json:"note"`
	Context      json.RawMessage `json:"context"`
	Status       string          `json:"status"`
	Reason       string          `json:"reason,omitempty"`
	RunID        *string         `json:"run_id"`
	CreatedAt    time.Time       `json:"created_at"`
}

const followupSelect = `SELECT id, agent_id, source_run_id, chat_id, thread_root_id, due_at, note, context, status, reason, run_id, created_at FROM agent_followups`

func scanFollowup(row pgx.Row) (Followup, error) {
	var result Followup
	err := row.Scan(&result.ID, &result.AgentID, &result.SourceRunID, &result.ChatID, &result.ThreadRootID, &result.DueAt, &result.Note, &result.Context, &result.Status, &result.Reason, &result.RunID, &result.CreatedAt)
	return result, err
}

// ScheduleFollowup stores an agent's own continuation. The same tool call
// replays the stored follow-up instead of creating a second one.
func (s *Service) ScheduleFollowup(ctx context.Context, agent identity.User, runID, toolCallID string, input ScheduleFollowupInput) (Followup, error) {
	if uuid.Validate(runID) != nil || uuid.Validate(toolCallID) != nil {
		return Followup{}, fmt.Errorf("%w: run_id and tool_call_id are required", ErrInvalid)
	}
	now := s.now().UTC()
	var due time.Time
	switch {
	case input.At != nil && input.DelaySeconds == 0:
		due = input.At.UTC()
	case input.At == nil && input.DelaySeconds > 0:
		due = now.Add(time.Duration(input.DelaySeconds) * time.Second)
	default:
		return Followup{}, fmt.Errorf("%w: exactly one of at or delay_seconds is required", ErrInvalid)
	}
	if due.Before(now.Add(s.limits.MinFollowupDelay)) || due.After(now.Add(s.limits.MaxFollowupDelay)) {
		return Followup{}, fmt.Errorf("%w: follow-up must be due between %s and %s from now", ErrInvalid, s.limits.MinFollowupDelay, s.limits.MaxFollowupDelay)
	}
	input.Note = strings.TrimSpace(input.Note)
	if len([]rune(input.Note)) > 2000 {
		return Followup{}, fmt.Errorf("%w: note is too long", ErrInvalid)
	}
	if len(input.Context) == 0 {
		input.Context = json.RawMessage(`{}`)
	}
	var contextObject map[string]any
	if json.Unmarshal(input.Context, &contextObject) != nil || contextObject == nil || len(input.Context) > 16384 {
		return Followup{}, fmt.Errorf("%w: context must be a JSON object up to 16 KiB", ErrInvalid)
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Followup{}, err
	}
	defer tx.Rollback(ctx)
	existing, err := scanFollowup(tx.QueryRow(ctx, followupSelect+` WHERE org_id=$1 AND source_run_id=$2 AND tool_call_id=$3`, agent.OrgID, runID, toolCallID))
	if err == nil {
		return existing, tx.Commit(ctx)
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return Followup{}, err
	}
	run, err := loadRun(ctx, tx, agent, runID)
	if err != nil {
		return Followup{}, err
	}
	chatID := input.ChatID
	threadRootID := input.ThreadRootID
	if chatID == "" {
		if run.ChatID == nil {
			return Followup{}, fmt.Errorf("%w: chat_id is required for a run without chat", ErrInvalid)
		}
		chatID = *run.ChatID
		if threadRootID == nil {
			threadRootID = run.ThreadRootID
		}
	}
	if uuid.Validate(chatID) != nil || (threadRootID != nil && uuid.Validate(*threadRootID) != nil) {
		return Followup{}, fmt.Errorf("%w: chat_id and thread_root_id must be UUIDs", ErrInvalid)
	}
	member, err := agentMember(ctx, tx, agent.OrgID, agent.ActorID, chatID)
	if err != nil {
		return Followup{}, err
	}
	if !member {
		return Followup{}, ErrForbidden
	}
	if threadRootID != nil {
		var valid bool
		if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM messages WHERE org_id=$1 AND chat_id=$2 AND id=$3 AND thread_root_id IS NULL AND deleted_at IS NULL)`, agent.OrgID, chatID, *threadRootID).Scan(&valid); err != nil {
			return Followup{}, err
		}
		if !valid {
			return Followup{}, fmt.Errorf("%w: thread_root_id must be a root message of the chat", ErrInvalid)
		}
	}
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, "agent-followups/"+agent.ActorID); err != nil {
		return Followup{}, err
	}
	var pending int
	if err := tx.QueryRow(ctx, `SELECT count(*) FROM agent_followups WHERE org_id=$1 AND agent_id=$2 AND status='pending'`, agent.OrgID, agent.ActorID).Scan(&pending); err != nil {
		return Followup{}, err
	}
	if pending >= s.limits.MaxPendingFollowupsPerAgent {
		return Followup{}, fmt.Errorf("%w: at most %d pending follow-ups per agent", ErrLimit, s.limits.MaxPendingFollowupsPerAgent)
	}
	followupID := uuid.Must(uuid.NewV7()).String()
	created, err := scanFollowup(tx.QueryRow(ctx, `INSERT INTO agent_followups(id,org_id,agent_id,agent_version,source_run_id,tool_call_id,chat_id,thread_root_id,due_at,context,note)
		VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
		RETURNING id, agent_id, source_run_id, chat_id, thread_root_id, due_at, note, context, status, reason, run_id, created_at`,
		followupID, agent.OrgID, agent.ActorID, run.AgentVersion, runID, toolCallID, chatID, threadRootID, due, input.Context, input.Note))
	if err != nil {
		return Followup{}, fmt.Errorf("schedule follow-up: %w", err)
	}
	if err := audit(ctx, tx, agent.OrgID, agent.ActorID, "agent.followup.schedule", "agent", agent.ActorID, map[string]any{"followup_id": followupID, "run_id": runID, "due_at": due}); err != nil {
		return Followup{}, err
	}
	return created, tx.Commit(ctx)
}

// DispatchFollowups turns due follow-ups into queued runs. A paused or deleted
// agent cancels the follow-up; an exhausted budget skips it.
func (s *Service) DispatchFollowups(ctx context.Context) error {
	now := s.now().UTC()
	rows, err := s.pool.Query(ctx, `SELECT id FROM agent_followups WHERE status='pending' AND due_at<=$1 ORDER BY due_at LIMIT 100`, now)
	if err != nil {
		return err
	}
	due, err := pgx.CollectRows(rows, pgx.RowTo[string])
	if err != nil {
		return err
	}
	for _, followupID := range due {
		if err := s.dispatchFollowup(ctx, followupID, now); err != nil {
			s.logger.Error("agent follow-up dispatch failed", "followup_id", followupID, "error", err)
		}
	}
	return nil
}

func (s *Service) dispatchFollowup(ctx context.Context, followupID string, now time.Time) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	var orgID string
	var sourceDepth *int
	err = tx.QueryRow(ctx, `SELECT f.org_id, run.chain_depth FROM agent_followups f
		LEFT JOIN agent_runs run ON run.org_id=f.org_id AND run.id=f.source_run_id
		WHERE f.id=$1 AND f.status='pending' AND f.due_at<=$2 FOR UPDATE OF f SKIP LOCKED`, followupID, now).Scan(&orgID, &sourceDepth)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	followup, err := scanFollowup(tx.QueryRow(ctx, followupSelect+` WHERE id=$1`, followupID))
	if err != nil {
		return err
	}
	var enabled, deleted, budgetLeft bool
	err = tx.QueryRow(ctx, `SELECT agent.enabled, agent.deleted_at IS NOT NULL,
		(agent.daily_cost_limit IS NULL OR COALESCE((SELECT sum(usage.cost) FROM agent_usage usage WHERE usage.agent_id=agent.actor_id AND usage.created_at>=date_trunc('day',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'),0) < agent.daily_cost_limit)
		AND (agent.monthly_cost_limit IS NULL OR COALESCE((SELECT sum(usage.cost) FROM agent_usage usage WHERE usage.agent_id=agent.actor_id AND usage.created_at>=date_trunc('month',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'),0) < agent.monthly_cost_limit)
		FROM agents agent WHERE agent.org_id=$1 AND agent.actor_id=$2`, orgID, followup.AgentID).Scan(&enabled, &deleted, &budgetLeft)
	if errors.Is(err, pgx.ErrNoRows) {
		deleted = true
	} else if err != nil {
		return err
	}
	status, reason := "dispatched", ""
	var runID *string
	switch {
	case deleted:
		status, reason = "canceled", "agent_deleted"
	case !enabled:
		status, reason = "canceled", "agent_paused"
	case !budgetLeft:
		status, reason = "skipped", "budget_exceeded"
	default:
		depth := 0
		if sourceDepth != nil {
			depth = *sourceDepth
		}
		id, _, err := enqueueRun(ctx, tx, runRequest{
			OrgID: orgID, AgentID: followup.AgentID, ChatID: followup.ChatID, ThreadRootID: followup.ThreadRootID,
			ClientRunID: followup.ID, ChainDepth: depth,
			Input: map[string]any{
				"trigger_type": "followup", "followup_id": followup.ID, "scheduled_for": followup.DueAt,
				"source_run_id": followup.SourceRunID, "note": followup.Note, "context": followup.Context,
				"chat_id": followup.ChatID, "thread_root_id": followup.ThreadRootID,
			},
		})
		if err != nil {
			return err
		}
		if id == "" {
			status, reason = "skipped", "agent_unavailable"
		} else {
			runID = &id
		}
	}
	if _, err := tx.Exec(ctx, `UPDATE agent_followups SET status=$2, reason=$3, run_id=$4, finished_at=now() WHERE id=$1`, followup.ID, status, reason, runID); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// ListFollowups returns an agent's own follow-ups, newest first.
func (s *Service) ListFollowups(ctx context.Context, agent identity.User, status string) ([]Followup, error) {
	if status != "" && status != "pending" && status != "dispatched" && status != "canceled" && status != "skipped" {
		return nil, fmt.Errorf("%w: unsupported status", ErrInvalid)
	}
	rows, err := s.pool.Query(ctx, followupSelect+` WHERE org_id=$1 AND agent_id=$2 AND ($3='' OR status=$3) ORDER BY created_at DESC LIMIT 100`, agent.OrgID, agent.ActorID, status)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := make([]Followup, 0)
	for rows.Next() {
		item, err := scanFollowup(rows)
		if err != nil {
			return nil, err
		}
		result = append(result, item)
	}
	return result, rows.Err()
}
