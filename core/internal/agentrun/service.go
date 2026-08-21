package agentrun

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"slices"
	"strings"
	"time"

	"github.com/comamessenger/comamessenger/core/internal/access"
	"github.com/comamessenger/comamessenger/core/internal/id"
	"github.com/comamessenger/comamessenger/core/internal/identity"
	"github.com/comamessenger/comamessenger/core/internal/permission"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

var (
	ErrInvalid   = errors.New("invalid agent run input")
	ErrForbidden = errors.New("agent run forbidden")
	ErrNotFound  = errors.New("agent run not found")
	ErrConflict  = errors.New("agent run state conflict")
	ErrBudget    = errors.New("agent budget exceeded")
)
var costPattern = regexp.MustCompile(`^[0-9]+(?:\.[0-9]{1,8})?$`)
var consumerPattern = regexp.MustCompile(`^[a-z0-9][a-z0-9_.-]{0,63}$`)
var mcpToolPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$`)

type Run struct {
	ID                string          `json:"id"`
	OrgID             string          `json:"org_id"`
	AgentID           string          `json:"agent_id"`
	TriggerID         *string         `json:"trigger_id,omitempty"`
	TriggerEventSeq   *int64          `json:"trigger_event_seq,omitempty"`
	ScheduledFor      *time.Time      `json:"scheduled_for,omitempty"`
	ChatID            *string         `json:"chat_id,omitempty"`
	ThreadRootID      *string         `json:"thread_root_id,omitempty"`
	RequestedBy       *string         `json:"requested_by,omitempty"`
	ClientRunID       *string         `json:"client_run_id,omitempty"`
	CorrelationID     string          `json:"correlation_id"`
	ChainDepth        int             `json:"chain_depth"`
	Status            string          `json:"status"`
	Provider          string          `json:"provider"`
	Model             string          `json:"model"`
	Input             json.RawMessage `json:"input"`
	ResultSummary     json.RawMessage `json:"result_summary"`
	InputTokens       int64           `json:"input_tokens"`
	OutputTokens      int64           `json:"output_tokens"`
	Cost              string          `json:"cost"`
	Currency          string          `json:"currency"`
	ErrorCode         string          `json:"error_code"`
	Attempt           int             `json:"attempt"`
	MaxAttempts       int             `json:"max_attempts"`
	CreatedAt         time.Time       `json:"created_at"`
	StartedAt         *time.Time      `json:"started_at,omitempty"`
	FinishedAt        *time.Time      `json:"finished_at,omitempty"`
	CancelRequestedAt *time.Time      `json:"cancel_requested_at,omitempty"`
	TimeoutAt         *time.Time      `json:"timeout_at,omitempty"`
	LeaseToken        *string         `json:"-"`
}

type InvokeInput struct {
	ChatID         string          `json:"chat_id"`
	ThreadRootID   *string         `json:"thread_root_id"`
	ClientRunID    string          `json:"client_run_id"`
	CorrelationID  string          `json:"correlation_id"`
	ChainDepth     int             `json:"chain_depth"`
	TimeoutSeconds int             `json:"timeout_seconds"`
	MaxAttempts    int             `json:"max_attempts"`
	Input          json.RawMessage `json:"input"`
}
type ClaimInput struct {
	WorkerID     string `json:"worker_id"`
	LeaseSeconds int    `json:"lease_seconds"`
}
type LeaseInput struct {
	LeaseToken   string `json:"lease_token"`
	LeaseSeconds int    `json:"lease_seconds"`
}
type Completion struct {
	InputTokens   int64           `json:"input_tokens"`
	OutputTokens  int64           `json:"output_tokens"`
	Cost          string          `json:"cost"`
	Currency      string          `json:"currency"`
	ResultSummary json.RawMessage `json:"result_summary"`
	PriceSource   string          `json:"price_source"`
}
type RuntimeCompletion struct {
	LeaseToken    string          `json:"lease_token"`
	InputTokens   int64           `json:"input_tokens"`
	OutputTokens  int64           `json:"output_tokens"`
	Cost          string          `json:"cost"`
	Currency      string          `json:"currency"`
	ResultSummary json.RawMessage `json:"result_summary"`
	PriceSource   string          `json:"price_source"`
}
type RuntimeFailure struct {
	LeaseToken string `json:"lease_token"`
	ErrorCode  string `json:"error_code"`
}
type RuntimeCheckpoint struct {
	Consumer     string    `json:"consumer"`
	LastEventSeq int64     `json:"last_event_seq"`
	UpdatedAt    time.Time `json:"updated_at"`
}
type UpdateRuntimeCheckpoint struct {
	LastEventSeq int64 `json:"last_event_seq"`
}
type StartProviderCallInput struct {
	CallID       string `json:"call_id"`
	RunID        string `json:"run_id"`
	LeaseToken   string `json:"lease_token"`
	ReservedCost string `json:"reserved_cost"`
	Currency     string `json:"currency"`
}
type ProviderCall struct {
	ID            string     `json:"id"`
	RunID         string     `json:"run_id"`
	CorrelationID string     `json:"correlation_id"`
	Provider      string     `json:"provider"`
	Model         string     `json:"model"`
	Status        string     `json:"status"`
	ReservedCost  string     `json:"reserved_cost"`
	ActualCost    *string    `json:"actual_cost"`
	Currency      string     `json:"currency"`
	InputTokens   int64      `json:"input_tokens"`
	OutputTokens  int64      `json:"output_tokens"`
	PriceSource   string     `json:"price_source"`
	CreatedAt     time.Time  `json:"created_at"`
	FinishedAt    *time.Time `json:"finished_at"`
}
type FinishProviderCallInput struct {
	RunID        string `json:"run_id"`
	LeaseToken   string `json:"lease_token"`
	Status       string `json:"status"`
	ActualCost   string `json:"actual_cost"`
	Currency     string `json:"currency"`
	InputTokens  int64  `json:"input_tokens"`
	OutputTokens int64  `json:"output_tokens"`
	PriceSource  string `json:"price_source"`
}
type StartMCPToolCallInput struct {
	CallID     string `json:"call_id"`
	RunID      string `json:"run_id"`
	LeaseToken string `json:"lease_token"`
	ServerID   string `json:"server_id"`
	ToolName   string `json:"tool_name"`
	Mode       string `json:"mode"`
	InputBytes int    `json:"input_bytes"`
}
type MCPToolCall struct {
	ID            string `json:"id"`
	CorrelationID string `json:"correlation_id"`
	ToolName      string `json:"tool_name"`
	Mode          string `json:"mode"`
}
type FinishMCPToolCallInput struct {
	RunID       string `json:"run_id"`
	LeaseToken  string `json:"lease_token"`
	Status      string `json:"status"`
	OutputBytes int    `json:"output_bytes"`
	ErrorCode   string `json:"error_code"`
}
type Page struct {
	Runs []Run `json:"runs"`
}
type ClaimedRun struct {
	Run
	LeaseToken string `json:"lease_token"`
}
type Service struct {
	pool *pgxpool.Pool
	now  func() time.Time
}

func NewService(pool *pgxpool.Pool) *Service { return &Service{pool: pool, now: time.Now} }

func (service *Service) Invoke(ctx context.Context, current identity.User, agentID string, input InvokeInput) (Run, error) {
	if !canManage(current) {
		return Run{}, ErrForbidden
	}
	if uuid.Validate(agentID) != nil || uuid.Validate(input.ChatID) != nil || uuid.Validate(input.ClientRunID) != nil {
		return Run{}, ErrInvalid
	}
	if input.CorrelationID == "" {
		generated, err := id.New()
		if err != nil {
			return Run{}, err
		}
		input.CorrelationID = generated
	} else if uuid.Validate(input.CorrelationID) != nil {
		return Run{}, ErrInvalid
	}
	if input.ThreadRootID != nil && uuid.Validate(*input.ThreadRootID) != nil {
		return Run{}, ErrInvalid
	}
	if input.TimeoutSeconds == 0 {
		input.TimeoutSeconds = 120
	}
	if len(input.Input) == 0 {
		input.Input = json.RawMessage(`{}`)
	}
	if input.MaxAttempts == 0 {
		input.MaxAttempts = 3
	}
	if input.TimeoutSeconds < 5 || input.TimeoutSeconds > 3600 || input.MaxAttempts < 1 || input.MaxAttempts > 20 || len(input.Input) > 262144 || !validObject(input.Input) {
		return Run{}, ErrInvalid
	}
	runID, err := id.New()
	if err != nil {
		return Run{}, err
	}
	auditID, err := id.New()
	if err != nil {
		return Run{}, err
	}
	tx, err := service.pool.Begin(ctx)
	if err != nil {
		return Run{}, err
	}
	defer tx.Rollback(ctx)
	var maxDepth int
	var provider, model string
	err = tx.QueryRow(ctx, `SELECT agent.max_chain_depth,agent.provider,agent.model FROM agents agent JOIN chat_members member ON member.org_id=agent.org_id AND member.actor_id=agent.actor_id AND member.chat_id=$3 JOIN chats chat ON chat.org_id=agent.org_id AND chat.id=member.chat_id AND chat.archived_at IS NULL WHERE agent.org_id=$1 AND agent.actor_id=$2 AND agent.enabled FOR UPDATE OF agent`, current.OrgID, agentID, input.ChatID).Scan(&maxDepth, &provider, &model)
	if errors.Is(err, pgx.ErrNoRows) {
		return Run{}, ErrNotFound
	}
	if err != nil {
		return Run{}, fmt.Errorf("authorize agent invocation: %w", err)
	}
	if input.ChainDepth < 0 || input.ChainDepth > maxDepth {
		return Run{}, ErrForbidden
	}
	requestedBy := current.ActorID
	timeoutAt := service.now().UTC().Add(time.Duration(input.TimeoutSeconds) * time.Second)
	_, err = tx.Exec(ctx, `INSERT INTO agent_runs(id,org_id,agent_id,chat_id,thread_root_id,requested_by,client_run_id,correlation_id,chain_depth,provider,model,input,timeout_at,max_attempts) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) ON CONFLICT(agent_id,client_run_id) DO NOTHING`, runID, current.OrgID, agentID, input.ChatID, input.ThreadRootID, requestedBy, input.ClientRunID, input.CorrelationID, input.ChainDepth, provider, model, input.Input, timeoutAt, input.MaxAttempts)
	if err != nil {
		return Run{}, fmt.Errorf("enqueue agent run: %w", err)
	}
	metadata, _ := json.Marshal(map[string]any{"run_id": runID, "chat_id": input.ChatID, "correlation_id": input.CorrelationID, "chain_depth": input.ChainDepth})
	_, err = tx.Exec(ctx, `INSERT INTO audit_log(id,org_id,actor_id,action,target_type,target_id,metadata) VALUES($1,$2,$3,'agent.run.invoke','agent',$4,$5)`, auditID, current.OrgID, current.ActorID, agentID, metadata)
	if err != nil {
		return Run{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Run{}, err
	}
	return service.getForOrg(ctx, current.OrgID, agentID, input.ClientRunID)
}

func (service *Service) List(ctx context.Context, current identity.User, agentID string) (Page, error) {
	if !canManage(current) {
		return Page{}, ErrForbidden
	}
	rows, err := service.pool.Query(ctx, runSelect+` WHERE run.org_id=$1 AND run.agent_id=$2 ORDER BY run.created_at DESC LIMIT 100`, current.OrgID, agentID)
	if err != nil {
		return Page{}, err
	}
	defer rows.Close()
	result := Page{Runs: make([]Run, 0)}
	for rows.Next() {
		run, err := scanRun(rows)
		if err != nil {
			return Page{}, err
		}
		result.Runs = append(result.Runs, run)
	}
	return result, rows.Err()
}

func (service *Service) RequestCancel(ctx context.Context, current identity.User, runID string) (Run, error) {
	if !canManage(current) {
		return Run{}, ErrForbidden
	}
	if uuid.Validate(runID) != nil {
		return Run{}, ErrNotFound
	}
	auditID, err := id.New()
	if err != nil {
		return Run{}, err
	}
	tx, err := service.pool.Begin(ctx)
	if err != nil {
		return Run{}, err
	}
	defer tx.Rollback(ctx)
	var agentID string
	err = tx.QueryRow(ctx, `UPDATE agent_runs SET status=CASE WHEN status='queued' THEN 'canceled' ELSE status END,cancel_requested_at=now(),finished_at=CASE WHEN status='queued' THEN now() ELSE finished_at END WHERE org_id=$1 AND id=$2 AND status IN('queued','running') RETURNING agent_id`, current.OrgID, runID).Scan(&agentID)
	if errors.Is(err, pgx.ErrNoRows) {
		return Run{}, ErrConflict
	}
	if err != nil {
		return Run{}, err
	}
	metadata, _ := json.Marshal(map[string]string{"run_id": runID})
	if _, err := tx.Exec(ctx, `INSERT INTO audit_log(id,org_id,actor_id,action,target_type,target_id,metadata) VALUES($1,$2,$3,'agent.run.cancel','agent',$4,$5)`, auditID, current.OrgID, current.ActorID, agentID, metadata); err != nil {
		return Run{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Run{}, err
	}
	return service.Get(ctx, current, runID)
}

func (service *Service) Get(ctx context.Context, current identity.User, runID string) (Run, error) {
	if !canManage(current) {
		return Run{}, ErrForbidden
	}
	run, err := scanRun(service.pool.QueryRow(ctx, runSelect+` WHERE run.org_id=$1 AND run.id=$2`, current.OrgID, runID))
	if errors.Is(err, pgx.ErrNoRows) {
		return Run{}, ErrNotFound
	}
	return run, err
}

func (service *Service) Claim(ctx context.Context, workerID string, lease time.Duration) (Run, error) {
	return service.claim(ctx, "", workerID, lease)
}

func (service *Service) ClaimForAgent(ctx context.Context, current identity.User, authentication access.Identity, input ClaimInput) (ClaimedRun, error) {
	if !isAgentWorker(current, authentication) {
		return ClaimedRun{}, ErrForbidden
	}
	if input.LeaseSeconds == 0 {
		input.LeaseSeconds = 60
	}
	run, err := service.claim(ctx, current.ActorID, input.WorkerID, time.Duration(input.LeaseSeconds)*time.Second)
	if err != nil {
		return ClaimedRun{}, err
	}
	if run.LeaseToken == nil {
		return ClaimedRun{}, ErrConflict
	}
	return ClaimedRun{Run: run, LeaseToken: *run.LeaseToken}, nil
}

func (service *Service) claim(ctx context.Context, agentID, workerID string, lease time.Duration) (Run, error) {
	if uuid.Validate(workerID) != nil || lease < 5*time.Second || lease > 5*time.Minute {
		return Run{}, ErrInvalid
	}
	if err := service.reap(ctx); err != nil {
		return Run{}, err
	}
	tx, err := service.pool.Begin(ctx)
	if err != nil {
		return Run{}, err
	}
	defer tx.Rollback(ctx)
	var agentFilter any
	if agentID != "" {
		agentFilter = agentID
	}
	rows, err := tx.Query(ctx, `SELECT run.id,run.agent_id,run.chat_id,agent.per_chat_concurrency
		FROM agent_runs run JOIN agents agent ON agent.org_id=run.org_id AND agent.actor_id=run.agent_id
		WHERE run.status='queued' AND run.next_attempt_at<=now() AND run.timeout_at>now()
			AND run.cancel_requested_at IS NULL AND agent.enabled AND ($1::uuid IS NULL OR run.agent_id=$1)
		ORDER BY run.next_attempt_at,run.created_at FOR UPDATE OF run SKIP LOCKED LIMIT 20`, agentFilter)
	if err != nil {
		return Run{}, err
	}
	type candidate struct {
		id, agent string
		chat      *string
		limit     int
	}
	items := make([]candidate, 0)
	for rows.Next() {
		var item candidate
		if err := rows.Scan(&item.id, &item.agent, &item.chat, &item.limit); err != nil {
			rows.Close()
			return Run{}, err
		}
		items = append(items, item)
	}
	rows.Close()
	for _, item := range items {
		lockKey := item.agent
		if item.chat != nil {
			lockKey += "/" + *item.chat
		}
		if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, lockKey); err != nil {
			return Run{}, err
		}
		if item.chat != nil {
			var active int
			if err := tx.QueryRow(ctx, `SELECT count(*) FROM agent_runs WHERE agent_id=$1 AND chat_id=$2 AND status='running'`, item.agent, *item.chat).Scan(&active); err != nil {
				return Run{}, err
			}
			if active >= item.limit {
				continue
			}
		}
		leaseToken, err := id.New()
		if err != nil {
			return Run{}, err
		}
		run, err := scanRun(tx.QueryRow(ctx, runSelect+` WHERE run.id=$1 FOR UPDATE OF run`, item.id))
		if err != nil {
			return Run{}, err
		}
		_, err = tx.Exec(ctx, `UPDATE agent_runs SET status='running',lease_token=$2,lease_expires_at=$3,started_at=COALESCE(started_at,now()) WHERE id=$1`, item.id, leaseToken, service.now().UTC().Add(lease))
		if err != nil {
			return Run{}, err
		}
		if err := tx.Commit(ctx); err != nil {
			return Run{}, err
		}
		run.Status = "running"
		run.LeaseToken = &leaseToken
		return run, nil
	}
	return Run{}, ErrNotFound
}

func (service *Service) HeartbeatForAgent(ctx context.Context, current identity.User, authentication access.Identity, runID string, input LeaseInput) (Run, error) {
	if !isAgentWorker(current, authentication) {
		return Run{}, ErrForbidden
	}
	if input.LeaseSeconds == 0 {
		input.LeaseSeconds = 60
	}
	lease := time.Duration(input.LeaseSeconds) * time.Second
	if uuid.Validate(runID) != nil || uuid.Validate(input.LeaseToken) != nil || lease < 5*time.Second || lease > 5*time.Minute {
		return Run{}, ErrInvalid
	}
	result, err := service.pool.Exec(ctx, `UPDATE agent_runs SET lease_expires_at=$5
		WHERE org_id=$1 AND agent_id=$2 AND id=$3 AND lease_token=$4 AND status='running'`, current.OrgID, current.ActorID,
		runID, input.LeaseToken, service.now().UTC().Add(lease))
	if err != nil {
		return Run{}, err
	}
	if result.RowsAffected() != 1 {
		return Run{}, ErrConflict
	}
	return service.getByID(ctx, runID)
}

func (service *Service) CompleteForAgent(ctx context.Context, current identity.User, authentication access.Identity, runID string, input RuntimeCompletion) (Run, error) {
	if !isAgentWorker(current, authentication) {
		return Run{}, ErrForbidden
	}
	if err := service.authorizeAgentRun(ctx, current, runID); err != nil {
		return Run{}, err
	}
	return service.Complete(ctx, runID, input.LeaseToken, Completion{
		InputTokens: input.InputTokens, OutputTokens: input.OutputTokens, Cost: input.Cost,
		Currency: input.Currency, ResultSummary: input.ResultSummary, PriceSource: input.PriceSource,
	})
}

func (service *Service) FailForAgent(ctx context.Context, current identity.User, authentication access.Identity, runID string, input RuntimeFailure) (Run, error) {
	if !isAgentWorker(current, authentication) {
		return Run{}, ErrForbidden
	}
	if err := service.authorizeAgentRun(ctx, current, runID); err != nil {
		return Run{}, err
	}
	return service.Fail(ctx, runID, input.LeaseToken, input.ErrorCode)
}

func (service *Service) GetRuntimeCheckpoint(ctx context.Context, current identity.User, authentication access.Identity, consumer string) (RuntimeCheckpoint, error) {
	if !isAgentWorker(current, authentication) {
		return RuntimeCheckpoint{}, ErrForbidden
	}
	consumer = strings.ToLower(strings.TrimSpace(consumer))
	if !consumerPattern.MatchString(consumer) {
		return RuntimeCheckpoint{}, ErrInvalid
	}
	if _, err := service.pool.Exec(ctx, `INSERT INTO agent_runtime_checkpoints(org_id,agent_id,consumer,last_event_seq)
		SELECT $1,$2,$3,event_seq FROM organizations WHERE id=$1 ON CONFLICT(agent_id,consumer) DO NOTHING`, current.OrgID, current.ActorID, consumer); err != nil {
		return RuntimeCheckpoint{}, err
	}
	var result RuntimeCheckpoint
	result.Consumer = consumer
	err := service.pool.QueryRow(ctx, `SELECT last_event_seq,updated_at FROM agent_runtime_checkpoints
		WHERE org_id=$1 AND agent_id=$2 AND consumer=$3`, current.OrgID, current.ActorID, consumer).Scan(&result.LastEventSeq, &result.UpdatedAt)
	return result, err
}

func (service *Service) UpdateRuntimeCheckpoint(ctx context.Context, current identity.User, authentication access.Identity, consumer string, input UpdateRuntimeCheckpoint) (RuntimeCheckpoint, error) {
	if !isAgentWorker(current, authentication) {
		return RuntimeCheckpoint{}, ErrForbidden
	}
	consumer = strings.ToLower(strings.TrimSpace(consumer))
	if !consumerPattern.MatchString(consumer) || input.LastEventSeq < 0 {
		return RuntimeCheckpoint{}, ErrInvalid
	}
	var highWatermark int64
	if err := service.pool.QueryRow(ctx, `SELECT event_seq FROM organizations WHERE id=$1`, current.OrgID).Scan(&highWatermark); err != nil {
		return RuntimeCheckpoint{}, err
	}
	if input.LastEventSeq > highWatermark {
		return RuntimeCheckpoint{}, ErrInvalid
	}
	var result RuntimeCheckpoint
	result.Consumer = consumer
	err := service.pool.QueryRow(ctx, `INSERT INTO agent_runtime_checkpoints(org_id,agent_id,consumer,last_event_seq)
		VALUES($1,$2,$3,$4) ON CONFLICT(agent_id,consumer) DO UPDATE
		SET last_event_seq=GREATEST(agent_runtime_checkpoints.last_event_seq,EXCLUDED.last_event_seq),updated_at=now()
		RETURNING last_event_seq,updated_at`, current.OrgID, current.ActorID, consumer, input.LastEventSeq).Scan(&result.LastEventSeq, &result.UpdatedAt)
	return result, err
}

func (service *Service) StartProviderCall(ctx context.Context, current identity.User, authentication access.Identity, input StartProviderCallInput) (ProviderCall, error) {
	if !isAgentWorker(current, authentication) {
		return ProviderCall{}, ErrForbidden
	}
	input.Currency = strings.ToUpper(strings.TrimSpace(input.Currency))
	if input.Currency == "" {
		input.Currency = "USD"
	}
	if uuid.Validate(input.CallID) != nil || uuid.Validate(input.RunID) != nil || uuid.Validate(input.LeaseToken) != nil ||
		!costPattern.MatchString(input.ReservedCost) || len(input.Currency) != 3 {
		return ProviderCall{}, ErrInvalid
	}
	tx, err := service.pool.Begin(ctx)
	if err != nil {
		return ProviderCall{}, err
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, "agent-budget/"+current.ActorID); err != nil {
		return ProviderCall{}, err
	}
	var correlationID, provider, model string
	err = tx.QueryRow(ctx, `SELECT run.correlation_id,run.provider,run.model FROM agent_runs run
		WHERE run.org_id=$1 AND run.agent_id=$2 AND run.id=$3 AND run.lease_token=$4 AND run.status='running' FOR UPDATE`,
		current.OrgID, current.ActorID, input.RunID, input.LeaseToken).Scan(&correlationID, &provider, &model)
	if errors.Is(err, pgx.ErrNoRows) {
		return ProviderCall{}, ErrConflict
	}
	if err != nil {
		return ProviderCall{}, err
	}
	var dailyAllowed, monthlyAllowed bool
	err = tx.QueryRow(ctx, `SELECT
		(agent.daily_cost_limit IS NULL OR COALESCE((SELECT sum(usage.cost) FROM agent_usage usage WHERE usage.agent_id=agent.actor_id AND usage.created_at>=date_trunc('day',now())),0)
		 + COALESCE((SELECT sum(COALESCE(call.actual_cost,call.reserved_cost)) FROM agent_provider_calls call JOIN agent_runs pending ON pending.id=call.run_id WHERE call.agent_id=agent.actor_id AND call.created_at>=date_trunc('day',now()) AND pending.status IN('queued','running')),0) + $2::numeric <= agent.daily_cost_limit),
		(agent.monthly_cost_limit IS NULL OR COALESCE((SELECT sum(usage.cost) FROM agent_usage usage WHERE usage.agent_id=agent.actor_id AND usage.created_at>=date_trunc('month',now())),0)
		 + COALESCE((SELECT sum(COALESCE(call.actual_cost,call.reserved_cost)) FROM agent_provider_calls call JOIN agent_runs pending ON pending.id=call.run_id WHERE call.agent_id=agent.actor_id AND call.created_at>=date_trunc('month',now()) AND pending.status IN('queued','running')),0) + $2::numeric <= agent.monthly_cost_limit)
		FROM agents agent WHERE agent.actor_id=$1`, current.ActorID, input.ReservedCost).Scan(&dailyAllowed, &monthlyAllowed)
	if err != nil {
		return ProviderCall{}, err
	}
	if !dailyAllowed || !monthlyAllowed {
		return ProviderCall{}, ErrBudget
	}
	_, err = tx.Exec(ctx, `INSERT INTO agent_provider_calls(id,org_id,agent_id,run_id,correlation_id,provider,model,reserved_cost,currency)
		VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(id) DO NOTHING`, input.CallID, current.OrgID, current.ActorID,
		input.RunID, correlationID, provider, model, input.ReservedCost, input.Currency)
	if err != nil {
		return ProviderCall{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return ProviderCall{}, err
	}
	return service.providerCall(ctx, current.OrgID, current.ActorID, input.CallID)
}

func (service *Service) FinishProviderCall(ctx context.Context, current identity.User, authentication access.Identity, callID string, input FinishProviderCallInput) (ProviderCall, error) {
	if !isAgentWorker(current, authentication) {
		return ProviderCall{}, ErrForbidden
	}
	input.Currency = strings.ToUpper(strings.TrimSpace(input.Currency))
	if input.Currency == "" {
		input.Currency = "USD"
	}
	if input.PriceSource == "" {
		input.PriceSource = "unknown"
	}
	if uuid.Validate(callID) != nil || uuid.Validate(input.RunID) != nil || uuid.Validate(input.LeaseToken) != nil ||
		(input.Status != "completed" && input.Status != "failed") || !costPattern.MatchString(input.ActualCost) || len(input.Currency) != 3 ||
		input.InputTokens < 0 || input.OutputTokens < 0 || !validPriceSource(input.PriceSource) {
		return ProviderCall{}, ErrInvalid
	}
	result, err := service.pool.Exec(ctx, `UPDATE agent_provider_calls call SET status=$6,actual_cost=$7::numeric,currency=$8,
		input_tokens=$9,output_tokens=$10,price_source=$11,finished_at=now()
		FROM agent_runs run WHERE call.org_id=$1 AND call.agent_id=$2 AND call.id=$3 AND call.run_id=$4 AND call.status='started'
		AND run.id=call.run_id AND run.lease_token=$5 AND run.status='running' AND run.agent_id=$2 AND run.org_id=$1`,
		current.OrgID, current.ActorID, callID, input.RunID, input.LeaseToken, input.Status, input.ActualCost,
		input.Currency, input.InputTokens, input.OutputTokens, input.PriceSource)
	if err != nil {
		return ProviderCall{}, err
	}
	if result.RowsAffected() != 1 {
		return ProviderCall{}, ErrConflict
	}
	return service.providerCall(ctx, current.OrgID, current.ActorID, callID)
}

func (service *Service) providerCall(ctx context.Context, orgID, agentID, callID string) (ProviderCall, error) {
	var result ProviderCall
	err := service.pool.QueryRow(ctx, `SELECT id,run_id,correlation_id,provider,model,status,reserved_cost::text,actual_cost::text,
		currency,input_tokens,output_tokens,price_source,created_at,finished_at FROM agent_provider_calls
		WHERE org_id=$1 AND agent_id=$2 AND id=$3`, orgID, agentID, callID).Scan(&result.ID, &result.RunID,
		&result.CorrelationID, &result.Provider, &result.Model, &result.Status, &result.ReservedCost, &result.ActualCost,
		&result.Currency, &result.InputTokens, &result.OutputTokens, &result.PriceSource, &result.CreatedAt, &result.FinishedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return ProviderCall{}, ErrNotFound
	}
	return result, err
}

func (service *Service) StartMCPToolCall(ctx context.Context, current identity.User, authentication access.Identity, input StartMCPToolCallInput) (MCPToolCall, error) {
	if !isAgentWorker(current, authentication) {
		return MCPToolCall{}, ErrForbidden
	}
	if uuid.Validate(input.CallID) != nil || uuid.Validate(input.RunID) != nil || uuid.Validate(input.LeaseToken) != nil || uuid.Validate(input.ServerID) != nil ||
		!mcpToolPattern.MatchString(input.ToolName) || (input.Mode != "read" && input.Mode != "write") || input.InputBytes < 0 || input.InputBytes > 262144 {
		return MCPToolCall{}, ErrInvalid
	}
	summary, _ := json.Marshal(map[string]any{"input_bytes": input.InputBytes, "mcp_server_id": input.ServerID})
	var result MCPToolCall
	err := service.pool.QueryRow(ctx, `INSERT INTO agent_tool_calls(id,org_id,agent_id,run_id,correlation_id,tool_name,mode,required_scope,input_summary)
		SELECT $3,run.org_id,run.agent_id,run.id,run.correlation_id,'mcp__' || server.name || '__' || $7,$8,'mcp:' || server.name,$9
		FROM agent_runs run JOIN agent_mcp_servers server ON server.org_id=run.org_id AND server.agent_id=run.agent_id AND server.id=$6
		WHERE run.org_id=$1 AND run.agent_id=$2 AND run.id=$4 AND run.lease_token=$5 AND run.status='running' AND run.lease_expires_at>now()
		AND server.enabled AND $7=ANY(server.allowed_tools) AND ($8='read' OR NOT server.require_write_confirmation)
		RETURNING id,correlation_id,tool_name,mode`, current.OrgID, current.ActorID, input.CallID, input.RunID, input.LeaseToken, input.ServerID, input.ToolName, input.Mode, summary).Scan(&result.ID, &result.CorrelationID, &result.ToolName, &result.Mode)
	if errors.Is(err, pgx.ErrNoRows) {
		return MCPToolCall{}, ErrForbidden
	}
	if err != nil {
		return MCPToolCall{}, err
	}
	return result, nil
}

func (service *Service) FinishMCPToolCall(ctx context.Context, current identity.User, authentication access.Identity, callID string, input FinishMCPToolCallInput) error {
	if !isAgentWorker(current, authentication) {
		return ErrForbidden
	}
	if uuid.Validate(callID) != nil || uuid.Validate(input.RunID) != nil || uuid.Validate(input.LeaseToken) != nil ||
		(input.Status != "completed" && input.Status != "failed") || input.OutputBytes < 0 || input.OutputBytes > 4194304 || len(input.ErrorCode) > 120 || (input.Status == "completed" && input.ErrorCode != "") {
		return ErrInvalid
	}
	auditID, err := id.New()
	if err != nil {
		return err
	}
	tx, err := service.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	var correlationID, toolName, mode string
	err = tx.QueryRow(ctx, `UPDATE agent_tool_calls call SET status=$6,output_bytes=$7,error_code=$8,finished_at=now()
		FROM agent_runs run WHERE call.org_id=$1 AND call.agent_id=$2 AND call.id=$3 AND call.run_id=$4 AND call.status='running'
		AND run.org_id=call.org_id AND run.agent_id=call.agent_id AND run.id=call.run_id AND run.lease_token=$5 AND run.status='running'
		RETURNING call.correlation_id,call.tool_name,call.mode`, current.OrgID, current.ActorID, callID, input.RunID, input.LeaseToken, input.Status, input.OutputBytes, input.ErrorCode).Scan(&correlationID, &toolName, &mode)
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrConflict
	}
	if err != nil {
		return err
	}
	metadata, _ := json.Marshal(map[string]any{"tool_call_id": callID, "run_id": input.RunID, "correlation_id": correlationID, "tool": toolName, "mode": mode, "status": input.Status, "error_code": input.ErrorCode, "output_bytes": input.OutputBytes})
	if _, err := tx.Exec(ctx, `INSERT INTO audit_log(id,org_id,actor_id,action,target_type,target_id,metadata)
		VALUES($1,$2,$3,'agent.tool.call','agent',$3,$4)`, auditID, current.OrgID, current.ActorID, metadata); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (service *Service) authorizeAgentRun(ctx context.Context, current identity.User, runID string) error {
	if uuid.Validate(runID) != nil {
		return ErrNotFound
	}
	var exists bool
	if err := service.pool.QueryRow(ctx, `SELECT true FROM agent_runs WHERE org_id=$1 AND agent_id=$2 AND id=$3`, current.OrgID, current.ActorID, runID).Scan(&exists); errors.Is(err, pgx.ErrNoRows) {
		return ErrNotFound
	} else {
		return err
	}
}

func (service *Service) Complete(ctx context.Context, runID, leaseToken string, result Completion) (Run, error) {
	if len(result.ResultSummary) == 0 {
		result.ResultSummary = json.RawMessage(`{}`)
	}
	result.Currency = strings.ToUpper(strings.TrimSpace(result.Currency))
	if result.Currency == "" {
		result.Currency = "USD"
	}
	if result.Cost == "" {
		result.Cost = "0"
	}
	if result.PriceSource == "" {
		result.PriceSource = "unknown"
	}
	if uuid.Validate(runID) != nil || uuid.Validate(leaseToken) != nil || result.InputTokens < 0 || result.OutputTokens < 0 || !costPattern.MatchString(result.Cost) || len(result.Currency) != 3 || len(result.ResultSummary) > 262144 || !validObject(result.ResultSummary) || !validPriceSource(result.PriceSource) {
		return Run{}, ErrInvalid
	}
	usageID, err := id.New()
	if err != nil {
		return Run{}, err
	}
	tx, err := service.pool.Begin(ctx)
	if err != nil {
		return Run{}, err
	}
	defer tx.Rollback(ctx)
	var canceled bool
	var orgID, agentID, correlationID, provider, model string
	err = tx.QueryRow(ctx, `UPDATE agent_runs SET status=CASE WHEN cancel_requested_at IS NULL THEN 'completed' ELSE 'canceled' END,
		input_tokens=$3,output_tokens=$4,cost=COALESCE(NULLIF($5,''),'0')::numeric,currency=COALESCE(NULLIF($6,''),'USD'),
		result_summary=$7,finished_at=now(),lease_token=NULL,lease_expires_at=NULL
		WHERE id=$1 AND lease_token=$2 AND status='running'
		RETURNING status='canceled',org_id,agent_id,correlation_id,provider,model`, runID, leaseToken, result.InputTokens,
		result.OutputTokens, result.Cost, result.Currency, result.ResultSummary).Scan(&canceled, &orgID, &agentID, &correlationID, &provider, &model)
	if errors.Is(err, pgx.ErrNoRows) {
		return Run{}, ErrConflict
	}
	if err != nil {
		return Run{}, err
	}
	if !canceled && provider != "" && model != "" {
		if _, err := tx.Exec(ctx, `INSERT INTO agent_usage(id,org_id,agent_id,run_id,correlation_id,provider,model,
			input_tokens,output_tokens,cost,currency,price_source) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
			usageID, orgID, agentID, runID, correlationID, provider, model, result.InputTokens, result.OutputTokens,
			result.Cost, result.Currency, result.PriceSource); err != nil {
			return Run{}, err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return Run{}, err
	}
	return service.getByID(ctx, runID)
}

