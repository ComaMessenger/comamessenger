package agentrun

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"time"

	"github.com/comamessenger/comamessenger/core/internal/access"
	"github.com/comamessenger/comamessenger/core/internal/agent"
	"github.com/comamessenger/comamessenger/core/internal/agentauthz"
	"github.com/comamessenger/comamessenger/core/internal/id"
	"github.com/comamessenger/comamessenger/core/internal/identity"
	"github.com/comamessenger/comamessenger/core/internal/permission"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

var (
	ErrInvalid     = errors.New("invalid agent run input")
	ErrForbidden   = errors.New("agent run forbidden")
	ErrNotFound    = errors.New("agent run not found")
	ErrConflict    = errors.New("agent run state conflict")
	ErrBudget      = errors.New("agent budget exceeded")
	ErrRateLimited = errors.New("agent provider rate limit exceeded")
)
var costPattern = regexp.MustCompile(`^[0-9]+(?:\.[0-9]{1,8})?$`)
var consumerPattern = regexp.MustCompile(`^[a-z0-9][a-z0-9_.-]{0,63}$`)
var mcpToolPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$`)

const serverReservedProviderCost = "0.01000000"

type Run struct {
	ID                string          `json:"id"`
	OrgID             string          `json:"org_id"`
	AgentID           string          `json:"agent_id"`
	AgentVersion      *int            `json:"agent_version"`
	DryRun            bool            `json:"dry_run"`
	AgentConfig       json.RawMessage `json:"agent_config"`
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
	DryRun         bool            `json:"dry_run"`
}
type ClaimInput struct {
	WorkerID     string `json:"worker_id"`
	LeaseSeconds int    `json:"lease_seconds"`
	WaitSeconds  int    `json:"wait_seconds"`
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

type RuntimeTarget struct {
	AgentID      string
	ChatID       string
	ThreadRootID *string
	DryRun       bool
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
	// Arguments are needed only when the call waits for a person's approval:
	// Core then executes the approved call with exactly these arguments.
	Arguments json.RawMessage `json:"arguments,omitempty"`
}
type MCPToolCall struct {
	ID            string `json:"id"`
	CorrelationID string `json:"correlation_id"`
	ToolName      string `json:"tool_name"`
	Mode          string `json:"mode"`
	Preview       bool   `json:"preview"`
	// ConfirmationRequired: the runtime must not call the tool; the HTTP
	// layer turns it into a pending confirmation.
	ConfirmationRequired bool   `json:"-"`
	AgentID              string `json:"-"`
	ConnectionID         string `json:"-"`
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
	// NextCursor continues a workspace listing; absent on the last page.
	NextCursor *string `json:"next_cursor,omitempty"`
}

// WorkspaceRunsInput pages through the runs of every agent of the workspace.
type WorkspaceRunsInput struct {
	Cursor  string
	Limit   int
	AgentID string
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
	if !canBuild(current) {
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
	var agentVersion *int
	var provider, model string
	var agentConfig json.RawMessage
	if input.DryRun {
		err = tx.QueryRow(ctx, `SELECT
			COALESCE(draft.max_chain_depth,agent.max_chain_depth),COALESCE(draft.version,agent.published_version),
			COALESCE(connection.provider,CASE WHEN draft.agent_id IS NOT NULL THEN draft.provider ELSE agent.provider END),
			COALESCE(NULLIF(CASE WHEN draft.agent_id IS NOT NULL THEN draft.model ELSE agent.model END,''),connection.default_model,''),
			jsonb_build_object(
				'id',agent.actor_id,'handle',actor.handle,
				'description',COALESCE(draft.description,agent.description),
				'allowed_scopes',to_jsonb(COALESCE(draft.allowed_scopes,agent.allowed_scopes)),
				'llm_connection_id',CASE WHEN draft.agent_id IS NOT NULL THEN draft.llm_connection_id ELSE agent.llm_connection_id END,
				'endpoint_url',COALESCE(connection.endpoint_url,CASE WHEN draft.agent_id IS NOT NULL THEN draft.endpoint_url ELSE agent.endpoint_url END),
				'external_data_sharing_approved',COALESCE(draft.external_data_sharing_approved,agent.external_data_sharing_approved),
				'max_output_tokens',COALESCE(draft.max_output_tokens,agent.max_output_tokens),
				'max_tool_iterations',COALESCE(draft.max_tool_iterations,agent.max_tool_iterations),
				'knowledge_collection_ids',to_jsonb(COALESCE(draft.knowledge_collection_ids,agent.knowledge_collection_ids)),
				'mcp_bindings',CASE WHEN draft.agent_id IS NOT NULL THEN draft.mcp_bindings ELSE agent.mcp_bindings END,
				'tone',CASE WHEN draft.agent_id IS NOT NULL THEN draft.tone ELSE agent.tone END,
				'read_only_chat_ids',to_jsonb(CASE WHEN draft.agent_id IS NOT NULL THEN draft.read_only_chat_ids ELSE agent.read_only_chat_ids END),
				'write_only_chat_ids',to_jsonb(CASE WHEN draft.agent_id IS NOT NULL THEN draft.write_only_chat_ids ELSE agent.write_only_chat_ids END),
				'confirmation_policy',CASE WHEN draft.agent_id IS NOT NULL THEN draft.confirmation_policy ELSE agent.confirmation_policy END
			)
			FROM agents agent JOIN actors actor ON actor.org_id=agent.org_id AND actor.id=agent.actor_id
			LEFT JOIN agent_drafts draft ON draft.org_id=agent.org_id AND draft.agent_id=agent.actor_id
			LEFT JOIN agent_llm_connections connection ON connection.org_id=agent.org_id AND connection.id=CASE WHEN draft.agent_id IS NOT NULL THEN draft.llm_connection_id ELSE agent.llm_connection_id END AND connection.enabled
			JOIN chats chat ON chat.org_id=agent.org_id AND chat.id=$3 AND chat.archived_at IS NULL
			WHERE agent.org_id=$1 AND agent.actor_id=$2 AND agent.deleted_at IS NULL
			AND ((draft.agent_id IS NOT NULL AND chat.id=ANY(draft.chat_ids)) OR (draft.agent_id IS NULL AND EXISTS(SELECT 1 FROM chat_members member WHERE member.org_id=agent.org_id AND member.actor_id=agent.actor_id AND member.chat_id=chat.id)))
			AND ((CASE WHEN draft.agent_id IS NOT NULL THEN draft.llm_connection_id ELSE agent.llm_connection_id END) IS NULL OR connection.id IS NOT NULL)
			FOR UPDATE OF agent`, current.OrgID, agentID, input.ChatID).Scan(&maxDepth, &agentVersion, &provider, &model, &agentConfig)
	} else {
		err = tx.QueryRow(ctx, `SELECT agent.max_chain_depth,agent.published_version,COALESCE(connection.provider,agent.provider),COALESCE(NULLIF(agent.model,''),connection.default_model,''),
			jsonb_build_object('id',agent.actor_id,'handle',actor.handle,'description',agent.description,'allowed_scopes',to_jsonb(agent.allowed_scopes),
			'llm_connection_id',agent.llm_connection_id,'endpoint_url',COALESCE(connection.endpoint_url,agent.endpoint_url),
			'external_data_sharing_approved',agent.external_data_sharing_approved,'max_output_tokens',agent.max_output_tokens,'max_tool_iterations',agent.max_tool_iterations,
			'knowledge_collection_ids',to_jsonb(agent.knowledge_collection_ids))
			FROM agents agent JOIN actors actor ON actor.org_id=agent.org_id AND actor.id=agent.actor_id
			LEFT JOIN agent_llm_connections connection ON connection.org_id=agent.org_id AND connection.id=agent.llm_connection_id AND connection.enabled
			JOIN chat_members member ON member.org_id=agent.org_id AND member.actor_id=agent.actor_id AND member.chat_id=$3
			JOIN chats chat ON chat.org_id=agent.org_id AND chat.id=member.chat_id AND chat.archived_at IS NULL
			WHERE agent.org_id=$1 AND agent.actor_id=$2 AND agent.enabled AND (agent.llm_connection_id IS NULL OR connection.id IS NOT NULL)
			FOR UPDATE OF agent`, current.OrgID, agentID, input.ChatID).Scan(&maxDepth, &agentVersion, &provider, &model, &agentConfig)
	}
	if errors.Is(err, pgx.ErrNoRows) {
		return Run{}, ErrNotFound
	}
	if err != nil {
		return Run{}, fmt.Errorf("authorize agent invocation: %w", err)
	}
	if input.ChainDepth < 0 || input.ChainDepth > maxDepth {
		return Run{}, ErrForbidden
	}
	// A person runs or checks an agent only on a chat they belong to, and a
	// check reads only knowledge collections they may read themself, so a
	// draft cannot show its builder what the builder cannot see.
	if err := checkRequesterReach(ctx, tx, current, input.ChatID, agentConfig, input.DryRun); err != nil {
		return Run{}, err
	}
	if input.DryRun {
		if agentConfig, err = withInstructions(agentConfig); err != nil {
			return Run{}, err
		}
	}
	requestedBy := current.ActorID
	timeoutAt := service.now().UTC().Add(time.Duration(input.TimeoutSeconds) * time.Second)
	_, err = tx.Exec(ctx, `INSERT INTO agent_runs(id,org_id,agent_id,agent_version,dry_run,agent_config,chat_id,thread_root_id,requested_by,client_run_id,correlation_id,chain_depth,provider,model,input,timeout_at,max_attempts) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) ON CONFLICT(agent_id,client_run_id) DO NOTHING`, runID, current.OrgID, agentID, agentVersion, input.DryRun, agentConfig, input.ChatID, input.ThreadRootID, requestedBy, input.ClientRunID, input.CorrelationID, input.ChainDepth, provider, model, input.Input, timeoutAt, input.MaxAttempts)
	if err != nil {
		return Run{}, fmt.Errorf("enqueue agent run: %w", err)
	}
	metadata, _ := json.Marshal(map[string]any{"run_id": runID, "chat_id": input.ChatID, "correlation_id": input.CorrelationID, "chain_depth": input.ChainDepth, "dry_run": input.DryRun, "agent_version": agentVersion})
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
	if !canView(current) {
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

// ListWorkspace returns the runs of all product agents of the workspace,
// newest first, for the activity feed. It needs agents.observe.
func (service *Service) ListWorkspace(ctx context.Context, current identity.User, input WorkspaceRunsInput) (Page, error) {
	if !agentauthz.New().CanObserve(current) {
		return Page{}, ErrForbidden
	}
	if input.Limit == 0 {
		input.Limit = 50
	}
	if input.Limit < 1 || input.Limit > 200 || (input.AgentID != "" && uuid.Validate(input.AgentID) != nil) {
		return Page{}, ErrInvalid
	}
	var cursorAt *time.Time
	var cursorID *string
	if input.Cursor != "" {
		decoded, err := base64.RawURLEncoding.DecodeString(input.Cursor)
		if err != nil {
			return Page{}, ErrInvalid
		}
		at, runID, found := strings.Cut(string(decoded), "|")
		parsed, parseErr := time.Parse(time.RFC3339Nano, at)
		if !found || parseErr != nil || uuid.Validate(runID) != nil {
			return Page{}, ErrInvalid
		}
		cursorAt, cursorID = &parsed, &runID
	}
	var agentFilter *string
	if input.AgentID != "" {
		agentFilter = &input.AgentID
	}
	rows, err := service.pool.Query(ctx, runSelect+`
		JOIN agents agent ON agent.org_id=run.org_id AND agent.actor_id=run.agent_id AND agent.system_role IS NULL
		WHERE run.org_id=$1 AND ($2::uuid IS NULL OR run.agent_id=$2)
		  AND ($3::timestamptz IS NULL OR (run.created_at,run.id) < ($3,$4::uuid))
		ORDER BY run.created_at DESC, run.id DESC LIMIT $5`, current.OrgID, agentFilter, cursorAt, cursorID, input.Limit+1)
	if err != nil {
		return Page{}, err
	}
	defer rows.Close()
	result := Page{Runs: make([]Run, 0, input.Limit)}
	for rows.Next() {
		run, err := scanRun(rows)
		if err != nil {
			return Page{}, err
		}
		result.Runs = append(result.Runs, run)
	}
	if err := rows.Err(); err != nil {
		return Page{}, err
	}
	if len(result.Runs) > input.Limit {
		result.Runs = result.Runs[:input.Limit]
		last := result.Runs[len(result.Runs)-1]
		cursor := base64.RawURLEncoding.EncodeToString([]byte(last.CreatedAt.UTC().Format(time.RFC3339Nano) + "|" + last.ID))
		result.NextCursor = &cursor
	}
	return result, nil
}

func (service *Service) RequestCancel(ctx context.Context, current identity.User, runID string) (Run, error) {
	if !canPublish(current) {
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
	if !canView(current) {
		return Run{}, ErrForbidden
	}
	run, err := scanRun(service.pool.QueryRow(ctx, runSelect+` WHERE run.org_id=$1 AND run.id=$2`, current.OrgID, runID))
	if errors.Is(err, pgx.ErrNoRows) {
		return Run{}, ErrNotFound
	}
	return run, err
}

// ToolCall is one recorded tool step of a run. Dry-run write steps are
// recorded as previews: they show what the agent would have done.
type ToolCall struct {
	ID         string     `json:"id"`
	ToolName   string     `json:"tool_name"`
	Mode       string     `json:"mode"`
	Status     string     `json:"status"`
	DryRun     bool       `json:"dry_run"`
	ErrorCode  string     `json:"error_code"`
	StartedAt  time.Time  `json:"started_at"`
	FinishedAt *time.Time `json:"finished_at"`
}

// ToolCalls lists the tool steps of a run in execution order for the
// human-readable trace of the agent check and activity views.
func (service *Service) ToolCalls(ctx context.Context, current identity.User, runID string) ([]ToolCall, error) {
	if !canView(current) {
		return nil, ErrForbidden
	}
	if uuid.Validate(runID) != nil {
		return nil, ErrNotFound
	}
	var exists bool
	if err := service.pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM agent_runs WHERE org_id=$1 AND id=$2)`, current.OrgID, runID).Scan(&exists); err != nil {
		return nil, err
	}
	if !exists {
		return nil, ErrNotFound
	}
	rows, err := service.pool.Query(ctx, `SELECT id,tool_name,mode,status,COALESCE(input_summary->>'dry_run','')='true',error_code,started_at,finished_at
		FROM agent_tool_calls WHERE org_id=$1 AND run_id=$2 ORDER BY started_at,id LIMIT 200`, current.OrgID, runID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := make([]ToolCall, 0)
	for rows.Next() {
		var item ToolCall
		if err := rows.Scan(&item.ID, &item.ToolName, &item.Mode, &item.Status, &item.DryRun, &item.ErrorCode, &item.StartedAt, &item.FinishedAt); err != nil {
			return nil, err
		}
		result = append(result, item)
	}
	return result, rows.Err()
}

