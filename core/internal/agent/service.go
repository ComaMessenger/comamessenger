package agent

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/url"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/comamessenger/comamessenger/core/internal/access"
	"github.com/comamessenger/comamessenger/core/internal/agentauthz"
	"github.com/comamessenger/comamessenger/core/internal/id"
	"github.com/comamessenger/comamessenger/core/internal/identity"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

var (
	ErrInvalid     = errors.New("invalid agent input")
	ErrForbidden   = errors.New("agent management forbidden")
	ErrNotFound    = errors.New("agent not found")
	ErrConflict    = errors.New("agent conflicts with existing data")
	ErrRateLimited = errors.New("agent rate limit exceeded")
	ErrNotReady    = errors.New("agent is not ready")
)

type Scope string

const (
	ScopeChatsRead      Scope = "chats:read"
	ScopeMessagesRead   Scope = "messages:read"
	ScopeMessagesWrite  Scope = "messages:write"
	ScopeReactionsWrite Scope = "reactions:write"
	ScopeFilesRead      Scope = "files:read"
	ScopeSearchRead     Scope = "search:read"
	ScopeMembersRead    Scope = "members:read"
	ScopeMemoryRead     Scope = "memory:read"
	ScopeMemoryWrite    Scope = "memory:write"
	ScopeRuntimeExecute Scope = "runtime:execute"
	ScopeRuntimeWorker  Scope = "runtime:worker"
)

var validScopes = map[Scope]struct{}{
	ScopeChatsRead: {}, ScopeMessagesRead: {}, ScopeMessagesWrite: {}, ScopeReactionsWrite: {},
	ScopeFilesRead: {}, ScopeSearchRead: {}, ScopeMembersRead: {}, ScopeMemoryRead: {}, ScopeMemoryWrite: {},
	ScopeRuntimeExecute: {}, ScopeRuntimeWorker: {},
}

var handlePattern = regexp.MustCompile(`^[a-z0-9][a-z0-9_.-]{1,31}$`)
var costLimitPattern = regexp.MustCompile(`^[0-9]+(?:\.[0-9]{1,8})?$`)

type Agent struct {
	ID                          string     `json:"id"`
	OrgID                       string     `json:"org_id"`
	OwnerActorID                string     `json:"owner_actor_id"`
	DisplayName                 string     `json:"display_name"`
	Handle                      string     `json:"handle"`
	Kind                        string     `json:"kind"`
	Recipe                      string     `json:"recipe"`
	RecipeVersion               int        `json:"recipe_version"`
	Description                 string     `json:"description"`
	Enabled                     bool       `json:"enabled"`
	AllowedScopes               []Scope    `json:"allowed_scopes"`
	LLMConnectionID             *string    `json:"llm_connection_id"`
	Provider                    string     `json:"provider"`
	Model                       string     `json:"model"`
	EndpointURL                 string     `json:"endpoint_url,omitempty"`
	ExternalDataSharingApproved bool       `json:"external_data_sharing_approved"`
	DailyCostLimit              *string    `json:"daily_cost_limit"`
	MonthlyCostLimit            *string    `json:"monthly_cost_limit"`
	MaxOutputTokens             int        `json:"max_output_tokens"`
	MaxToolIterations           int        `json:"max_tool_iterations"`
	MaxChainDepth               int        `json:"max_chain_depth"`
	PerChatConcurrency          int        `json:"per_chat_concurrency"`
	RateLimitPerMinute          int        `json:"rate_limit_per_minute"`
	ProviderRateLimitPerMinute  int        `json:"provider_rate_limit_per_minute"`
	ExecutionTimeoutSeconds     int        `json:"execution_timeout_seconds"`
	ChatIDs                     []string   `json:"chat_ids"`
	Readiness                   Readiness  `json:"readiness"`
	OperationalStatus           string     `json:"operational_status"`
	DraftVersion                *int       `json:"draft_version"`
	PublishedVersion            *int       `json:"published_version"`
	HasUnpublishedChanges       bool       `json:"has_unpublished_changes"`
	PublishedAt                 *time.Time `json:"published_at"`
	AvatarVersion               int64      `json:"avatar_version"`
	CreatedAt                   time.Time  `json:"created_at"`
	UpdatedAt                   time.Time  `json:"updated_at"`
}

type Readiness struct {
	State    string   `json:"state"`
	Ready    bool     `json:"ready"`
	Blockers []string `json:"blockers"`
}

type Version struct {
	ID          string    `json:"id"`
	AgentID     string    `json:"agent_id"`
	Version     int       `json:"version"`
	CreatedBy   string    `json:"created_by"`
	CreatedAt   time.Time `json:"created_at"`
	PublishedAt time.Time `json:"published_at"`
}

type CreateInput struct {
	DisplayName                 string   `json:"display_name"`
	Handle                      string   `json:"handle"`
	Kind                        string   `json:"kind"`
	Recipe                      string   `json:"recipe"`
	Description                 string   `json:"description"`
	Enabled                     bool     `json:"enabled"`
	AllowedScopes               []Scope  `json:"allowed_scopes"`
	LLMConnectionID             *string  `json:"llm_connection_id"`
	Provider                    string   `json:"provider"`
	Model                       string   `json:"model"`
	EndpointURL                 string   `json:"endpoint_url"`
	ExternalDataSharingApproved bool     `json:"external_data_sharing_approved"`
	DailyCostLimit              *string  `json:"daily_cost_limit"`
	MonthlyCostLimit            *string  `json:"monthly_cost_limit"`
	MaxOutputTokens             *int     `json:"max_output_tokens"`
	MaxToolIterations           *int     `json:"max_tool_iterations"`
	MaxChainDepth               *int     `json:"max_chain_depth"`
	PerChatConcurrency          *int     `json:"per_chat_concurrency"`
	RateLimitPerMinute          int      `json:"rate_limit_per_minute"`
	ProviderRateLimitPerMinute  int      `json:"provider_rate_limit_per_minute"`
	ExecutionTimeoutSeconds     int      `json:"execution_timeout_seconds"`
	ChatIDs                     []string `json:"chat_ids"`
	DuplicateFrom               string   `json:"-"`
}

type DuplicateInput struct {
	DisplayName string `json:"display_name"`
	Handle      string `json:"handle"`
}

type UpdateInput struct {
	DisplayName                 *string   `json:"display_name"`
	Handle                      *string   `json:"handle"`
	Description                 *string   `json:"description"`
	Enabled                     *bool     `json:"enabled"`
	AllowedScopes               *[]Scope  `json:"allowed_scopes"`
	LLMConnectionID             *string   `json:"llm_connection_id"`
	Provider                    *string   `json:"provider"`
	Model                       *string   `json:"model"`
	EndpointURL                 *string   `json:"endpoint_url"`
	ExternalDataSharingApproved *bool     `json:"external_data_sharing_approved"`
	DailyCostLimit              *string   `json:"daily_cost_limit"`
	MonthlyCostLimit            *string   `json:"monthly_cost_limit"`
	MaxOutputTokens             *int      `json:"max_output_tokens"`
	MaxToolIterations           *int      `json:"max_tool_iterations"`
	MaxChainDepth               *int      `json:"max_chain_depth"`
	PerChatConcurrency          *int      `json:"per_chat_concurrency"`
	RateLimitPerMinute          *int      `json:"rate_limit_per_minute"`
	ProviderRateLimitPerMinute  *int      `json:"provider_rate_limit_per_minute"`
	ExecutionTimeoutSeconds     *int      `json:"execution_timeout_seconds"`
	ChatIDs                     *[]string `json:"chat_ids"`
}

type PlatformSettings struct {
	OrganizationRateLimitPerMinute int `json:"organization_rate_limit_per_minute"`
}

type ProductMetrics struct {
	AgentsTotal                  int64   `json:"agents_total"`
	AgentsPublished              int64   `json:"agents_published"`
	TestRunsTotal                int64   `json:"test_runs_total"`
	TestRunsFailed               int64   `json:"test_runs_failed"`
	AverageSecondsToFirstTest    float64 `json:"average_seconds_to_first_test"`
	AverageSecondsToFirstPublish float64 `json:"average_seconds_to_first_publish"`
}

type UpdatePlatformSettingsInput struct {
	OrganizationRateLimitPerMinute int `json:"organization_rate_limit_per_minute"`
}

type APIKey struct {
	ID                 string     `json:"id"`
	AgentID            string     `json:"agent_id"`
	Name               string     `json:"name"`
	Prefix             string     `json:"prefix"`
	Scopes             []Scope    `json:"scopes"`
	RateLimitPerMinute int        `json:"rate_limit_per_minute"`
	CreatedAt          time.Time  `json:"created_at"`
	LastUsedAt         *time.Time `json:"last_used_at,omitempty"`
	ExpiresAt          *time.Time `json:"expires_at,omitempty"`
	RevokedAt          *time.Time `json:"revoked_at,omitempty"`
}

type CreatedAPIKey struct {
	APIKey
	Secret string `json:"secret"`
}

type UsageEntry struct {
	ID            string    `json:"id"`
	RunID         *string   `json:"run_id"`
	CorrelationID string    `json:"correlation_id"`
	Provider      string    `json:"provider"`
	Model         string    `json:"model"`
	InputTokens   int64     `json:"input_tokens"`
	OutputTokens  int64     `json:"output_tokens"`
	Cost          string    `json:"cost"`
	Currency      string    `json:"currency"`
	PriceSource   string    `json:"price_source"`
	CreatedAt     time.Time `json:"created_at"`
}

type UsageReport struct {
	DailyCost         string       `json:"daily_cost"`
	MonthlyCost       string       `json:"monthly_cost"`
	DailyInputTokens  int64        `json:"daily_input_tokens"`
	DailyOutputTokens int64        `json:"daily_output_tokens"`
	MonthlyRuns       int64        `json:"monthly_runs"`
	Currency          string       `json:"currency"`
	Recent            []UsageEntry `json:"recent"`
}

type CreateKeyInput struct {
	Name               string     `json:"name"`
	Scopes             []Scope    `json:"scopes"`
	RateLimitPerMinute int        `json:"rate_limit_per_minute"`
	ExpiresAt          *time.Time `json:"expires_at"`
}

type Service struct {
	pool          *pgxpool.Pool
	now           func() time.Time
	revokeSession func(string)
}

func NewService(pool *pgxpool.Pool) *Service {
	return &Service{pool: pool, now: time.Now}
}

func (service *Service) SetRevokeSession(callback func(string)) {
	service.revokeSession = callback
}