func (service *Service) Fail(ctx context.Context, runID, leaseToken, errorCode string) (Run, error) {
	if uuid.Validate(runID) != nil || uuid.Validate(leaseToken) != nil || len(errorCode) < 1 || len(errorCode) > 120 {
		return Run{}, ErrInvalid
	}
	result, err := service.pool.Exec(ctx, `UPDATE agent_runs SET status=CASE WHEN cancel_requested_at IS NOT NULL THEN 'canceled' WHEN timeout_at<=now() THEN 'timed_out' WHEN $3='budget_exceeded' THEN 'failed' WHEN attempt<max_attempts THEN 'queued' ELSE 'failed' END,error_code=$3,attempt=CASE WHEN cancel_requested_at IS NULL AND timeout_at>now() AND $3<>'budget_exceeded' AND attempt<max_attempts THEN attempt+1 ELSE attempt END,next_attempt_at=CASE WHEN cancel_requested_at IS NULL AND timeout_at>now() AND $3<>'budget_exceeded' AND attempt<max_attempts THEN now()+make_interval(secs=>LEAST(60,attempt*attempt)) ELSE next_attempt_at END,finished_at=CASE WHEN cancel_requested_at IS NOT NULL OR timeout_at<=now() OR $3='budget_exceeded' OR attempt>=max_attempts THEN now() ELSE NULL END,lease_token=NULL,lease_expires_at=NULL WHERE id=$1 AND lease_token=$2 AND status='running'`, runID, leaseToken, errorCode)
	if err != nil {
		return Run{}, err
	}
	if result.RowsAffected() != 1 {
		return Run{}, ErrConflict
	}
	return service.getByID(ctx, runID)
}