func (service *Service) Claim(ctx context.Context, workerID string, lease time.Duration) (Run, error) {
	return service.claim(ctx, "", "", workerID, lease)
}

func (service *Service) ClaimForAgent(ctx context.Context, current identity.User, authentication access.Identity, input ClaimInput) (ClaimedRun, error) {
	authorizer := agentauthz.New()
	if !authorizer.CanWork(current, authentication) {
		return ClaimedRun{}, ErrForbidden
	}
	if input.LeaseSeconds == 0 {
		input.LeaseSeconds = 60
	}
	if input.WaitSeconds < 0 || input.WaitSeconds > 30 {
		return ClaimedRun{}, ErrInvalid
	}
	agentID := current.ActorID
	if authorizer.IsOrganizationWorker(current, authentication) {
		agentID = ""
	}
	deadline := service.now().Add(time.Duration(input.WaitSeconds) * time.Second)
	for {
		run, err := service.claim(ctx, current.OrgID, agentID, input.WorkerID, time.Duration(input.LeaseSeconds)*time.Second)
		if err == nil {
			if run.LeaseToken == nil {
				return ClaimedRun{}, ErrConflict
			}
			return ClaimedRun{Run: run, LeaseToken: *run.LeaseToken}, nil
		}
		if !errors.Is(err, ErrNotFound) || input.WaitSeconds == 0 || !service.now().Before(deadline) {
			return ClaimedRun{}, err
		}
		remaining := deadline.Sub(service.now())
		if remaining <= 0 {
			return ClaimedRun{}, ErrNotFound
		}
		pause := 500 * time.Millisecond
		if remaining < pause {
			pause = remaining
		}
		timer := time.NewTimer(pause)
		select {
		case <-ctx.Done():
			timer.Stop()
			return ClaimedRun{}, ctx.Err()
		case <-timer.C:
		}
	}
}