// EnsureRuntimeWorker provisions the installation-managed organization worker.
// The plaintext secret is supplied by the deployment environment; only its
// digest is stored in PostgreSQL. The worker is deliberately excluded from all
// product-facing agent queries.
func (service *Service) EnsureRuntimeWorker(ctx context.Context, secret string) (bool, error) {
	secret = strings.TrimSpace(secret)
	if secret == "" {
		return false, nil
	}
	if !strings.HasPrefix(secret, "coma_agent_") || len(secret) < 54 || len(secret) > 256 {
		return false, fmt.Errorf("invalid runtime worker secret")
	}
	digest := sha256.Sum256([]byte(secret))
	prefix := secret[:20]

	tx, err := service.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.Serializable})
	if err != nil {
		return false, fmt.Errorf("begin runtime worker provisioning: %w", err)
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtext('comamessenger.runtime-worker'))`); err != nil {
		return false, fmt.Errorf("lock runtime worker provisioning: %w", err)
	}

	var organizationCount int
	if err := tx.QueryRow(ctx, `SELECT count(*) FROM organizations`).Scan(&organizationCount); err != nil {
		return false, fmt.Errorf("count runtime worker organizations: %w", err)
	}
	if organizationCount == 0 {
		return false, nil
	}
	if organizationCount != 1 {
		return false, fmt.Errorf("installation runtime worker requires exactly one organization")
	}
	var orgID, ownerID string
	if err := tx.QueryRow(ctx, `
		SELECT organization.id, owner.id
		FROM organizations organization
		JOIN LATERAL (
			SELECT id FROM actors
			WHERE org_id=organization.id AND type='user' AND org_role='owner'
			  AND status='active' AND deleted_at IS NULL
			ORDER BY created_at,id LIMIT 1
		) owner ON true`).Scan(&orgID, &ownerID); err != nil {
		return false, fmt.Errorf("resolve runtime worker owner: %w", err)
	}

	var workerID string
	err = tx.QueryRow(ctx, `SELECT actor_id FROM agents WHERE org_id=$1 AND system_role='runtime_worker' AND deleted_at IS NULL FOR UPDATE`, orgID).Scan(&workerID)
	if errors.Is(err, pgx.ErrNoRows) {
		workerID, err = id.New()
		if err != nil {
			return false, err
		}
		if _, err := tx.Exec(ctx, `
			INSERT INTO actors(id,org_id,type,org_role,display_name,handle,status)
			VALUES($1,$2,'agent','member','Coma runtime','coma_runtime_worker','active')`, workerID, orgID); err != nil {
			return false, fmt.Errorf("insert runtime worker actor: %w", err)
		}
		if _, err := tx.Exec(ctx, `
			INSERT INTO agents(actor_id,org_id,owner_actor_id,kind,enabled,allowed_scopes,
				rate_limit_per_minute,provider_rate_limit_per_minute,operational_status,system_role)
			VALUES($1,$2,$3,'builtin',true,ARRAY['runtime:worker']::text[],100000,100000,'active','runtime_worker')`, workerID, orgID, ownerID); err != nil {
			return false, fmt.Errorf("insert runtime worker agent: %w", err)
		}
	} else if err != nil {
		return false, fmt.Errorf("find runtime worker: %w", err)
	} else {
		if _, err := tx.Exec(ctx, `UPDATE actors SET status='active',deleted_at=NULL WHERE org_id=$1 AND id=$2`, orgID, workerID); err != nil {
			return false, fmt.Errorf("activate runtime worker actor: %w", err)
		}
		if _, err := tx.Exec(ctx, `
			UPDATE agents SET owner_actor_id=$3,enabled=true,allowed_scopes=ARRAY['runtime:worker']::text[],
				rate_limit_per_minute=100000,provider_rate_limit_per_minute=100000,operational_status='active',updated_at=now()
			WHERE org_id=$1 AND actor_id=$2`, orgID, workerID, ownerID); err != nil {
			return false, fmt.Errorf("activate runtime worker agent: %w", err)
		}
	}

	if _, err := tx.Exec(ctx, `
		UPDATE agent_api_keys SET revoked_at=now()
		WHERE org_id=$1 AND agent_id=$2 AND revoked_at IS NULL AND key_hash<>$3`, orgID, workerID, digest[:]); err != nil {
		return false, fmt.Errorf("rotate runtime worker keys: %w", err)
	}
	var keyExists bool
	if err := tx.QueryRow(ctx, `
		SELECT EXISTS(SELECT 1 FROM agent_api_keys
		WHERE org_id=$1 AND agent_id=$2 AND key_hash=$3 AND revoked_at IS NULL
		  AND (expires_at IS NULL OR expires_at>now()))`, orgID, workerID, digest[:]).Scan(&keyExists); err != nil {
		return false, fmt.Errorf("find runtime worker key: %w", err)
	}
	if !keyExists {
		keyID, err := id.New()
		if err != nil {
			return false, err
		}
		if _, err := tx.Exec(ctx, `
			INSERT INTO agent_api_keys(id,org_id,agent_id,name,key_hash,key_prefix,scopes,rate_limit_per_minute,created_by)
			VALUES($1,$2,$3,'Installation runtime worker',$4,$5,ARRAY['runtime:worker']::text[],100000,$6)`, keyID, orgID, workerID, digest[:], prefix, ownerID); err != nil {
			return false, fmt.Errorf("insert runtime worker key: %w", err)
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return false, fmt.Errorf("commit runtime worker provisioning: %w", err)
	}
	return true, nil
}

func (service *Service) RunRuntimeWorkerProvisioner(ctx context.Context, secret string, logger *slog.Logger) {
	if strings.TrimSpace(secret) == "" {
		return
	}
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	for {
		ready, err := service.EnsureRuntimeWorker(ctx, secret)
		if err != nil {
			logger.Warn("runtime worker provisioning failed; retrying", "error", err)
		} else if ready {
			logger.Info("runtime worker credential is ready")
			return
		}
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

func (service *Service) Create(ctx context.Context, current identity.User, input CreateInput) (Agent, error) {
	if !canBuild(current) {
		return Agent{}, ErrForbidden
	}
	normalized, err := normalizeCreate(input)
	if err != nil {
		return Agent{}, err
	}
	agentID, err := id.New()
	if err != nil {
		return Agent{}, err
	}
	auditID, err := id.New()
	if err != nil {
		return Agent{}, err
	}
	tx, err := service.pool.Begin(ctx)
	if err != nil {
		return Agent{}, fmt.Errorf("begin agent creation: %w", err)
	}
	defer tx.Rollback(ctx)
	if normalized.LLMConnectionID != nil {
		provider, endpoint, defaultModel, err := resolveLLMConnection(ctx, tx, current.OrgID, *normalized.LLMConnectionID)
		if err != nil {
			return Agent{}, err
		}
		normalized.Provider = provider
		normalized.EndpointURL = endpoint
		if normalized.Model == "" {
			normalized.Model = defaultModel
		}
		if normalized.Model == "" {
			return Agent{}, fmt.Errorf("%w: the selected LLM connection has no default model", ErrInvalid)
		}
	}
	if len(normalized.ChatIDs) > 0 {
		var count int
		if err := tx.QueryRow(ctx, `SELECT count(*) FROM chats WHERE org_id=$1 AND id=ANY($2::uuid[]) AND archived_at IS NULL`, current.OrgID, normalized.ChatIDs).Scan(&count); err != nil {
			return Agent{}, fmt.Errorf("validate agent chats: %w", err)
		}
		if count != len(normalized.ChatIDs) {
			return Agent{}, fmt.Errorf("%w: every chat must be active and belong to the organization", ErrInvalid)
		}
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO actors(id,org_id,type,org_role,display_name,handle,status)
		VALUES($1,$2,'agent','member',$3,$4,'active')`, agentID, current.OrgID, normalized.DisplayName, normalized.Handle); err != nil {
		return Agent{}, mapWriteError("insert agent actor", err)
	}
	scopes := scopeStrings(normalized.AllowedScopes)
	if _, err := tx.Exec(ctx, `
		INSERT INTO agents(actor_id,org_id,owner_actor_id,kind,recipe,recipe_version,description,enabled,allowed_scopes,llm_connection_id,provider,model,endpoint_url,
			external_data_sharing_approved,daily_cost_limit,monthly_cost_limit,max_output_tokens,max_tool_iterations,max_chain_depth,per_chat_concurrency,
			rate_limit_per_minute,provider_rate_limit_per_minute,execution_timeout_seconds)
		VALUES($1,$2,$3,$4,$5,1,$6,$7,$8,$9,$10,$11,$12,$13,NULLIF($14,'')::numeric,NULLIF($15,'')::numeric,$16,$17,$18,$19,$20,$21,$22)`, agentID, current.OrgID, current.ActorID, normalized.Kind, normalized.Recipe,
		normalized.Description, normalized.Enabled, scopes, normalized.LLMConnectionID, normalized.Provider, normalized.Model, normalized.EndpointURL,
		normalized.ExternalDataSharingApproved, costLimitValue(normalized.DailyCostLimit), costLimitValue(normalized.MonthlyCostLimit),
		*normalized.MaxOutputTokens, *normalized.MaxToolIterations, *normalized.MaxChainDepth,
		*normalized.PerChatConcurrency, normalized.RateLimitPerMinute, normalized.ProviderRateLimitPerMinute, normalized.ExecutionTimeoutSeconds); err != nil {
		return Agent{}, mapWriteError("insert agent", err)
	}
	if err := saveDraft(ctx, tx, current.OrgID, agentID, current.ActorID, 1, normalized); err != nil {
		return Agent{}, err
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO agent_checkpoints(org_id,agent_id,last_event_seq)
		SELECT $1,$2,event_seq FROM organizations WHERE id=$1`, current.OrgID, agentID); err != nil {
		return Agent{}, mapWriteError("initialize agent checkpoint", err)
	}
	if len(normalized.ChatIDs) > 0 {
		if _, err := tx.Exec(ctx, `
			INSERT INTO chat_members(chat_id,actor_id,org_id,role)
			SELECT chat_id,$1,$2,'member' FROM unnest($3::uuid[]) AS selected(chat_id)`, agentID, current.OrgID, normalized.ChatIDs); err != nil {
			return Agent{}, mapWriteError("add agent memberships", err)
		}
	}
	if normalized.DuplicateFrom != "" {
		if err := copyAgentTriggers(ctx, tx, current.OrgID, normalized.DuplicateFrom, agentID); err != nil {
			return Agent{}, err
		}
	} else {
		if err := insertRecipeTriggers(ctx, tx, current.OrgID, agentID, normalized.Recipe, normalized.ChatIDs, service.now().UTC()); err != nil {
			return Agent{}, err
		}
	}
	action := "agent.create"
	if normalized.DuplicateFrom != "" {
		action = "agent.duplicate"
	}
	metadata, _ := json.Marshal(map[string]any{"kind": normalized.Kind, "recipe": normalized.Recipe, "recipe_version": 1, "enabled": normalized.Enabled, "scopes": scopes, "chat_ids": normalized.ChatIDs, "duplicated_from": normalized.DuplicateFrom})
	if _, err := tx.Exec(ctx, `INSERT INTO audit_log(id,org_id,actor_id,action,target_type,target_id,metadata) VALUES($1,$2,$3,$4,'agent',$5,$6)`, auditID, current.OrgID, current.ActorID, action, agentID, metadata); err != nil {
		return Agent{}, fmt.Errorf("audit agent creation: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return Agent{}, mapWriteError("commit agent creation", err)
	}
	return service.Get(ctx, current, agentID)
}

func (service *Service) Duplicate(ctx context.Context, current identity.User, agentID string, input DuplicateInput) (Agent, error) {
	if !canBuild(current) {
		return Agent{}, ErrForbidden
	}
	source, err := service.Get(ctx, current, agentID)
	if err != nil {
		return Agent{}, err
	}
	createInput := CreateInput{
		DisplayName: input.DisplayName, Handle: input.Handle, Kind: source.Kind, Recipe: source.Recipe,
		Description: source.Description, Enabled: false, AllowedScopes: source.AllowedScopes,
		LLMConnectionID: source.LLMConnectionID, Model: source.Model,
		ExternalDataSharingApproved: source.ExternalDataSharingApproved, DailyCostLimit: source.DailyCostLimit, MonthlyCostLimit: source.MonthlyCostLimit,
		MaxOutputTokens: intPointer(source.MaxOutputTokens), MaxToolIterations: intPointer(source.MaxToolIterations), MaxChainDepth: intPointer(source.MaxChainDepth), PerChatConcurrency: intPointer(source.PerChatConcurrency),
		RateLimitPerMinute: source.RateLimitPerMinute, ProviderRateLimitPerMinute: source.ProviderRateLimitPerMinute, ExecutionTimeoutSeconds: source.ExecutionTimeoutSeconds,
		ChatIDs: source.ChatIDs, DuplicateFrom: source.ID,
	}
	if source.LLMConnectionID == nil {
		createInput.Provider = source.Provider
		createInput.EndpointURL = source.EndpointURL
	}
	return service.Create(ctx, current, createInput)
}

func (service *Service) ResetRecipe(ctx context.Context, current identity.User, agentID string) (Agent, error) {
	if !canBuild(current) {
		return Agent{}, ErrForbidden
	}
	if uuid.Validate(agentID) != nil {
		return Agent{}, ErrNotFound
	}
	tx, err := service.pool.Begin(ctx)
	if err != nil {
		return Agent{}, err
	}
	defer tx.Rollback(ctx)
	locked, err := scanAgent(tx.QueryRow(ctx, agentSelect+` WHERE agent.org_id=$1 AND agent.actor_id=$2 AND agent.deleted_at IS NULL FOR UPDATE OF agent,actor`, current.OrgID, agentID))
	if errors.Is(err, pgx.ErrNoRows) {
		return Agent{}, ErrNotFound
	}
	if err != nil {
		return Agent{}, err
	}
	description, scopes, ok := recipeDefaults(locked.Recipe)
	if !ok {
		return Agent{}, fmt.Errorf("%w: custom agents do not have template defaults", ErrInvalid)
	}
	if len(locked.ChatIDs) == 0 {
		return Agent{}, fmt.Errorf("%w: recipe agents require at least one chat", ErrInvalid)
	}
	if _, err := tx.Exec(ctx, `UPDATE agent_triggers SET enabled=false,superseded_at=now(),updated_at=now() WHERE org_id=$1 AND agent_id=$2 AND superseded_at IS NULL`, current.OrgID, agentID); err != nil {
		return Agent{}, err
	}
	if err := insertRecipeTriggers(ctx, tx, current.OrgID, agentID, locked.Recipe, locked.ChatIDs, service.now().UTC()); err != nil {
		return Agent{}, err
	}
	prospective := inputFromAgent(locked)
	prospective.Description = description
	prospective.AllowedScopes = scopes
	prospective.Enabled = false
	prospective.MaxOutputTokens = intPointer(2048)
	prospective.MaxToolIterations = intPointer(8)
	prospective.MaxChainDepth = intPointer(3)
	prospective.PerChatConcurrency = intPointer(1)
	prospective.RateLimitPerMinute = 60
	prospective.ProviderRateLimitPerMinute = 300
	prospective.ExecutionTimeoutSeconds = 600
	draftVersion := 1
	if locked.PublishedVersion != nil {
		draftVersion = *locked.PublishedVersion + 1
	}
	if locked.DraftVersion != nil {
		draftVersion = *locked.DraftVersion
	}
	if err := saveDraft(ctx, tx, current.OrgID, agentID, current.ActorID, draftVersion, prospective); err != nil {
		return Agent{}, err
	}
	if _, err := tx.Exec(ctx, `UPDATE agents SET enabled=false,operational_status=CASE WHEN published_version IS NULL THEN 'draft' ELSE 'paused' END,recipe_version=recipe_version+1,updated_at=now() WHERE org_id=$1 AND actor_id=$2`, current.OrgID, agentID); err != nil {
		return Agent{}, err
	}
	revokedKeyIDs := make([]string, 0)
	auditID, err := id.New()
	if err != nil {
		return Agent{}, err
	}
	metadata, _ := json.Marshal(map[string]any{"recipe": locked.Recipe, "from_version": locked.RecipeVersion, "to_version": locked.RecipeVersion + 1, "revoked_key_count": len(revokedKeyIDs)})
	if _, err := tx.Exec(ctx, `INSERT INTO audit_log(id,org_id,actor_id,action,target_type,target_id,metadata) VALUES($1,$2,$3,'agent.recipe.reset','agent',$4,$5)`, auditID, current.OrgID, current.ActorID, agentID, metadata); err != nil {
		return Agent{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Agent{}, err
	}
	service.revokeRealtimeKeys(revokedKeyIDs)
	return service.Get(ctx, current, agentID)
}

func (service *Service) List(ctx context.Context, current identity.User) ([]Agent, error) {
	manager := canView(current)
	selectQuery := agentPublishedSelect
	if manager {
		selectQuery = agentSelect
	}
	rows, err := service.pool.Query(ctx, selectQuery+` WHERE agent.org_id=$1 AND agent.deleted_at IS NULL AND agent.system_role IS NULL AND (agent.enabled OR $2) ORDER BY actor.display_name, actor.id`, current.OrgID, manager)
	if err != nil {
		return nil, fmt.Errorf("list agents: %w", err)
	}
	defer rows.Close()
	result := make([]Agent, 0)
	for rows.Next() {
		item, err := scanAgent(rows)
		if err != nil {
			return nil, err
		}
		if !manager {
			item.EndpointURL = ""
			item.ChatIDs = []string{}
			item.Readiness.Blockers = []string{}
		}
		result = append(result, item)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate agents: %w", err)
	}
	return result, nil
}

func (service *Service) Usage(ctx context.Context, current identity.User, agentID string) (UsageReport, error) {
	if !canView(current) {
		return UsageReport{}, ErrForbidden
	}
	if uuid.Validate(agentID) != nil {
		return UsageReport{}, ErrNotFound
	}
	var exists bool
	if err := service.pool.QueryRow(ctx, `SELECT true FROM agents WHERE org_id=$1 AND actor_id=$2 AND deleted_at IS NULL`, current.OrgID, agentID).Scan(&exists); errors.Is(err, pgx.ErrNoRows) {
		return UsageReport{}, ErrNotFound
	} else if err != nil {
		return UsageReport{}, err
	}
	var result UsageReport
	err := service.pool.QueryRow(ctx, `SELECT
		COALESCE(sum(cost) FILTER (WHERE created_at >= date_trunc('day',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'),0)::text,
		COALESCE(sum(cost) FILTER (WHERE created_at >= date_trunc('month',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'),0)::text,
		COALESCE(sum(input_tokens) FILTER (WHERE created_at >= date_trunc('day',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'),0),
		COALESCE(sum(output_tokens) FILTER (WHERE created_at >= date_trunc('day',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'),0),
		count(DISTINCT run_id) FILTER (WHERE created_at >= date_trunc('month',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')
		FROM agent_usage WHERE org_id=$1 AND agent_id=$2`, current.OrgID, agentID).Scan(&result.DailyCost, &result.MonthlyCost, &result.DailyInputTokens, &result.DailyOutputTokens, &result.MonthlyRuns)
	if err != nil {
		return UsageReport{}, err
	}
	result.Currency = "USD"
	rows, err := service.pool.Query(ctx, `SELECT id,run_id,correlation_id,provider,model,input_tokens,output_tokens,cost::text,currency,price_source,created_at
		FROM agent_usage WHERE org_id=$1 AND agent_id=$2 ORDER BY created_at DESC LIMIT 100`, current.OrgID, agentID)
	if err != nil {
		return UsageReport{}, err
	}
	defer rows.Close()
	result.Recent = make([]UsageEntry, 0)
	for rows.Next() {
		var entry UsageEntry
		if err := rows.Scan(&entry.ID, &entry.RunID, &entry.CorrelationID, &entry.Provider, &entry.Model, &entry.InputTokens, &entry.OutputTokens, &entry.Cost, &entry.Currency, &entry.PriceSource, &entry.CreatedAt); err != nil {
			return UsageReport{}, err
		}
		result.Recent = append(result.Recent, entry)
	}
	return result, rows.Err()
}

func (service *Service) Metrics(ctx context.Context, current identity.User) (ProductMetrics, error) {
	if !agentauthz.New().CanObserve(current) {
		return ProductMetrics{}, ErrForbidden
	}
	var result ProductMetrics
	err := service.pool.QueryRow(ctx, `SELECT
		(SELECT count(*) FROM agents WHERE org_id=$1 AND deleted_at IS NULL AND system_role IS NULL),
		(SELECT count(*) FROM agents WHERE org_id=$1 AND deleted_at IS NULL AND system_role IS NULL AND published_version IS NOT NULL),
		(SELECT count(*) FROM agent_runs WHERE org_id=$1 AND dry_run),
		(SELECT count(*) FROM agent_runs WHERE org_id=$1 AND dry_run AND status='failed'),
		COALESCE((SELECT avg(extract(epoch FROM first_test.created_at-actor.created_at))
			FROM agents agent JOIN actors actor ON actor.org_id=agent.org_id AND actor.id=agent.actor_id
			JOIN LATERAL (SELECT min(created_at) created_at FROM agent_runs WHERE org_id=agent.org_id AND agent_id=agent.actor_id AND dry_run) first_test ON first_test.created_at IS NOT NULL
			WHERE agent.org_id=$1 AND agent.system_role IS NULL),0),
		COALESCE((SELECT avg(extract(epoch FROM agent.published_at-actor.created_at))
			FROM agents agent JOIN actors actor ON actor.org_id=agent.org_id AND actor.id=agent.actor_id
			WHERE agent.org_id=$1 AND agent.system_role IS NULL AND agent.published_at IS NOT NULL),0)`, current.OrgID).Scan(
		&result.AgentsTotal, &result.AgentsPublished, &result.TestRunsTotal, &result.TestRunsFailed,
		&result.AverageSecondsToFirstTest, &result.AverageSecondsToFirstPublish,
	)
	return result, err
}

func (service *Service) Get(ctx context.Context, current identity.User, agentID string) (Agent, error) {
	if _, err := uuid.Parse(agentID); err != nil {
		return Agent{}, ErrNotFound
	}
	manager := canView(current)
	selectQuery := agentPublishedSelect
	if manager {
		selectQuery = agentSelect
	}
	result, err := scanAgent(service.pool.QueryRow(ctx, selectQuery+` WHERE agent.org_id=$1 AND agent.actor_id=$2 AND agent.deleted_at IS NULL AND agent.system_role IS NULL AND (agent.enabled OR $3)`, current.OrgID, agentID, manager))
	if errors.Is(err, pgx.ErrNoRows) {
		return Agent{}, ErrNotFound
	}
	if err != nil {
		return Agent{}, fmt.Errorf("get agent: %w", err)
	}
	if !manager {
		result.EndpointURL = ""
		result.ChatIDs = []string{}
		result.Readiness.Blockers = []string{}
	}
	return result, nil
}

func (service *Service) Update(ctx context.Context, current identity.User, agentID string, input UpdateInput) (Agent, error) {
	if !canBuild(current) {
		return Agent{}, ErrForbidden
	}
	if _, err := uuid.Parse(agentID); err != nil {
		return Agent{}, ErrNotFound
	}
	if input.DisplayName == nil && input.Handle == nil && input.Description == nil && input.Enabled == nil && input.AllowedScopes == nil && input.LLMConnectionID == nil && input.Provider == nil && input.Model == nil && input.EndpointURL == nil && input.ExternalDataSharingApproved == nil && input.DailyCostLimit == nil && input.MonthlyCostLimit == nil && input.MaxOutputTokens == nil && input.MaxToolIterations == nil && input.MaxChainDepth == nil && input.PerChatConcurrency == nil && input.RateLimitPerMinute == nil && input.ProviderRateLimitPerMinute == nil && input.ExecutionTimeoutSeconds == nil && input.ChatIDs == nil {
		return Agent{}, fmt.Errorf("%w: update must contain at least one field", ErrInvalid)
	}
	auditID, err := id.New()
	if err != nil {
		return Agent{}, err
	}
	tx, err := service.pool.Begin(ctx)
	if err != nil {
		return Agent{}, fmt.Errorf("begin agent update: %w", err)
	}
	defer tx.Rollback(ctx)
	lockedAgent, err := scanAgent(tx.QueryRow(ctx, agentSelect+` WHERE agent.org_id=$1 AND agent.actor_id=$2 AND agent.deleted_at IS NULL FOR UPDATE OF agent,actor`, current.OrgID, agentID))
	if errors.Is(err, pgx.ErrNoRows) {
		return Agent{}, ErrNotFound
	} else if err != nil {
		return Agent{}, fmt.Errorf("lock agent: %w", err)
	}
	prospective, err := mergeUpdate(lockedAgent, input)
	if err != nil {
		return Agent{}, err
	}
	if prospective.LLMConnectionID != nil {
		provider, endpoint, defaultModel, err := resolveLLMConnection(ctx, tx, current.OrgID, *prospective.LLMConnectionID)
		if err != nil {
			return Agent{}, err
		}
		prospective.Provider = provider
		prospective.EndpointURL = endpoint
		if input.LLMConnectionID != nil && input.Model == nil {
			prospective.Model = defaultModel
		}
		if prospective.Model == "" {
			return Agent{}, fmt.Errorf("%w: the selected LLM connection has no default model", ErrInvalid)
		}
	}
	if input.ChatIDs != nil && len(prospective.ChatIDs) > 0 {
		var count int
		if err := tx.QueryRow(ctx, `SELECT count(*) FROM chats WHERE org_id=$1 AND id=ANY($2::uuid[]) AND archived_at IS NULL`, current.OrgID, prospective.ChatIDs).Scan(&count); err != nil {
			return Agent{}, fmt.Errorf("validate agent chats: %w", err)
		}
		if count != len(prospective.ChatIDs) {
			return Agent{}, fmt.Errorf("%w: every chat must be active and belong to the organization", ErrInvalid)
		}
	}
	if _, err := tx.Exec(ctx, `UPDATE actors SET display_name=$3,handle=$4 WHERE org_id=$1 AND id=$2`, current.OrgID, agentID, prospective.DisplayName, prospective.Handle); err != nil {
		return Agent{}, mapWriteError("update agent actor", err)
	}
	draftVersion := 1
	if lockedAgent.PublishedVersion != nil {
		draftVersion = *lockedAgent.PublishedVersion + 1
	}
	if lockedAgent.DraftVersion != nil {
		draftVersion = *lockedAgent.DraftVersion
	}
	if err := saveDraft(ctx, tx, current.OrgID, agentID, current.ActorID, draftVersion, prospective); err != nil {
		return Agent{}, err
	}
	revokedKeyIDs := make([]string, 0)
	if input.Enabled != nil {
		if *input.Enabled {
			revokedKeyIDs, err = service.publishDraft(ctx, tx, current, agentID, prospective, draftVersion)
			if err != nil {
				return Agent{}, err
			}
		} else if _, err := tx.Exec(ctx, `UPDATE agents SET enabled=false,operational_status=CASE WHEN published_version IS NULL THEN 'draft' ELSE 'paused' END,updated_at=now() WHERE org_id=$1 AND actor_id=$2`, current.OrgID, agentID); err != nil {
			return Agent{}, mapWriteError("pause agent", err)
		}
	}
	metadata, _ := json.Marshal(map[string]any{"draft_version": draftVersion, "published": input.Enabled != nil && *input.Enabled, "scopes": scopeStrings(prospective.AllowedScopes), "chat_ids": prospective.ChatIDs})
	if _, err := tx.Exec(ctx, `INSERT INTO audit_log(id,org_id,actor_id,action,target_type,target_id,metadata) VALUES($1,$2,$3,'agent.update','agent',$4,$5)`, auditID, current.OrgID, current.ActorID, agentID, metadata); err != nil {
		return Agent{}, fmt.Errorf("audit agent update: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return Agent{}, mapWriteError("commit agent update", err)
	}
	service.revokeRealtimeKeys(revokedKeyIDs)
	return service.Get(ctx, current, agentID)
}

func (service *Service) Publish(ctx context.Context, current identity.User, agentID string) (Agent, error) {
	if !canPublish(current) {
		return Agent{}, ErrForbidden
	}
	if uuid.Validate(agentID) != nil {
		return Agent{}, ErrNotFound
	}
	tx, err := service.pool.Begin(ctx)
	if err != nil {
		return Agent{}, err
	}
	defer tx.Rollback(ctx)
	locked, err := scanAgent(tx.QueryRow(ctx, agentSelect+` WHERE agent.org_id=$1 AND agent.actor_id=$2 AND agent.deleted_at IS NULL FOR UPDATE OF agent,actor`, current.OrgID, agentID))
	if errors.Is(err, pgx.ErrNoRows) {
		return Agent{}, ErrNotFound
	}
	if err != nil {
		return Agent{}, err
	}
	if !locked.HasUnpublishedChanges || locked.DraftVersion == nil {
		return Agent{}, fmt.Errorf("%w: the agent has no draft to publish", ErrConflict)
	}
	prospective, err := normalizeCreate(inputFromAgent(locked))
	if err != nil {
		return Agent{}, err
	}
	revokedKeyIDs, err := service.publishDraft(ctx, tx, current, agentID, prospective, *locked.DraftVersion)
	if err != nil {
		return Agent{}, err
	}
	auditID, err := id.New()
	if err != nil {
		return Agent{}, err
	}
	metadata, _ := json.Marshal(map[string]any{"version": *locked.DraftVersion, "previous_version": locked.PublishedVersion})
	if _, err := tx.Exec(ctx, `INSERT INTO audit_log(id,org_id,actor_id,action,target_type,target_id,metadata) VALUES($1,$2,$3,'agent.publish','agent',$4,$5)`, auditID, current.OrgID, current.ActorID, agentID, metadata); err != nil {
		return Agent{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Agent{}, err
	}
	service.revokeRealtimeKeys(revokedKeyIDs)
	return service.Get(ctx, current, agentID)
}

func (service *Service) Pause(ctx context.Context, current identity.User, agentID string) (Agent, error) {
	return service.setOperationalStatus(ctx, current, agentID, false)
}

func (service *Service) Resume(ctx context.Context, current identity.User, agentID string) (Agent, error) {
	return service.setOperationalStatus(ctx, current, agentID, true)
}

func (service *Service) setOperationalStatus(ctx context.Context, current identity.User, agentID string, enabled bool) (Agent, error) {
	if !canPublish(current) {
		return Agent{}, ErrForbidden
	}
	if uuid.Validate(agentID) != nil {
		return Agent{}, ErrNotFound
	}
	tx, err := service.pool.Begin(ctx)
	if err != nil {
		return Agent{}, err
	}
	defer tx.Rollback(ctx)
	var publishedVersion *int
	if err := tx.QueryRow(ctx, `SELECT published_version FROM agents WHERE org_id=$1 AND actor_id=$2 AND deleted_at IS NULL FOR UPDATE`, current.OrgID, agentID).Scan(&publishedVersion); errors.Is(err, pgx.ErrNoRows) {
		return Agent{}, ErrNotFound
	} else if err != nil {
		return Agent{}, err
	}
	if publishedVersion == nil {
		return Agent{}, fmt.Errorf("%w: publish the agent before changing its operational state", ErrConflict)
	}
	status := "paused"
	action := "agent.pause"
	if enabled {
		status = "active"
		action = "agent.resume"
		var ready bool
		if err := tx.QueryRow(ctx, `SELECT
			cardinality(agent.allowed_scopes)>=0
			AND EXISTS(SELECT 1 FROM chat_members member WHERE member.org_id=agent.org_id AND member.actor_id=agent.actor_id)
			AND (agent.kind<>'external' OR EXISTS(SELECT 1 FROM agent_api_keys key WHERE key.org_id=agent.org_id AND key.agent_id=agent.actor_id AND key.revoked_at IS NULL AND (key.expires_at IS NULL OR key.expires_at>now())))
			AND (agent.kind<>'builtin' OR (agent.model<>'' AND agent.external_data_sharing_approved AND (EXISTS(SELECT 1 FROM agent_llm_connections connection WHERE connection.org_id=agent.org_id AND connection.id=agent.llm_connection_id AND connection.enabled) OR (agent.llm_connection_id IS NULL AND EXISTS(SELECT 1 FROM agent_provider_credentials credential WHERE credential.org_id=agent.org_id AND credential.agent_id=agent.actor_id)))))
			FROM agents agent WHERE agent.org_id=$1 AND agent.actor_id=$2`, current.OrgID, agentID).Scan(&ready); err != nil {
			return Agent{}, err
		}
		if !ready {
			return Agent{}, ErrNotReady
		}
	}
	if _, err := tx.Exec(ctx, `UPDATE agents SET enabled=$3,operational_status=$4,updated_at=now() WHERE org_id=$1 AND actor_id=$2`, current.OrgID, agentID, enabled, status); err != nil {
		return Agent{}, err
	}
	auditID, err := id.New()
	if err != nil {
		return Agent{}, err
	}
	if _, err := tx.Exec(ctx, `INSERT INTO audit_log(id,org_id,actor_id,action,target_type,target_id,metadata) VALUES($1,$2,$3,$4,'agent',$5,'{}')`, auditID, current.OrgID, current.ActorID, action, agentID); err != nil {
		return Agent{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Agent{}, err
	}
	return service.Get(ctx, current, agentID)
}

func (service *Service) Versions(ctx context.Context, current identity.User, agentID string) ([]Version, error) {
	if !canView(current) {
		return nil, ErrForbidden
	}
	if uuid.Validate(agentID) != nil {
		return nil, ErrNotFound
	}
	rows, err := service.pool.Query(ctx, `SELECT version.id,version.agent_id,version.version,version.created_by,version.created_at,version.published_at
		FROM agent_versions version JOIN agents agent ON agent.org_id=version.org_id AND agent.actor_id=version.agent_id
		WHERE version.org_id=$1 AND version.agent_id=$2 AND agent.deleted_at IS NULL ORDER BY version.version DESC`, current.OrgID, agentID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := make([]Version, 0)
	for rows.Next() {
		var item Version
		if err := rows.Scan(&item.ID, &item.AgentID, &item.Version, &item.CreatedBy, &item.CreatedAt, &item.PublishedAt); err != nil {
			return nil, err
		}
		result = append(result, item)
	}
	return result, rows.Err()
}

func (service *Service) Rollback(ctx context.Context, current identity.User, agentID, versionID string) (Agent, error) {
	if !canPublish(current) {
		return Agent{}, ErrForbidden
	}
	if uuid.Validate(agentID) != nil || uuid.Validate(versionID) != nil {
		return Agent{}, ErrNotFound
	}
	tx, err := service.pool.Begin(ctx)
	if err != nil {
		return Agent{}, err
	}
	defer tx.Rollback(ctx)
	locked, err := scanAgent(tx.QueryRow(ctx, agentSelect+` WHERE agent.org_id=$1 AND agent.actor_id=$2 AND agent.deleted_at IS NULL FOR UPDATE OF agent,actor`, current.OrgID, agentID))
	if errors.Is(err, pgx.ErrNoRows) {
		return Agent{}, ErrNotFound
	}
	if err != nil {
		return Agent{}, err
	}
	var raw []byte
	var sourceVersion int
	if err := tx.QueryRow(ctx, `SELECT config,version FROM agent_versions WHERE org_id=$1 AND agent_id=$2 AND id=$3`, current.OrgID, agentID, versionID).Scan(&raw, &sourceVersion); errors.Is(err, pgx.ErrNoRows) {
		return Agent{}, ErrNotFound
	} else if err != nil {
		return Agent{}, err
	}
	prospective := inputFromAgent(locked)
	if err := json.Unmarshal(raw, &prospective); err != nil {
		return Agent{}, fmt.Errorf("decode agent version: %w", err)
	}
	prospective.DisplayName = locked.DisplayName
	prospective.Handle = locked.Handle
	prospective.Kind = locked.Kind
	prospective.Enabled = locked.Enabled
	prospective, err = normalizeCreate(prospective)
	if err != nil {
		return Agent{}, err
	}
	nextVersion := 1
	if locked.PublishedVersion != nil {
		nextVersion = *locked.PublishedVersion + 1
	}
	if err := saveDraft(ctx, tx, current.OrgID, agentID, current.ActorID, nextVersion, prospective); err != nil {
		return Agent{}, err
	}
	auditID, err := id.New()
	if err != nil {
		return Agent{}, err
	}
	metadata, _ := json.Marshal(map[string]any{"source_version": sourceVersion, "draft_version": nextVersion})
	if _, err := tx.Exec(ctx, `INSERT INTO audit_log(id,org_id,actor_id,action,target_type,target_id,metadata) VALUES($1,$2,$3,'agent.rollback.prepare','agent',$4,$5)`, auditID, current.OrgID, current.ActorID, agentID, metadata); err != nil {
		return Agent{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Agent{}, err
	}
	return service.Get(ctx, current, agentID)
}

func (service *Service) Delete(ctx context.Context, current identity.User, agentID string) error {
	if !canBuild(current) {
		return ErrForbidden
	}
	if _, err := uuid.Parse(agentID); err != nil {
		return ErrNotFound
	}
	auditID, err := id.New()
	if err != nil {
		return err
	}
	tx, err := service.pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("begin agent deletion: %w", err)
	}
	defer tx.Rollback(ctx)
	var deletedAt *time.Time
	err = tx.QueryRow(ctx, `SELECT deleted_at FROM agents WHERE org_id=$1 AND actor_id=$2 FOR UPDATE`, current.OrgID, agentID).Scan(&deletedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrNotFound
	}
	if err != nil {
		return fmt.Errorf("lock agent for deletion: %w", err)
	}
	if deletedAt != nil {
		return nil
	}
	revokedKeyIDs := make([]string, 0)
	rows, err := tx.Query(ctx, `UPDATE agent_api_keys SET revoked_at=now()
		WHERE org_id=$1 AND agent_id=$2 AND revoked_at IS NULL RETURNING id`, current.OrgID, agentID)
	if err != nil {
		return fmt.Errorf("revoke deleted agent keys: %w", err)
	}
	for rows.Next() {
		var keyID string
		if err := rows.Scan(&keyID); err != nil {
			rows.Close()
			return err
		}
		revokedKeyIDs = append(revokedKeyIDs, keyID)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return err
	}
	rows.Close()
	statements := []struct {
		operation string
		query     string
	}{
		{"disable deleted agent triggers", `UPDATE agent_triggers SET enabled=false,updated_at=now() WHERE org_id=$1 AND agent_id=$2 AND enabled`},
		{"cancel queued deleted agent runs", `UPDATE agent_runs SET status='canceled',error_code='agent_deleted',cancel_requested_at=now(),finished_at=now() WHERE org_id=$1 AND agent_id=$2 AND status='queued'`},
		{"request cancellation for running deleted agent runs", `UPDATE agent_runs SET cancel_requested_at=COALESCE(cancel_requested_at,now()),error_code='agent_deleted' WHERE org_id=$1 AND agent_id=$2 AND status='running'`},
		{"deny pending deleted agent confirmations", `UPDATE agent_tool_confirmations SET status='denied',error_code='agent_deleted',completed_at=now() WHERE org_id=$1 AND agent_id=$2 AND status='pending'`},
		{"remove deleted agent memberships", `DELETE FROM chat_members WHERE org_id=$1 AND actor_id=$2`},
		{"remove deleted agent provider credential", `DELETE FROM agent_provider_credentials WHERE org_id=$1 AND agent_id=$2`},
		{"remove deleted agent MCP servers", `DELETE FROM agent_mcp_servers WHERE org_id=$1 AND agent_id=$2`},
		{"remove deleted agent memory", `DELETE FROM agent_memory WHERE org_id=$1 AND agent_id=$2`},
		{"remove deleted agent runtime checkpoints", `DELETE FROM agent_runtime_checkpoints WHERE org_id=$1 AND agent_id=$2`},
	}
	for _, statement := range statements {
		if _, err := tx.Exec(ctx, statement.query, current.OrgID, agentID); err != nil {
			return fmt.Errorf("%s: %w", statement.operation, err)
		}
	}
	if _, err := tx.Exec(ctx, `UPDATE agents SET enabled=false,deleted_at=now(),updated_at=now() WHERE org_id=$1 AND actor_id=$2`, current.OrgID, agentID); err != nil {
		return mapWriteError("tombstone agent", err)
	}
	if _, err := tx.Exec(ctx, `UPDATE actors SET status='deactivated',deleted_at=now() WHERE org_id=$1 AND id=$2 AND type='agent'`, current.OrgID, agentID); err != nil {
		return mapWriteError("deactivate agent actor", err)
	}
	metadata, _ := json.Marshal(map[string]any{"revoked_key_count": len(revokedKeyIDs), "historical_records_retained": true})
	if _, err := tx.Exec(ctx, `INSERT INTO audit_log(id,org_id,actor_id,action,target_type,target_id,metadata)
		VALUES($1,$2,$3,'agent.delete','agent',$4,$5)`, auditID, current.OrgID, current.ActorID, agentID, metadata); err != nil {
		return fmt.Errorf("audit agent deletion: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return mapWriteError("commit agent deletion", err)
	}
	service.revokeRealtimeKeys(revokedKeyIDs)
	return nil
}

func (service *Service) CreateKey(ctx context.Context, current identity.User, agentID string, input CreateKeyInput) (CreatedAPIKey, error) {
	if !canBuild(current) {
		return CreatedAPIKey{}, ErrForbidden
	}
	if _, err := uuid.Parse(agentID); err != nil {
		return CreatedAPIKey{}, ErrNotFound
	}
	name := strings.TrimSpace(input.Name)
	scopes, err := normalizeScopes(input.Scopes)
	if err != nil || name == "" || len([]rune(name)) > 120 || input.RateLimitPerMinute < 1 || input.RateLimitPerMinute > 100000 {
		return CreatedAPIKey{}, fmt.Errorf("%w: invalid key name, scopes, or rate limit", ErrInvalid)
	}
	now := service.now().UTC()
	if input.ExpiresAt != nil && !input.ExpiresAt.After(now) {
		return CreatedAPIKey{}, fmt.Errorf("%w: key expiry must be in the future", ErrInvalid)
	}
	keyID, err := id.New()
	if err != nil {
		return CreatedAPIKey{}, err
	}
	auditID, err := id.New()
	if err != nil {
		return CreatedAPIKey{}, err
	}
	random := make([]byte, 32)
	if _, err := rand.Read(random); err != nil {
		return CreatedAPIKey{}, fmt.Errorf("generate agent key: %w", err)
	}
	secret := "coma_agent_" + base64.RawURLEncoding.EncodeToString(random)
	digest := sha256.Sum256([]byte(secret))
	prefix := secret[:20]
	tx, err := service.pool.Begin(ctx)
	if err != nil {
		return CreatedAPIKey{}, fmt.Errorf("begin agent key creation: %w", err)
	}
	defer tx.Rollback(ctx)
	var allowed []string
	if err := tx.QueryRow(ctx, `SELECT allowed_scopes FROM agents WHERE org_id=$1 AND actor_id=$2 FOR UPDATE`, current.OrgID, agentID).Scan(&allowed); errors.Is(err, pgx.ErrNoRows) {
		return CreatedAPIKey{}, ErrNotFound
	} else if err != nil {
		return CreatedAPIKey{}, fmt.Errorf("load agent scopes: %w", err)
	}
	if !scopeSubset(scopes, allowed) {
		return CreatedAPIKey{}, fmt.Errorf("%w: key scopes exceed the agent allowlist", ErrInvalid)
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO agent_api_keys(id,org_id,agent_id,name,key_hash,key_prefix,scopes,rate_limit_per_minute,created_by,expires_at)
		VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, keyID, current.OrgID, agentID, name, digest[:], prefix, scopeStrings(scopes), input.RateLimitPerMinute, current.ActorID, input.ExpiresAt); err != nil {
		return CreatedAPIKey{}, mapWriteError("insert agent key", err)
	}
	metadata, _ := json.Marshal(map[string]any{"key_id": keyID, "name": name, "scopes": scopeStrings(scopes)})
	if _, err := tx.Exec(ctx, `INSERT INTO audit_log(id,org_id,actor_id,action,target_type,target_id,metadata) VALUES($1,$2,$3,'agent.key.create','agent',$4,$5)`, auditID, current.OrgID, current.ActorID, agentID, metadata); err != nil {
		return CreatedAPIKey{}, fmt.Errorf("audit agent key creation: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return CreatedAPIKey{}, mapWriteError("commit agent key creation", err)
	}
	return CreatedAPIKey{APIKey: APIKey{ID: keyID, AgentID: agentID, Name: name, Prefix: prefix, Scopes: scopes, RateLimitPerMinute: input.RateLimitPerMinute, CreatedAt: now, ExpiresAt: input.ExpiresAt}, Secret: secret}, nil
}

func (service *Service) RevokeKey(ctx context.Context, current identity.User, agentID, keyID string) error {
	if !canBuild(current) {
		return ErrForbidden
	}
	if _, err := uuid.Parse(agentID); err != nil {
		return ErrNotFound
	}
	if _, err := uuid.Parse(keyID); err != nil {
		return ErrNotFound
	}
	auditID, err := id.New()
	if err != nil {
		return err
	}
	tx, err := service.pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("begin agent key revocation: %w", err)
	}
	defer tx.Rollback(ctx)
	result, err := tx.Exec(ctx, `UPDATE agent_api_keys SET revoked_at=now() WHERE org_id=$1 AND agent_id=$2 AND id=$3 AND revoked_at IS NULL`, current.OrgID, agentID, keyID)
	if err != nil {
		return fmt.Errorf("revoke agent key: %w", err)
	}
	if result.RowsAffected() != 1 {
		return ErrNotFound
	}
	metadata, _ := json.Marshal(map[string]string{"key_id": keyID})
	if _, err := tx.Exec(ctx, `INSERT INTO audit_log(id,org_id,actor_id,action,target_type,target_id,metadata) VALUES($1,$2,$3,'agent.key.revoke','agent',$4,$5)`, auditID, current.OrgID, current.ActorID, agentID, metadata); err != nil {
		return fmt.Errorf("audit agent key revocation: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("commit agent key revocation: %w", err)
	}
	service.revokeRealtimeKeys([]string{keyID})
	return nil
}

func (service *Service) ListKeys(ctx context.Context, current identity.User, agentID string) ([]APIKey, error) {
	if !canBuild(current) {
		return nil, ErrForbidden
	}
	if _, err := uuid.Parse(agentID); err != nil {
		return nil, ErrNotFound
	}
	rows, err := service.pool.Query(ctx, `SELECT key.id,key.agent_id,key.name,key.key_prefix,key.scopes,key.rate_limit_per_minute,key.created_at,key.last_used_at,key.expires_at,key.revoked_at FROM agent_api_keys key JOIN agents agent ON agent.org_id=key.org_id AND agent.actor_id=key.agent_id WHERE key.org_id=$1 AND key.agent_id=$2 ORDER BY key.created_at DESC,key.id`, current.OrgID, agentID)
	if err != nil {
		return nil, fmt.Errorf("list agent keys: %w", err)
	}
	defer rows.Close()
	result := make([]APIKey, 0)
	for rows.Next() {
		var key APIKey
		var scopes []string
		if err := rows.Scan(&key.ID, &key.AgentID, &key.Name, &key.Prefix, &scopes, &key.RateLimitPerMinute, &key.CreatedAt, &key.LastUsedAt, &key.ExpiresAt, &key.RevokedAt); err != nil {
			return nil, fmt.Errorf("scan agent key: %w", err)
		}
		key.Scopes = make([]Scope, len(scopes))
		for i, scope := range scopes {
			key.Scopes[i] = Scope(scope)
		}
		result = append(result, key)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate agent keys: %w", err)
	}
	if len(result) == 0 {
		var exists bool
		if err := service.pool.QueryRow(ctx, `SELECT true FROM agents WHERE org_id=$1 AND actor_id=$2`, current.OrgID, agentID).Scan(&exists); errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrNotFound
		} else if err != nil {
			return nil, fmt.Errorf("find agent: %w", err)
		}
	}
	return result, nil
}

func (service *Service) AuthenticateKey(ctx context.Context, secret string) (identity.User, access.Identity, error) {
	if !strings.HasPrefix(secret, "coma_agent_") || len(secret) > 256 {
		return identity.User{}, access.Identity{}, identity.ErrUnauthorized
	}
	digest := sha256.Sum256([]byte(secret))
	var user identity.User
	var keyID string
	var scopes []string
	var expiresAt *time.Time
	var keyRateLimit, agentRateLimit, organizationRateLimit int
	err := service.pool.QueryRow(ctx, `
		SELECT actor.id,actor.org_id,organization.name,actor.display_name,actor.handle,actor.status,actor.created_at,actor.avatar_version,
		       key.id,key.scopes,key.expires_at,key.rate_limit_per_minute,agent.rate_limit_per_minute,organization.agent_rate_limit_per_minute
		FROM agent_api_keys key
		JOIN agents agent ON agent.org_id=key.org_id AND agent.actor_id=key.agent_id
		JOIN actors actor ON actor.org_id=agent.org_id AND actor.id=agent.actor_id
		JOIN organizations organization ON organization.id=agent.org_id
		WHERE key.key_hash=$1 AND key.revoked_at IS NULL AND (key.expires_at IS NULL OR key.expires_at>now())
		  AND agent.enabled AND agent.deleted_at IS NULL AND key.scopes <@ agent.allowed_scopes AND actor.status='active' AND actor.deleted_at IS NULL`, digest[:]).Scan(
		&user.ActorID, &user.OrgID, &user.OrganizationName, &user.DisplayName, &user.Handle, &user.Status, &user.CreatedAt, &user.AvatarVersion, &keyID, &scopes, &expiresAt, &keyRateLimit, &agentRateLimit, &organizationRateLimit)
	if err != nil {
		return identity.User{}, access.Identity{}, identity.ErrUnauthorized
	}
	if err := service.acquireBaseRateLimits(ctx, user.OrgID, user.ActorID, keyID, organizationRateLimit, agentRateLimit, keyRateLimit); err != nil {
		return identity.User{}, access.Identity{}, err
	}
	user.OrgRole = "member"
	authExpiry := service.now().UTC().Add(24 * time.Hour)
	if expiresAt != nil && expiresAt.Before(authExpiry) {
		authExpiry = expiresAt.UTC()
	}
	_, _ = service.pool.Exec(ctx, `UPDATE agent_api_keys SET last_used_at=now() WHERE id=$1 AND (last_used_at IS NULL OR last_used_at<now()-interval '1 minute')`, keyID)
	return user, access.Identity{ActorID: user.ActorID, OrgID: user.OrgID, SessionID: keyID, Role: "member", ExpiresAt: authExpiry, AuthenticationKind: "api_key", KeyID: keyID, Scopes: scopes}, nil
}

const agentSelect = `
	SELECT agent.actor_id,agent.org_id,agent.owner_actor_id,actor.display_name,actor.handle,
	       agent.kind,COALESCE(draft.recipe,agent.recipe),agent.recipe_version,COALESCE(draft.description,agent.description),agent.enabled,
	       COALESCE(draft.allowed_scopes,agent.allowed_scopes),
	       CASE WHEN draft.agent_id IS NOT NULL THEN draft.llm_connection_id ELSE agent.llm_connection_id END,
	       COALESCE(connection.provider,CASE WHEN draft.agent_id IS NOT NULL THEN draft.provider ELSE agent.provider END),
	       COALESCE(NULLIF(CASE WHEN draft.agent_id IS NOT NULL THEN draft.model ELSE agent.model END,''),connection.default_model,''),
	       COALESCE(connection.endpoint_url,CASE WHEN draft.agent_id IS NOT NULL THEN draft.endpoint_url ELSE agent.endpoint_url END),
	       COALESCE(draft.external_data_sharing_approved,agent.external_data_sharing_approved),
	       (CASE WHEN draft.agent_id IS NOT NULL THEN draft.daily_cost_limit ELSE agent.daily_cost_limit END)::text,
	       (CASE WHEN draft.agent_id IS NOT NULL THEN draft.monthly_cost_limit ELSE agent.monthly_cost_limit END)::text,
	       COALESCE(draft.max_output_tokens,agent.max_output_tokens),COALESCE(draft.max_tool_iterations,agent.max_tool_iterations),
	       COALESCE(draft.max_chain_depth,agent.max_chain_depth),COALESCE(draft.per_chat_concurrency,agent.per_chat_concurrency),
	       COALESCE(draft.rate_limit_per_minute,agent.rate_limit_per_minute),
	       COALESCE(draft.provider_rate_limit_per_minute,agent.provider_rate_limit_per_minute),
	       COALESCE(draft.execution_timeout_seconds,agent.execution_timeout_seconds),
	       COALESCE(draft.chat_ids,(SELECT array_agg(member.chat_id ORDER BY member.chat_id) FROM chat_members member WHERE member.org_id=agent.org_id AND member.actor_id=agent.actor_id),'{}'::uuid[]),
	       (CASE WHEN draft.agent_id IS NOT NULL THEN draft.llm_connection_id ELSE agent.llm_connection_id END) IS NOT NULL,
	       connection.id IS NOT NULL AND connection.enabled,
	       EXISTS(SELECT 1 FROM agent_provider_credentials credential WHERE credential.org_id=agent.org_id AND credential.agent_id=agent.actor_id),
	       EXISTS(SELECT 1 FROM agent_api_keys key WHERE key.org_id=agent.org_id AND key.agent_id=agent.actor_id AND key.revoked_at IS NULL AND (key.expires_at IS NULL OR key.expires_at>now())),
	       EXISTS(SELECT 1 FROM agent_triggers trigger WHERE trigger.org_id=agent.org_id AND trigger.agent_id=agent.actor_id AND trigger.enabled),
	       agent.operational_status,draft.version,agent.published_version,draft.agent_id IS NOT NULL,agent.published_at,
	       actor.avatar_version,agent.created_at,agent.updated_at
	FROM agents agent
	JOIN actors actor ON actor.org_id=agent.org_id AND actor.id=agent.actor_id
	LEFT JOIN agent_drafts draft ON draft.org_id=agent.org_id AND draft.agent_id=agent.actor_id
	LEFT JOIN agent_llm_connections connection ON connection.org_id=agent.org_id AND connection.id=CASE WHEN draft.agent_id IS NOT NULL THEN draft.llm_connection_id ELSE agent.llm_connection_id END`

var agentPublishedSelect = strings.Replace(agentSelect,
	"LEFT JOIN agent_drafts draft ON draft.org_id=agent.org_id AND draft.agent_id=agent.actor_id",
	"LEFT JOIN agent_drafts draft ON draft.org_id=agent.org_id AND draft.agent_id=agent.actor_id AND false", 1)

type scanner interface{ Scan(...any) error }

func scanAgent(row scanner) (Agent, error) {
	var result Agent
	var scopes []string
	var hasConnection, connectionAvailable, hasLegacyCredential, hasActiveKey, hasTrigger bool
	if err := row.Scan(&result.ID, &result.OrgID, &result.OwnerActorID, &result.DisplayName, &result.Handle,
		&result.Kind, &result.Recipe, &result.RecipeVersion, &result.Description, &result.Enabled, &scopes, &result.LLMConnectionID, &result.Provider, &result.Model,
		&result.EndpointURL, &result.ExternalDataSharingApproved, &result.DailyCostLimit, &result.MonthlyCostLimit, &result.MaxOutputTokens,
		&result.MaxToolIterations, &result.MaxChainDepth, &result.PerChatConcurrency,
		&result.RateLimitPerMinute, &result.ProviderRateLimitPerMinute, &result.ExecutionTimeoutSeconds, &result.ChatIDs,
		&hasConnection, &connectionAvailable, &hasLegacyCredential, &hasActiveKey, &hasTrigger,
		&result.OperationalStatus, &result.DraftVersion, &result.PublishedVersion, &result.HasUnpublishedChanges, &result.PublishedAt,
		&result.AvatarVersion, &result.CreatedAt, &result.UpdatedAt); err != nil {
		return Agent{}, err
	}
	result.AllowedScopes = make([]Scope, len(scopes))
	for index, value := range scopes {
		result.AllowedScopes[index] = Scope(value)
	}
	result.Readiness = readinessFor(result, hasConnection, connectionAvailable, hasLegacyCredential, hasActiveKey, hasTrigger)
	return result, nil
}

func readinessFor(value Agent, hasConnection, connectionAvailable, hasLegacyCredential, hasActiveKey, hasTrigger bool) Readiness {
	blockers := make([]string, 0, 6)
	if len(value.ChatIDs) == 0 {
		blockers = append(blockers, "chat_required")
	}
	if value.Kind == "external" && !hasActiveKey {
		blockers = append(blockers, "runtime_key_required")
	}
	if value.Kind == "builtin" {
		if value.Provider == "" || value.Model == "" {
			blockers = append(blockers, "provider_model_required")
		}
		if hasConnection && !connectionAvailable {
			blockers = append(blockers, "llm_connection_unavailable")
		} else if !hasConnection && !hasLegacyCredential {
			blockers = append(blockers, "llm_connection_required")
		}
		if !value.ExternalDataSharingApproved {
			blockers = append(blockers, "external_data_approval_required")
		}
	}
	if value.Recipe != "custom" && !hasTrigger {
		blockers = append(blockers, "trigger_required")
	}
	ready := len(blockers) == 0
	state := "needs_setup"
	if ready {
		state = "ready"
	}
	if value.HasUnpublishedChanges {
		return Readiness{State: state, Ready: ready, Blockers: blockers}
	}
	if value.OperationalStatus == "active" && ready {
		state = "active"
	} else if value.OperationalStatus == "paused" && ready {
		state = "paused"
	} else if value.Enabled {
		state = "error"
	}
	return Readiness{State: state, Ready: ready, Blockers: blockers}
}

func normalizeCreate(input CreateInput) (CreateInput, error) {
	input.DisplayName = strings.TrimSpace(input.DisplayName)
	input.Handle = strings.ToLower(strings.TrimSpace(input.Handle))
	input.Kind = strings.TrimSpace(input.Kind)
	input.Recipe = strings.ToLower(strings.TrimSpace(input.Recipe))
	if input.Recipe == "" {
		input.Recipe = "custom"
	}
	input.Description = strings.TrimSpace(input.Description)
	input.Provider = strings.TrimSpace(input.Provider)
	input.Model = strings.TrimSpace(input.Model)
	input.EndpointURL = strings.TrimSpace(input.EndpointURL)
	if input.LLMConnectionID != nil {
		connectionID := strings.TrimSpace(*input.LLMConnectionID)
		input.LLMConnectionID = &connectionID
		if uuid.Validate(connectionID) != nil {
			return CreateInput{}, fmt.Errorf("%w: invalid LLM connection", ErrInvalid)
		}
	}
	if input.RateLimitPerMinute == 0 {
		input.RateLimitPerMinute = 60
	}
	if input.ProviderRateLimitPerMinute == 0 {
		input.ProviderRateLimitPerMinute = 300
	}
	if input.ExecutionTimeoutSeconds == 0 {
		input.ExecutionTimeoutSeconds = 600
	}
	if input.MaxOutputTokens == nil {
		input.MaxOutputTokens = intPointer(2048)
	}
	if input.MaxToolIterations == nil {
		input.MaxToolIterations = intPointer(8)
	}
	if input.MaxChainDepth == nil {
		input.MaxChainDepth = intPointer(3)
	}
	if input.PerChatConcurrency == nil {
		input.PerChatConcurrency = intPointer(1)
	}
	for _, limit := range []*string{input.DailyCostLimit, input.MonthlyCostLimit} {
		if limit == nil {
			continue
		}
		*limit = strings.TrimSpace(*limit)
		if *limit != "" && (len(*limit) > 29 || !costLimitPattern.MatchString(*limit)) {
			return CreateInput{}, fmt.Errorf("%w: invalid agent cost limit", ErrInvalid)
		}
	}
	if len([]rune(input.DisplayName)) < 1 || len([]rune(input.DisplayName)) > 120 || !handlePattern.MatchString(input.Handle) ||
		(input.Kind != "builtin" && input.Kind != "external") || len([]rune(input.Description)) > 2000 || len(input.Provider) > 100 || len(input.Model) > 200 ||
		input.RateLimitPerMinute < 1 || input.RateLimitPerMinute > 100000 || input.ProviderRateLimitPerMinute < 1 || input.ProviderRateLimitPerMinute > 100000 ||
		input.ExecutionTimeoutSeconds < 30 || input.ExecutionTimeoutSeconds > 3600 ||
		*input.MaxOutputTokens < 1 || *input.MaxOutputTokens > 1000000 || *input.MaxToolIterations < 0 || *input.MaxToolIterations > 64 ||
		*input.MaxChainDepth < 0 || *input.MaxChainDepth > 16 || *input.PerChatConcurrency < 1 || *input.PerChatConcurrency > 32 {
		return CreateInput{}, fmt.Errorf("%w: invalid agent profile", ErrInvalid)
	}
	if input.Kind == "builtin" {
		if input.LLMConnectionID == nil {
			switch input.Provider {
			case "openai", "anthropic":
				if input.EndpointURL != "" {
					return CreateInput{}, fmt.Errorf("%w: the selected provider uses its canonical endpoint", ErrInvalid)
				}
			case "openai-compatible":
				parsed, err := url.Parse(input.EndpointURL)
				if err != nil || parsed.Host == "" || (parsed.Scheme != "https" && parsed.Scheme != "http") || parsed.User != nil {
					return CreateInput{}, fmt.Errorf("%w: OpenAI-compatible provider requires an HTTP(S) endpoint without credentials", ErrInvalid)
				}
			default:
				return CreateInput{}, fmt.Errorf("%w: unsupported builtin provider", ErrInvalid)
			}
		}
	}
	if input.Recipe != "custom" && input.Recipe != "summarizer" && input.Recipe != "qa" && input.Recipe != "onboarding" {
		return CreateInput{}, fmt.Errorf("%w: unsupported agent recipe", ErrInvalid)
	}
	if input.Recipe != "custom" && input.Kind != "builtin" {
		return CreateInput{}, fmt.Errorf("%w: recipes require a builtin agent", ErrInvalid)
	}
	if input.Kind == "external" {
		if input.LLMConnectionID != nil {
			return CreateInput{}, fmt.Errorf("%w: external agents cannot use an LLM connection", ErrInvalid)
		}
		parsed, err := url.Parse(input.EndpointURL)
		if err != nil || (parsed.Scheme != "https" && parsed.Scheme != "http") || parsed.Host == "" || parsed.User != nil {
			return CreateInput{}, fmt.Errorf("%w: external endpoint must be an HTTP(S) URL without credentials", ErrInvalid)
		}
	}
	scopes, err := normalizeScopes(input.AllowedScopes)
	if err != nil {
		return CreateInput{}, err
	}
	input.AllowedScopes = scopes
	chatIDs, err := normalizeUUIDs(input.ChatIDs, 100)
	if err != nil {
		return CreateInput{}, err
	}
	input.ChatIDs = chatIDs
	if input.Recipe != "custom" && len(input.ChatIDs) == 0 {
		return CreateInput{}, fmt.Errorf("%w: recipe agents require at least one chat", ErrInvalid)
	}
	return input, nil
}

func mergeUpdate(existing Agent, input UpdateInput) (CreateInput, error) {
	prospective := CreateInput{
		DisplayName: existing.DisplayName, Handle: existing.Handle, Kind: existing.Kind, Recipe: existing.Recipe,
		Description: existing.Description, Enabled: existing.Enabled, AllowedScopes: existing.AllowedScopes,
		LLMConnectionID: existing.LLMConnectionID, Provider: existing.Provider, Model: existing.Model, EndpointURL: existing.EndpointURL,
		ExternalDataSharingApproved: existing.ExternalDataSharingApproved, RateLimitPerMinute: existing.RateLimitPerMinute,
		DailyCostLimit: existing.DailyCostLimit, MonthlyCostLimit: existing.MonthlyCostLimit,
		ProviderRateLimitPerMinute: existing.ProviderRateLimitPerMinute, ExecutionTimeoutSeconds: existing.ExecutionTimeoutSeconds, ChatIDs: existing.ChatIDs,
		MaxOutputTokens: intPointer(existing.MaxOutputTokens), MaxToolIterations: intPointer(existing.MaxToolIterations),
		MaxChainDepth: intPointer(existing.MaxChainDepth), PerChatConcurrency: intPointer(existing.PerChatConcurrency),
	}
	if input.DisplayName != nil {
		prospective.DisplayName = *input.DisplayName
	}
	if input.Handle != nil {
		prospective.Handle = *input.Handle
	}
	if input.Description != nil {
		prospective.Description = *input.Description
	}
	if input.Enabled != nil {
		prospective.Enabled = *input.Enabled
	}
	if input.AllowedScopes != nil {
		prospective.AllowedScopes = *input.AllowedScopes
	}
	if input.LLMConnectionID != nil {
		prospective.LLMConnectionID = input.LLMConnectionID
	}
	if input.Provider != nil {
		prospective.Provider = *input.Provider
	}
	if input.Model != nil {
		prospective.Model = *input.Model
	}
	if input.EndpointURL != nil {
		prospective.EndpointURL = *input.EndpointURL
	}
	if input.ExternalDataSharingApproved != nil {
		prospective.ExternalDataSharingApproved = *input.ExternalDataSharingApproved
	}
	if input.DailyCostLimit != nil {
		prospective.DailyCostLimit = input.DailyCostLimit
	}
	if input.MonthlyCostLimit != nil {
		prospective.MonthlyCostLimit = input.MonthlyCostLimit
	}
	if input.MaxOutputTokens != nil {
		prospective.MaxOutputTokens = input.MaxOutputTokens
	}
	if input.MaxToolIterations != nil {
		prospective.MaxToolIterations = input.MaxToolIterations
	}
	if input.MaxChainDepth != nil {
		prospective.MaxChainDepth = input.MaxChainDepth
	}
	if input.PerChatConcurrency != nil {
		prospective.PerChatConcurrency = input.PerChatConcurrency
	}
	if input.RateLimitPerMinute != nil {
		prospective.RateLimitPerMinute = *input.RateLimitPerMinute
	}
	if input.ProviderRateLimitPerMinute != nil {
		prospective.ProviderRateLimitPerMinute = *input.ProviderRateLimitPerMinute
	}
	if input.ExecutionTimeoutSeconds != nil {
		prospective.ExecutionTimeoutSeconds = *input.ExecutionTimeoutSeconds
	}
	if input.ChatIDs != nil {
		prospective.ChatIDs = *input.ChatIDs
	}
	return normalizeCreate(prospective)
}

func resolveLLMConnection(ctx context.Context, tx pgx.Tx, orgID, connectionID string) (string, string, string, error) {
	var provider, endpoint, defaultModel string
	err := tx.QueryRow(ctx, `SELECT provider,endpoint_url,default_model FROM agent_llm_connections WHERE org_id=$1 AND id=$2 AND enabled`, orgID, connectionID).Scan(&provider, &endpoint, &defaultModel)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", "", "", fmt.Errorf("%w: LLM connection is missing or disabled", ErrInvalid)
	}
	if err != nil {
		return "", "", "", err
	}
	return provider, endpoint, defaultModel, nil
}

func saveDraft(ctx context.Context, tx pgx.Tx, orgID, agentID, actorID string, version int, input CreateInput) error {
	_, err := tx.Exec(ctx, `
		INSERT INTO agent_drafts(org_id,agent_id,version,recipe,description,allowed_scopes,llm_connection_id,provider,model,endpoint_url,
			external_data_sharing_approved,daily_cost_limit,monthly_cost_limit,max_output_tokens,max_tool_iterations,max_chain_depth,
			per_chat_concurrency,rate_limit_per_minute,provider_rate_limit_per_minute,execution_timeout_seconds,chat_ids,created_by)
		VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NULLIF($12,'')::numeric,NULLIF($13,'')::numeric,$14,$15,$16,$17,$18,$19,$20,$21,$22)
		ON CONFLICT(agent_id) DO UPDATE SET version=excluded.version,recipe=excluded.recipe,description=excluded.description,
			allowed_scopes=excluded.allowed_scopes,llm_connection_id=excluded.llm_connection_id,provider=excluded.provider,model=excluded.model,
			endpoint_url=excluded.endpoint_url,external_data_sharing_approved=excluded.external_data_sharing_approved,
			daily_cost_limit=excluded.daily_cost_limit,monthly_cost_limit=excluded.monthly_cost_limit,max_output_tokens=excluded.max_output_tokens,
			max_tool_iterations=excluded.max_tool_iterations,max_chain_depth=excluded.max_chain_depth,per_chat_concurrency=excluded.per_chat_concurrency,
			rate_limit_per_minute=excluded.rate_limit_per_minute,provider_rate_limit_per_minute=excluded.provider_rate_limit_per_minute,
			execution_timeout_seconds=excluded.execution_timeout_seconds,chat_ids=excluded.chat_ids,updated_at=now()`,
		orgID, agentID, version, input.Recipe, input.Description, scopeStrings(input.AllowedScopes), input.LLMConnectionID,
		input.Provider, input.Model, input.EndpointURL, input.ExternalDataSharingApproved, costLimitValue(input.DailyCostLimit),
		costLimitValue(input.MonthlyCostLimit), *input.MaxOutputTokens, *input.MaxToolIterations, *input.MaxChainDepth,
		*input.PerChatConcurrency, input.RateLimitPerMinute, input.ProviderRateLimitPerMinute, input.ExecutionTimeoutSeconds,
		input.ChatIDs, actorID)
	if err != nil {
		return mapWriteError("save agent draft", err)
	}
	return nil
}

func inputFromAgent(value Agent) CreateInput {
	return CreateInput{
		DisplayName: value.DisplayName, Handle: value.Handle, Kind: value.Kind, Recipe: value.Recipe,
		Description: value.Description, Enabled: value.Enabled, AllowedScopes: value.AllowedScopes,
		LLMConnectionID: value.LLMConnectionID, Provider: value.Provider, Model: value.Model, EndpointURL: value.EndpointURL,
		ExternalDataSharingApproved: value.ExternalDataSharingApproved, DailyCostLimit: value.DailyCostLimit,
		MonthlyCostLimit: value.MonthlyCostLimit, MaxOutputTokens: intPointer(value.MaxOutputTokens),
		MaxToolIterations: intPointer(value.MaxToolIterations), MaxChainDepth: intPointer(value.MaxChainDepth),
		PerChatConcurrency: intPointer(value.PerChatConcurrency), RateLimitPerMinute: value.RateLimitPerMinute,
		ProviderRateLimitPerMinute: value.ProviderRateLimitPerMinute, ExecutionTimeoutSeconds: value.ExecutionTimeoutSeconds,
		ChatIDs: value.ChatIDs,
	}
}

func (service *Service) publishDraft(ctx context.Context, tx pgx.Tx, current identity.User, agentID string, input CreateInput, version int) ([]string, error) {
	var hasLegacyCredential, hasActiveKey, hasTrigger bool
	if err := tx.QueryRow(ctx, `SELECT
		EXISTS(SELECT 1 FROM agent_provider_credentials WHERE org_id=$1 AND agent_id=$2),
		EXISTS(SELECT 1 FROM agent_api_keys WHERE org_id=$1 AND agent_id=$2 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at>now()) AND scopes<@$3::text[]),
		EXISTS(SELECT 1 FROM agent_triggers WHERE org_id=$1 AND agent_id=$2 AND enabled)`,
		current.OrgID, agentID, scopeStrings(input.AllowedScopes)).Scan(&hasLegacyCredential, &hasActiveKey, &hasTrigger); err != nil {
		return nil, fmt.Errorf("check agent readiness: %w", err)
	}
	blockers := make([]string, 0, 6)
	if len(input.ChatIDs) == 0 {
		blockers = append(blockers, "chat_required")
	}
	if input.Kind == "external" && !hasActiveKey {
		blockers = append(blockers, "runtime_key_required")
	}
	if input.Kind == "builtin" {
		if input.Provider == "" || input.Model == "" {
			blockers = append(blockers, "provider_model_required")
		}
		if input.LLMConnectionID == nil && !hasLegacyCredential {
			blockers = append(blockers, "llm_connection_required")
		}
		if !input.ExternalDataSharingApproved {
			blockers = append(blockers, "external_data_approval_required")
		}
	}
	if input.Recipe != "custom" && !hasTrigger {
		blockers = append(blockers, "trigger_required")
	}
	if len(blockers) > 0 {
		return nil, fmt.Errorf("%w: %s", ErrNotReady, strings.Join(blockers, ","))
	}
	if _, err := tx.Exec(ctx, `UPDATE agents SET recipe=$3,recipe_version=$4,description=$5,enabled=true,allowed_scopes=$6,llm_connection_id=$7,provider=$8,model=$9,
		endpoint_url=$10,external_data_sharing_approved=$11,daily_cost_limit=NULLIF($12,'')::numeric,monthly_cost_limit=NULLIF($13,'')::numeric,
		max_output_tokens=$14,max_tool_iterations=$15,max_chain_depth=$16,per_chat_concurrency=$17,rate_limit_per_minute=$18,
		provider_rate_limit_per_minute=$19,execution_timeout_seconds=$20,operational_status='active',published_version=$4,published_at=now(),updated_at=now()
		WHERE org_id=$1 AND actor_id=$2`, current.OrgID, agentID, input.Recipe, version, input.Description,
		scopeStrings(input.AllowedScopes), input.LLMConnectionID, input.Provider, input.Model, input.EndpointURL,
		input.ExternalDataSharingApproved, costLimitValue(input.DailyCostLimit), costLimitValue(input.MonthlyCostLimit),
		*input.MaxOutputTokens, *input.MaxToolIterations, *input.MaxChainDepth, *input.PerChatConcurrency,
		input.RateLimitPerMinute, input.ProviderRateLimitPerMinute, input.ExecutionTimeoutSeconds); err != nil {
		return nil, mapWriteError("publish agent", err)
	}
	if _, err := tx.Exec(ctx, `DELETE FROM chat_members WHERE org_id=$1 AND actor_id=$2`, current.OrgID, agentID); err != nil {
		return nil, fmt.Errorf("replace published agent memberships: %w", err)
	}
	if len(input.ChatIDs) > 0 {
		if _, err := tx.Exec(ctx, `INSERT INTO chat_members(chat_id,actor_id,org_id,role) SELECT chat_id,$1,$2,'member' FROM unnest($3::uuid[]) selected(chat_id)`, agentID, current.OrgID, input.ChatIDs); err != nil {
			return nil, mapWriteError("publish agent memberships", err)
		}
	}
	revokedKeyIDs := make([]string, 0)
	rows, err := tx.Query(ctx, `UPDATE agent_api_keys SET revoked_at=now() WHERE org_id=$1 AND agent_id=$2 AND revoked_at IS NULL AND NOT (scopes <@ $3::text[]) RETURNING id`, current.OrgID, agentID, scopeStrings(input.AllowedScopes))
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var keyID string
		if err := rows.Scan(&keyID); err != nil {
			rows.Close()
			return nil, err
		}
		revokedKeyIDs = append(revokedKeyIDs, keyID)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, err
	}
	rows.Close()
	versionID, err := id.New()
	if err != nil {
		return nil, err
	}
	config, err := versionConfig(input)
	if err != nil {
		return nil, err
	}
	if _, err := tx.Exec(ctx, `INSERT INTO agent_versions(id,org_id,agent_id,version,config,created_by) VALUES($1,$2,$3,$4,$5,$6)`, versionID, current.OrgID, agentID, version, config, current.ActorID); err != nil {
		return nil, mapWriteError("record agent version", err)
	}
	if _, err := tx.Exec(ctx, `DELETE FROM agent_drafts WHERE org_id=$1 AND agent_id=$2`, current.OrgID, agentID); err != nil {
		return nil, err
	}
	return revokedKeyIDs, nil
}

func versionConfig(input CreateInput) ([]byte, error) {
	return json.Marshal(map[string]any{
		"recipe": input.Recipe, "description": input.Description, "allowed_scopes": scopeStrings(input.AllowedScopes),
		"llm_connection_id": input.LLMConnectionID, "provider": input.Provider, "model": input.Model, "endpoint_url": input.EndpointURL,
		"external_data_sharing_approved": input.ExternalDataSharingApproved, "daily_cost_limit": input.DailyCostLimit,
		"monthly_cost_limit": input.MonthlyCostLimit, "max_output_tokens": *input.MaxOutputTokens,
		"max_tool_iterations": *input.MaxToolIterations, "max_chain_depth": *input.MaxChainDepth,
		"per_chat_concurrency": *input.PerChatConcurrency, "rate_limit_per_minute": input.RateLimitPerMinute,
		"provider_rate_limit_per_minute": input.ProviderRateLimitPerMinute,
		"execution_timeout_seconds":      input.ExecutionTimeoutSeconds, "chat_ids": input.ChatIDs,
	})
}

func insertRecipeTriggers(ctx context.Context, tx pgx.Tx, orgID, agentID, recipe string, chatIDs []string, now time.Time) error {
	if recipe == "custom" {
		return nil
	}
	if len(chatIDs) == 0 {
		return fmt.Errorf("%w: recipe agents require at least one chat", ErrInvalid)
	}
	type recipeTrigger struct {
		kind         string
		config       map[string]any
		timezone     string
		missedPolicy string
		nextRunAt    *time.Time
	}
	triggers := make([]recipeTrigger, 0, 2)
	switch recipe {
	case "summarizer":
		triggers = append(triggers, recipeTrigger{kind: "command", config: map[string]any{"command": "summarize", "include_agent_messages": false}, timezone: "UTC", missedPolicy: "skip"})
		next := time.Date(now.Year(), now.Month(), now.Day(), 9, 0, 0, 0, time.UTC)
		if !next.After(now) {
			next = next.Add(24 * time.Hour)
		}
		triggers = append(triggers, recipeTrigger{kind: "schedule", config: map[string]any{"chat_id": chatIDs[0], "hour": 9, "minute": 0, "days_of_week": []int{}}, timezone: "UTC", missedPolicy: "latest", nextRunAt: &next})
	case "qa":
		triggers = append(triggers, recipeTrigger{kind: "mention", config: map[string]any{"include_agent_messages": false}, timezone: "UTC", missedPolicy: "skip"})
	case "onboarding":
		triggers = append(triggers,
			recipeTrigger{kind: "event", config: map[string]any{"event_types": []string{"member.joined"}, "include_agent_messages": false, "chat_id": chatIDs[0]}, timezone: "UTC", missedPolicy: "latest"},
			recipeTrigger{kind: "mention", config: map[string]any{"include_agent_messages": false}, timezone: "UTC", missedPolicy: "skip"},
		)
	default:
		return fmt.Errorf("%w: unsupported agent recipe", ErrInvalid)
	}
	for _, trigger := range triggers {
		triggerID, err := id.New()
		if err != nil {
			return err
		}
		config, err := json.Marshal(trigger.config)
		if err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `INSERT INTO agent_triggers(id,org_id,agent_id,type,config,enabled,timezone,missed_runs_policy,next_run_at)
			VALUES($1,$2,$3,$4,$5,true,$6,$7,$8)`, triggerID, orgID, agentID, trigger.kind, config, trigger.timezone, trigger.missedPolicy, trigger.nextRunAt); err != nil {
			return mapWriteError("create recipe trigger", err)
		}
	}
	return nil
}

func copyAgentTriggers(ctx context.Context, tx pgx.Tx, orgID, sourceAgentID, targetAgentID string) error {
	if uuid.Validate(sourceAgentID) != nil || sourceAgentID == targetAgentID {
		return ErrInvalid
	}
	var sourceExists bool
	if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM agents WHERE org_id=$1 AND actor_id=$2 AND deleted_at IS NULL)`, orgID, sourceAgentID).Scan(&sourceExists); err != nil {
		return err
	}
	if !sourceExists {
		return ErrNotFound
	}
	rows, err := tx.Query(ctx, `SELECT type,config,enabled,timezone,missed_runs_policy,next_run_at FROM agent_triggers WHERE org_id=$1 AND agent_id=$2 AND superseded_at IS NULL ORDER BY created_at,id`, orgID, sourceAgentID)
	if err != nil {
		return err
	}
	defer rows.Close()
	type trigger struct {
		kind, timezone, missedPolicy string
		config                       json.RawMessage
		enabled                      bool
		nextRunAt                    *time.Time
	}
	items := make([]trigger, 0)
	for rows.Next() {
		var item trigger
		if err := rows.Scan(&item.kind, &item.config, &item.enabled, &item.timezone, &item.missedPolicy, &item.nextRunAt); err != nil {
			return err
		}
		items = append(items, item)
	}
	if err := rows.Err(); err != nil {
		return err
	}
	rows.Close()
	for _, item := range items {
		triggerID, err := id.New()
		if err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `INSERT INTO agent_triggers(id,org_id,agent_id,type,config,enabled,timezone,missed_runs_policy,next_run_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`, triggerID, orgID, targetAgentID, item.kind, item.config, item.enabled, item.timezone, item.missedPolicy, item.nextRunAt); err != nil {
			return mapWriteError("duplicate agent trigger", err)
		}
	}
	return nil
}

func recipeDefaults(recipe string) (string, []Scope, bool) {
	baseScopes := []Scope{ScopeMessagesRead, ScopeMessagesWrite, ScopeSearchRead, ScopeFilesRead, ScopeMemoryRead, ScopeMemoryWrite, ScopeRuntimeExecute}
	switch recipe {
	case "summarizer":
		return "Summarize the selected chat or thread with decisions, open questions, and next actions. Cite message identifiers and never invent facts.", baseScopes, true
	case "qa":
		return "Answer from accessible workspace history and extracted files. Search first, cite exact sources, distinguish evidence from inference, and say when the answer is unavailable.", baseScopes, true
	case "onboarding":
		return "Help new members understand the workspace using only accessible history and files. Cite sources, answer follow-up questions, and never reveal private chats.", []Scope{ScopeMessagesRead, ScopeMessagesWrite, ScopeSearchRead, ScopeFilesRead, ScopeRuntimeExecute}, true
	default:
		return "", nil, false
	}
}

func intPointer(value int) *int { return &value }
func costLimitValue(value *string) string {
	if value == nil {
		return ""
	}
	return *value
}

func normalizeScopes(input []Scope) ([]Scope, error) {
	seen := make(map[Scope]struct{}, len(input))
	result := make([]Scope, 0, len(input))
	for _, scope := range input {
		if _, valid := validScopes[scope]; !valid {
			return nil, fmt.Errorf("%w: unsupported scope %q", ErrInvalid, scope)
		}
		if _, duplicate := seen[scope]; duplicate {
			continue
		}
		seen[scope] = struct{}{}
		result = append(result, scope)
	}
	sort.Slice(result, func(i, j int) bool { return result[i] < result[j] })
	return result, nil
}

func normalizeUUIDs(input []string, limit int) ([]string, error) {
	if len(input) > limit {
		return nil, fmt.Errorf("%w: too many identifiers", ErrInvalid)
	}
	seen := make(map[string]struct{}, len(input))
	result := make([]string, 0, len(input))
	for _, value := range input {
		parsed, err := uuid.Parse(strings.TrimSpace(value))
		if err != nil {
			return nil, fmt.Errorf("%w: invalid identifier", ErrInvalid)
		}
		normalized := parsed.String()
		if _, duplicate := seen[normalized]; duplicate {
			continue
		}
		seen[normalized] = struct{}{}
		result = append(result, normalized)
	}
	sort.Strings(result)
	return result, nil
}

func scopeStrings(scopes []Scope) []string {
	result := make([]string, len(scopes))
	for index, scope := range scopes {
		result[index] = string(scope)
	}
	return result
}

func scopeSubset(scopes []Scope, allowed []string) bool {
	set := make(map[string]struct{}, len(allowed))
	for _, scope := range allowed {
		set[scope] = struct{}{}
	}
	for _, scope := range scopes {
		if _, exists := set[string(scope)]; !exists {
			return false
		}
	}
	return true
}

func canBuild(current identity.User) bool   { return agentauthz.New().CanBuild(current) }
func canPublish(current identity.User) bool { return agentauthz.New().CanPublish(current) }
func canView(current identity.User) bool    { return agentauthz.New().CanView(current) }

func (service *Service) revokeRealtimeKeys(keyIDs []string) {
	if service.revokeSession == nil {
		return
	}
	seen := make(map[string]struct{}, len(keyIDs))
	for _, keyID := range keyIDs {
		if _, exists := seen[keyID]; exists {
			continue
		}
		seen[keyID] = struct{}{}
		service.revokeSession(keyID)
	}
}

func mapWriteError(operation string, err error) error {
	var postgresError *pgconn.PgError
	if errors.As(err, &postgresError) && (postgresError.Code == "23505" || postgresError.Code == "23503" || postgresError.Code == "23514") {
		return fmt.Errorf("%w: %s", ErrConflict, operation)
	}
	return fmt.Errorf("%s: %w", operation, err)
}