func (service *Service) reap(ctx context.Context) error {
	if _, err := service.pool.Exec(ctx, `UPDATE agent_runs SET status='timed_out',error_code='run_timeout',finished_at=now() WHERE status='queued' AND timeout_at<=now()`); err != nil {
		return err
	}
	_, err := service.pool.Exec(ctx, `UPDATE agent_runs SET status=CASE WHEN cancel_requested_at IS NOT NULL THEN 'canceled' WHEN attempt<max_attempts AND timeout_at>now() THEN 'queued' ELSE 'timed_out' END,error_code='lease_expired',attempt=CASE WHEN cancel_requested_at IS NULL AND attempt<max_attempts AND timeout_at>now() THEN attempt+1 ELSE attempt END,next_attempt_at=now(),finished_at=CASE WHEN cancel_requested_at IS NOT NULL OR attempt>=max_attempts OR timeout_at<=now() THEN now() ELSE NULL END,lease_token=NULL,lease_expires_at=NULL WHERE status='running' AND (lease_expires_at<=now() OR timeout_at<=now())`)
	return err
}

func validObject(value json.RawMessage) bool {
	if len(value) == 0 {
		return true
	}
	var object map[string]any
	return json.Unmarshal(value, &object) == nil && object != nil
}
func validPriceSource(value string) bool {
	return value == "provider" || value == "configured" || value == "estimated" || value == "unknown"
}
func canManage(current identity.User) bool {
	return permission.Allows(current.OrgRole, current.Permissions, permission.AgentsManage)
}
func isAgentWorker(current identity.User, authentication access.Identity) bool {
	return authentication.AuthenticationKind == "api_key" && authentication.ActorID == current.ActorID &&
		authentication.OrgID == current.OrgID && authentication.KeyID != "" && slices.Contains(authentication.Scopes, "runtime:execute")
}