func (service *Service) claim(ctx context.Context, orgID, agentID, workerID string, lease time.Duration) (Run, error) {
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
	var orgFilter any
	if orgID != "" {
		orgFilter = orgID
	}
	rows, err := tx.Query(ctx, `SELECT run.id,run.agent_id,run.chat_id,agent.per_chat_concurrency
		FROM agent_runs run JOIN agents agent ON agent.org_id=run.org_id AND agent.actor_id=run.agent_id
		WHERE run.status='queued' AND run.next_attempt_at<=now() AND run.timeout_at>now()
			AND run.cancel_requested_at IS NULL AND (agent.enabled OR run.dry_run) AND ($1::uuid IS NULL OR run.org_id=$1)
			AND ($2::uuid IS NULL OR run.agent_id=$2)
		ORDER BY run.next_attempt_at,run.created_at FOR UPDATE OF run SKIP LOCKED LIMIT 20`, orgFilter, agentFilter)
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
	if input.LeaseSeconds == 0 {
		input.LeaseSeconds = 60
	}
	lease := time.Duration(input.LeaseSeconds) * time.Second
	if uuid.Validate(runID) != nil || uuid.Validate(input.LeaseToken) != nil || lease < 5*time.Second || lease > 5*time.Minute {
		return Run{}, ErrInvalid
	}
	agentID, err := service.runtimeAgentID(ctx, current, authentication, runID, input.LeaseToken)
	if err != nil {
		return Run{}, err
	}
	result, err := service.pool.Exec(ctx, `UPDATE agent_runs SET lease_expires_at=$5
		WHERE org_id=$1 AND agent_id=$2 AND id=$3 AND lease_token=$4 AND status='running'`, current.OrgID, agentID,
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
	agentID, err := service.runtimeAgentID(ctx, current, authentication, runID, input.LeaseToken)
	if err != nil {
		return Run{}, err
	}
	usage, err := service.providerUsage(ctx, current.OrgID, agentID, runID, input.LeaseToken)
	if err != nil {
		return Run{}, err
	}
	return service.Complete(ctx, runID, input.LeaseToken, Completion{
		InputTokens: usage.InputTokens, OutputTokens: usage.OutputTokens, Cost: usage.Cost,
		Currency: usage.Currency, ResultSummary: input.ResultSummary, PriceSource: usage.PriceSource,
	})
}

func (service *Service) FailForAgent(ctx context.Context, current identity.User, authentication access.Identity, runID string, input RuntimeFailure) (Run, error) {
	if _, err := service.runtimeAgentID(ctx, current, authentication, runID, input.LeaseToken); err != nil {
		return Run{}, err
	}
	return service.Fail(ctx, runID, input.LeaseToken, input.ErrorCode)
}

func (service *Service) GetRuntimeCheckpoint(ctx context.Context, current identity.User, authentication access.Identity, consumer string) (RuntimeCheckpoint, error) {
	if !agentauthz.New().CanWork(current, authentication) {
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
	if !agentauthz.New().CanWork(current, authentication) {
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
	return service.startProviderCall(ctx, current, authentication, input, serverReservedProviderCost)
}

// StartProviderCallServer is reserved for the core-side provider gateway. The
// reservation is derived by core from the selected model and request bounds,
// never accepted from the runtime process.
func (service *Service) StartProviderCallServer(ctx context.Context, current identity.User, authentication access.Identity, input StartProviderCallInput, reservedCost string) (ProviderCall, error) {
	return service.startProviderCall(ctx, current, authentication, input, reservedCost)
}

func (service *Service) startProviderCall(ctx context.Context, current identity.User, authentication access.Identity, input StartProviderCallInput, reservedCost string) (ProviderCall, error) {
	input.Currency = strings.ToUpper(strings.TrimSpace(input.Currency))
	if input.Currency == "" {
		input.Currency = "USD"
	}
	if uuid.Validate(input.CallID) != nil || uuid.Validate(input.RunID) != nil || uuid.Validate(input.LeaseToken) != nil ||
		!costPattern.MatchString(reservedCost) || input.Currency != "USD" {
		return ProviderCall{}, ErrInvalid
	}
	agentID, err := service.runtimeAgentID(ctx, current, authentication, input.RunID, input.LeaseToken)
	if err != nil {
		return ProviderCall{}, err
	}
	input.ReservedCost = reservedCost
	tx, err := service.pool.Begin(ctx)
	if err != nil {
		return ProviderCall{}, err
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, "agent-budget/"+agentID); err != nil {
		return ProviderCall{}, err
	}
	var correlationID, provider, model string
	err = tx.QueryRow(ctx, `SELECT run.correlation_id,run.provider,run.model FROM agent_runs run
		JOIN agents agent ON agent.org_id=run.org_id AND agent.actor_id=run.agent_id
		WHERE run.org_id=$1 AND run.agent_id=$2 AND run.id=$3 AND run.lease_token=$4 AND run.status='running'
		AND agent.external_data_sharing_approved FOR UPDATE OF run`,
		current.OrgID, agentID, input.RunID, input.LeaseToken).Scan(&correlationID, &provider, &model)
	if errors.Is(err, pgx.ErrNoRows) {
		return ProviderCall{}, ErrConflict
	}
	if err != nil {
		return ProviderCall{}, err
	}
	var dailyAllowed, monthlyAllowed, providerRateAllowed bool
	err = tx.QueryRow(ctx, `SELECT
		(agent.daily_cost_limit IS NULL OR COALESCE((SELECT sum(usage.cost) FROM agent_usage usage WHERE usage.agent_id=agent.actor_id AND usage.created_at>=date_trunc('day',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'),0)
			 + COALESCE((SELECT sum(CASE call.status WHEN 'started' THEN call.reserved_cost ELSE call.actual_cost END) FROM agent_provider_calls call
				WHERE call.agent_id=agent.actor_id AND call.created_at>=date_trunc('day',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
				AND call.status IN ('started','completed') AND NOT EXISTS (
					SELECT 1 FROM agent_usage accounted WHERE accounted.provider_call_id=call.id OR (accounted.provider_call_id IS NULL AND accounted.run_id=call.run_id)
				)),0) + $2::numeric <= agent.daily_cost_limit),
		(agent.monthly_cost_limit IS NULL OR COALESCE((SELECT sum(usage.cost) FROM agent_usage usage WHERE usage.agent_id=agent.actor_id AND usage.created_at>=date_trunc('month',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'),0)
			 + COALESCE((SELECT sum(CASE call.status WHEN 'started' THEN call.reserved_cost ELSE call.actual_cost END) FROM agent_provider_calls call
				WHERE call.agent_id=agent.actor_id AND call.created_at>=date_trunc('month',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
				AND call.status IN ('started','completed') AND NOT EXISTS (
					SELECT 1 FROM agent_usage accounted WHERE accounted.provider_call_id=call.id OR (accounted.provider_call_id IS NULL AND accounted.run_id=call.run_id)
				)),0) + $2::numeric <= agent.monthly_cost_limit)
		,((SELECT count(*) FROM agent_provider_calls recent WHERE recent.agent_id=agent.actor_id AND recent.created_at>=now()-interval '1 minute') < agent.provider_rate_limit_per_minute)
		FROM agents agent WHERE agent.actor_id=$1`, agentID, input.ReservedCost).Scan(&dailyAllowed, &monthlyAllowed, &providerRateAllowed)
	if err != nil {
		return ProviderCall{}, err
	}
	if !dailyAllowed || !monthlyAllowed {
		return ProviderCall{}, ErrBudget
	}
	if !providerRateAllowed {
		return ProviderCall{}, ErrRateLimited
	}
	_, err = tx.Exec(ctx, `INSERT INTO agent_provider_calls(id,org_id,agent_id,run_id,correlation_id,provider,model,reserved_cost,currency)
		VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(id) DO NOTHING`, input.CallID, current.OrgID, agentID,
		input.RunID, correlationID, provider, model, input.ReservedCost, input.Currency)
	if err != nil {
		return ProviderCall{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return ProviderCall{}, err
	}
	return service.providerCall(ctx, current.OrgID, agentID, input.CallID)
}

func (service *Service) FinishProviderCall(ctx context.Context, current identity.User, authentication access.Identity, callID string, input FinishProviderCallInput) (ProviderCall, error) {
	return service.finishProviderCall(ctx, current, authentication, callID, input, false)
}

// FinishProviderCallServer records usage observed by the core-side provider
// gateway. Runtime-supplied token and cost values never reach this path.
func (service *Service) FinishProviderCallServer(ctx context.Context, current identity.User, authentication access.Identity, callID string, input FinishProviderCallInput) (ProviderCall, error) {
	return service.finishProviderCall(ctx, current, authentication, callID, input, true)
}

func (service *Service) finishProviderCall(ctx context.Context, current identity.User, authentication access.Identity, callID string, input FinishProviderCallInput, trustedUsage bool) (ProviderCall, error) {
	input.Currency = strings.ToUpper(strings.TrimSpace(input.Currency))
	if input.Currency == "" {
		input.Currency = "USD"
	}
	if input.PriceSource == "" {
		input.PriceSource = "unknown"
	}
	if uuid.Validate(callID) != nil || uuid.Validate(input.RunID) != nil || uuid.Validate(input.LeaseToken) != nil ||
		(input.Status != "completed" && input.Status != "failed") || !costPattern.MatchString(input.ActualCost) || input.Currency != "USD" ||
		input.InputTokens < 0 || input.OutputTokens < 0 || !validPriceSource(input.PriceSource) {
		return ProviderCall{}, ErrInvalid
	}
	agentID, err := service.runtimeAgentID(ctx, current, authentication, input.RunID, input.LeaseToken)
	if err != nil {
		return ProviderCall{}, err
	}
	actualCost := input.ActualCost
	priceSource := input.PriceSource
	if !trustedUsage {
		actualCost = "0"
		priceSource = "unknown"
	}
	tx, err := service.pool.Begin(ctx)
	if err != nil {
		return ProviderCall{}, err
	}
	defer tx.Rollback(ctx)
	var correlationID, provider, model string
	err = tx.QueryRow(ctx, `UPDATE agent_provider_calls call SET status=$6,
		actual_cost=CASE WHEN $11 THEN $9::numeric WHEN $6='completed' THEN call.reserved_cost ELSE 0 END,currency='USD',
		input_tokens=$7,output_tokens=$8,price_source=CASE WHEN $11 THEN $10 WHEN $6='completed' THEN 'estimated' ELSE 'unknown' END,finished_at=now()
		FROM agent_runs run WHERE call.org_id=$1 AND call.agent_id=$2 AND call.id=$3 AND call.run_id=$4 AND call.status='started'
		AND run.id=call.run_id AND run.lease_token=$5 AND run.status='running' AND run.agent_id=$2 AND run.org_id=$1
		RETURNING call.correlation_id,call.provider,call.model`,
		current.OrgID, agentID, callID, input.RunID, input.LeaseToken, input.Status, input.InputTokens, input.OutputTokens, actualCost, priceSource, trustedUsage).Scan(&correlationID, &provider, &model)
	if errors.Is(err, pgx.ErrNoRows) {
		return ProviderCall{}, ErrConflict
	}
	if err != nil {
		return ProviderCall{}, err
	}
	if trustedUsage && (input.InputTokens > 0 || input.OutputTokens > 0 || actualCost != "0" && actualCost != "0.00000000") {
		usageID, err := id.New()
		if err != nil {
			return ProviderCall{}, err
		}
		if _, err := tx.Exec(ctx, `INSERT INTO agent_usage(id,org_id,agent_id,run_id,provider_call_id,correlation_id,provider,model,input_tokens,output_tokens,cost,currency,price_source)
			VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'USD',$12) ON CONFLICT(provider_call_id) DO NOTHING`,
			usageID, current.OrgID, agentID, input.RunID, callID, correlationID, provider, model, input.InputTokens, input.OutputTokens, actualCost, priceSource); err != nil {
			return ProviderCall{}, err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return ProviderCall{}, err
	}
	return service.providerCall(ctx, current.OrgID, agentID, callID)
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

type providerUsageSummary struct {
	InputTokens  int64
	OutputTokens int64
	Cost         string
	Currency     string
	PriceSource  string
}

func (service *Service) providerUsage(ctx context.Context, orgID, agentID, runID, leaseToken string) (providerUsageSummary, error) {
	var result providerUsageSummary
	var unfinished int
	var completed int
	result.Currency = "USD"
	err := service.pool.QueryRow(ctx, `SELECT
		count(*) FILTER (WHERE call.status='started'),
		count(*) FILTER (WHERE call.status='completed'),
		COALESCE(sum(call.input_tokens) FILTER (WHERE call.status='completed'),0),
		COALESCE(sum(call.output_tokens) FILTER (WHERE call.status='completed'),0),
		COALESCE(sum(call.actual_cost) FILTER (WHERE call.status='completed'),0)::text
		FROM agent_runs run LEFT JOIN agent_provider_calls call ON call.org_id=run.org_id AND call.agent_id=run.agent_id AND call.run_id=run.id
		WHERE run.org_id=$1 AND run.agent_id=$2 AND run.id=$3 AND run.lease_token=$4 AND run.status='running'
		GROUP BY run.id`, orgID, agentID, runID, leaseToken).Scan(&unfinished, &completed, &result.InputTokens, &result.OutputTokens, &result.Cost)
	if errors.Is(err, pgx.ErrNoRows) {
		return providerUsageSummary{}, ErrConflict
	}
	if err != nil {
		return providerUsageSummary{}, err
	}
	if unfinished > 0 {
		return providerUsageSummary{}, ErrConflict
	}
	if completed > 0 {
		result.PriceSource = "estimated"
	} else {
		result.PriceSource = "unknown"
	}
	return result, nil
}

func (service *Service) StartMCPToolCall(ctx context.Context, current identity.User, authentication access.Identity, input StartMCPToolCallInput) (MCPToolCall, error) {
	if uuid.Validate(input.CallID) != nil || uuid.Validate(input.RunID) != nil || uuid.Validate(input.LeaseToken) != nil || uuid.Validate(input.ServerID) != nil ||
		!mcpToolPattern.MatchString(input.ToolName) || (input.Mode != "read" && input.Mode != "write") || input.InputBytes < 0 || input.InputBytes > 262144 ||
		len(input.Arguments) > 262144 || (len(input.Arguments) > 0 && !validObject(input.Arguments)) {
		return MCPToolCall{}, ErrInvalid
	}
	agentID, err := service.runtimeAgentID(ctx, current, authentication, input.RunID, input.LeaseToken)
	if err != nil {
		return MCPToolCall{}, err
	}
	// The binding comes from the draft snapshot of a dry run, otherwise from
	// the published configuration. The tool must be allowlisted there.
	var dryRun, requireConfirmation, toolsKnown, legacyUnverified bool
	var correlationID, connectionName string
	var allowed, tools []byte
	var assignable []string
	err = service.pool.QueryRow(ctx, `SELECT run.dry_run,run.correlation_id::text,connection.name,binding.value->'allowed_tools',
		connection.writes_require_confirmation OR CASE WHEN binding.value->'confirmation_policy' ? $6
			THEN binding.value->'confirmation_policy'->>$6 <> 'auto'
			ELSE COALESCE((binding.value->>'require_write_confirmation')::boolean,true) END,
		connection.tools,connection.tools_refreshed_at IS NOT NULL,connection.legacy_unverified,connection.assignable_tools
		FROM agent_runs run JOIN agents agent ON agent.org_id=run.org_id AND agent.actor_id=run.agent_id
		CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN run.dry_run AND run.agent_config ? 'mcp_bindings' THEN run.agent_config->'mcp_bindings' ELSE agent.mcp_bindings END) binding
		JOIN integration_mcp_connections connection ON connection.org_id=run.org_id AND connection.id::text=binding.value->>'connection_id'
			AND connection.enabled AND connection.agent_use_allowed
		WHERE run.org_id=$1 AND run.agent_id=$2 AND run.id=$3 AND run.lease_token=$4 AND run.status='running' AND run.lease_expires_at>now()
		  AND connection.id=$5`, current.OrgID, agentID, input.RunID, input.LeaseToken, input.ServerID, input.ToolName).Scan(
		&dryRun, &correlationID, &connectionName, &allowed, &requireConfirmation, &tools, &toolsKnown, &legacyUnverified, &assignable)
	if errors.Is(err, pgx.ErrNoRows) {
		return MCPToolCall{}, ErrForbidden
	}
	if err != nil {
		return MCPToolCall{}, err
	}
	var allowedTools []string
	_ = json.Unmarshal(allowed, &allowedTools)
	if !containsString(allowedTools, input.ToolName) || (assignable != nil && !containsString(assignable, input.ToolName)) {
		return MCPToolCall{}, ErrForbidden
	}
	mode, offered := effectiveMCPMode(input.Mode, input.ToolName, tools, toolsKnown, legacyUnverified)
	if !offered {
		return MCPToolCall{}, ErrForbidden
	}
	exposedName := "mcp__" + connectionName + "__" + input.ToolName
	if mode == "write" && !dryRun && requireConfirmation {
		// Core executes the approved call with exactly the stored arguments, so
		// it never accepts a pending call without them.
		if len(input.Arguments) == 0 {
			return MCPToolCall{}, ErrInvalid
		}
		// Core does not record a call yet: a person decides first and Core
		// executes the approved call itself.
		return MCPToolCall{ID: input.CallID, CorrelationID: correlationID, ToolName: exposedName, Mode: mode, ConfirmationRequired: true,
			AgentID: agentID, ConnectionID: input.ServerID}, nil
	}
	summary, _ := json.Marshal(map[string]any{"input_bytes": input.InputBytes, "mcp_server_id": input.ServerID})
	result := MCPToolCall{ID: input.CallID, CorrelationID: correlationID, ToolName: exposedName, Mode: mode, Preview: dryRun && mode == "write"}
	if _, err := service.pool.Exec(ctx, `INSERT INTO agent_tool_calls(id,org_id,agent_id,run_id,correlation_id,tool_name,mode,required_scope,input_summary)
		VALUES($1,$2,$3,$4,$5,$6,$7,'mcp:' || $8,$9)`, input.CallID, current.OrgID, agentID, input.RunID, correlationID, exposedName, mode, connectionName, summary); err != nil {
		return MCPToolCall{}, err
	}
	return result, nil
}

// effectiveMCPMode classifies a call by Core's own tool catalog: a tool is
// read-only only when the catalog says so and the runtime agrees. Without a
// catalog every call is a write, except for connections migrated from
// per-agent servers, which keep the runtime's classification until their
// first successful test. offered is false for a tool the server does not
// list in a known catalog.
func effectiveMCPMode(claimed, toolName string, catalog []byte, known, legacyUnverified bool) (string, bool) {
	if !known {
		if legacyUnverified {
			return claimed, true
		}
		return "write", true
	}
	var tools []struct {
		Name     string `json:"name"`
		ReadOnly bool   `json:"read_only"`
	}
	_ = json.Unmarshal(catalog, &tools)
	for _, tool := range tools {
		if tool.Name == toolName {
			if tool.ReadOnly && claimed == "read" {
				return "read", true
			}
			return "write", true
		}
	}
	return "write", false
}

func containsString(values []string, target string) bool {
	for _, value := range values {
		if value == target {
			return true
		}
	}
	return false
}

func (service *Service) FinishMCPToolCall(ctx context.Context, current identity.User, authentication access.Identity, callID string, input FinishMCPToolCallInput) error {
	if uuid.Validate(callID) != nil || uuid.Validate(input.RunID) != nil || uuid.Validate(input.LeaseToken) != nil ||
		(input.Status != "completed" && input.Status != "failed") || input.OutputBytes < 0 || input.OutputBytes > 4194304 || len(input.ErrorCode) > 120 || (input.Status == "completed" && input.ErrorCode != "") {
		return ErrInvalid
	}
	agentID, err := service.runtimeAgentID(ctx, current, authentication, input.RunID, input.LeaseToken)
	if err != nil {
		return err
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
		RETURNING call.correlation_id,call.tool_name,call.mode`, current.OrgID, agentID, callID, input.RunID, input.LeaseToken, input.Status, input.OutputBytes, input.ErrorCode).Scan(&correlationID, &toolName, &mode)
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrConflict
	}
	if err != nil {
		return err
	}
	metadata, _ := json.Marshal(map[string]any{"tool_call_id": callID, "run_id": input.RunID, "correlation_id": correlationID, "tool": toolName, "mode": mode, "status": input.Status, "error_code": input.ErrorCode, "output_bytes": input.OutputBytes})
	if _, err := tx.Exec(ctx, `INSERT INTO audit_log(id,org_id,actor_id,action,target_type,target_id,metadata)
		VALUES($1,$2,$3,'agent.tool.call','agent',$3,$4)`, auditID, current.OrgID, agentID, metadata); err != nil {
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
	if uuid.Validate(runID) != nil || uuid.Validate(leaseToken) != nil || result.InputTokens < 0 || result.OutputTokens < 0 || !costPattern.MatchString(result.Cost) || result.Currency != "USD" || len(result.ResultSummary) > 262144 || !validObject(result.ResultSummary) || !validPriceSource(result.PriceSource) {
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
			input_tokens,output_tokens,cost,currency,price_source)
			SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12
			WHERE NOT EXISTS(SELECT 1 FROM agent_usage WHERE org_id=$2 AND run_id=$4)`,
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
func canBuild(current identity.User) bool   { return agentauthz.New().CanBuild(current) }
func canPublish(current identity.User) bool { return agentauthz.New().CanPublish(current) }
func canView(current identity.User) bool    { return agentauthz.New().CanView(current) }
func (service *Service) runtimeAgentID(ctx context.Context, current identity.User, authentication access.Identity, runID, leaseToken string) (string, error) {
	target, err := service.RuntimeTarget(ctx, current, authentication, runID, leaseToken)
	return target.AgentID, err
}

func (service *Service) RuntimeTarget(ctx context.Context, current identity.User, authentication access.Identity, runID, leaseToken string) (RuntimeTarget, error) {
	authorizer := agentauthz.New()
	if !authorizer.CanWork(current, authentication) {
		return RuntimeTarget{}, ErrForbidden
	}
	var target RuntimeTarget
	err := service.pool.QueryRow(ctx, `SELECT agent_id,chat_id,thread_root_id,dry_run FROM agent_runs WHERE org_id=$1 AND id=$2 AND lease_token=$3 AND status='running' AND lease_expires_at>now() AND chat_id IS NOT NULL
		AND ($4::boolean OR agent_id=$5)`, current.OrgID, runID, leaseToken, authorizer.IsOrganizationWorker(current, authentication), current.ActorID).Scan(&target.AgentID, &target.ChatID, &target.ThreadRootID, &target.DryRun)
	if errors.Is(err, pgx.ErrNoRows) {
		return RuntimeTarget{}, ErrConflict
	}
	return target, err
}

func (service *Service) RuntimeAgentID(ctx context.Context, current identity.User, authentication access.Identity, runID, leaseToken string) (string, error) {
	return service.runtimeAgentID(ctx, current, authentication, runID, leaseToken)
}

const runSelect = `SELECT run.id,run.org_id,run.agent_id,run.agent_version,run.dry_run,run.agent_config,run.trigger_id,run.trigger_event_seq,run.scheduled_for,run.chat_id,run.thread_root_id,run.requested_by,run.client_run_id,run.correlation_id,run.chain_depth,run.status,run.provider,run.model,run.input,run.result_summary,run.input_tokens,run.output_tokens,run.cost::text,run.currency,run.error_code,run.attempt,run.max_attempts,run.created_at,run.started_at,run.finished_at,run.cancel_requested_at,run.timeout_at,run.lease_token FROM agent_runs run`

type scanner interface{ Scan(...any) error }

func scanRun(row scanner) (Run, error) {
	var result Run
	err := row.Scan(&result.ID, &result.OrgID, &result.AgentID, &result.AgentVersion, &result.DryRun, &result.AgentConfig, &result.TriggerID, &result.TriggerEventSeq, &result.ScheduledFor, &result.ChatID, &result.ThreadRootID, &result.RequestedBy, &result.ClientRunID, &result.CorrelationID, &result.ChainDepth, &result.Status, &result.Provider, &result.Model, &result.Input, &result.ResultSummary, &result.InputTokens, &result.OutputTokens, &result.Cost, &result.Currency, &result.ErrorCode, &result.Attempt, &result.MaxAttempts, &result.CreatedAt, &result.StartedAt, &result.FinishedAt, &result.CancelRequestedAt, &result.TimeoutAt, &result.LeaseToken)
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

// withInstructions adds the trusted instructions Core derives from the draft
// snapshot (task, tone, chat roles), so a check run sees exactly what the
// published agent would send to the model.
func withInstructions(config json.RawMessage) (json.RawMessage, error) {
	var fields map[string]any
	if err := json.Unmarshal(config, &fields); err != nil {
		return nil, fmt.Errorf("decode agent configuration: %w", err)
	}
	var snapshot struct {
		Description      string   `json:"description"`
		Tone             string   `json:"tone"`
		ReadOnlyChatIDs  []string `json:"read_only_chat_ids"`
		WriteOnlyChatIDs []string `json:"write_only_chat_ids"`
	}
	if err := json.Unmarshal(config, &snapshot); err != nil {
		return nil, fmt.Errorf("decode agent configuration: %w", err)
	}
	fields["instructions"] = agent.Instructions(snapshot.Description, snapshot.Tone, snapshot.ReadOnlyChatIDs, snapshot.WriteOnlyChatIDs)
	return json.Marshal(fields)
}

func checkRequesterReach(ctx context.Context, tx pgx.Tx, current identity.User, chatID string, config json.RawMessage, dryRun bool) error {
	var member bool
	if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM chat_members WHERE org_id=$1 AND chat_id=$2 AND actor_id=$3)`, current.OrgID, chatID, current.ActorID).Scan(&member); err != nil {
		return err
	}
	if !member {
		return ErrForbidden
	}
	if !dryRun || permission.Allows(current.OrgRole, current.Permissions, permission.KnowledgeManage) {
		return nil
	}
	var snapshot struct {
		Collections []string `json:"knowledge_collection_ids"`
	}
	_ = json.Unmarshal(config, &snapshot)
	if len(snapshot.Collections) == 0 {
		return nil
	}
	var hidden bool
	if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM knowledge_collections collection
		WHERE collection.org_id=$1 AND collection.id=ANY($3::uuid[]) AND collection.access<>'organization' AND NOT EXISTS(
			SELECT 1 FROM knowledge_collection_chats shared
			JOIN chat_members member ON member.org_id=shared.org_id AND member.chat_id=shared.chat_id AND member.actor_id=$2
			WHERE shared.org_id=collection.org_id AND shared.collection_id=collection.id))`, current.OrgID, current.ActorID, snapshot.Collections).Scan(&hidden); err != nil {
		return err
	}
	if hidden {
		return ErrForbidden
	}
	return nil
}