const runSelect = `SELECT run.id,run.org_id,run.agent_id,run.trigger_id,run.trigger_event_seq,run.scheduled_for,run.chat_id,run.thread_root_id,run.requested_by,run.client_run_id,run.correlation_id,run.chain_depth,run.status,run.provider,run.model,run.input,run.result_summary,run.input_tokens,run.output_tokens,run.cost::text,run.currency,run.error_code,run.attempt,run.max_attempts,run.created_at,run.started_at,run.finished_at,run.cancel_requested_at,run.timeout_at,run.lease_token FROM agent_runs run`

type scanner interface{ Scan(...any) error }

func scanRun(row scanner) (Run, error) {
	var result Run
	err := row.Scan(&result.ID, &result.OrgID, &result.AgentID, &result.TriggerID, &result.TriggerEventSeq, &result.ScheduledFor, &result.ChatID, &result.ThreadRootID, &result.RequestedBy, &result.ClientRunID, &result.CorrelationID, &result.ChainDepth, &result.Status, &result.Provider, &result.Model, &result.Input, &result.ResultSummary, &result.InputTokens, &result.OutputTokens, &result.Cost, &result.Currency, &result.ErrorCode, &result.Attempt, &result.MaxAttempts, &result.CreatedAt, &result.StartedAt, &result.FinishedAt, &result.CancelRequestedAt, &result.TimeoutAt, &result.LeaseToken)
	return result, err
}
func (service *Service) getByID(ctx context.Context, runID string) (Run, error) {
	run, err := scanRun(service.pool.QueryRow(ctx, runSelect+` WHERE run.id=$1`, runID))
	if errors.Is(err, pgx.ErrNoRows) {
		return Run{}, ErrNotFound
	}
	return run, err
}
func (service *Service) getForOrg(ctx context.Context, orgID, agentID, clientRunID string) (Run, error) {
	run, err := scanRun(service.pool.QueryRow(ctx, runSelect+` WHERE run.org_id=$1 AND run.agent_id=$2 AND run.client_run_id=$3`, orgID, agentID, clientRunID))
	if errors.Is(err, pgx.ErrNoRows) {
		return Run{}, ErrNotFound
	}
	return run, err
}
