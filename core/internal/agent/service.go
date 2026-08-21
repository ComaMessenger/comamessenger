package agent

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/comamessenger/comamessenger/core/internal/access"
	"github.com/comamessenger/comamessenger/core/internal/id"
	"github.com/comamessenger/comamessenger/core/internal/identity"
	"github.com/comamessenger/comamessenger/core/internal/permission"
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
)

var validScopes = map[Scope]struct{}{
	ScopeChatsRead: {}, ScopeMessagesRead: {}, ScopeMessagesWrite: {}, ScopeReactionsWrite: {},
	ScopeFilesRead: {}, ScopeSearchRead: {}, ScopeMembersRead: {}, ScopeMemoryRead: {}, ScopeMemoryWrite: {},
	ScopeRuntimeExecute: {},
}

var handlePattern = regexp.MustCompile(`^[a-z0-9][a-z0-9_.-]{1,31}$`)
var costLimitPattern = regexp.MustCompile(`^[0-9]+(?:\.[0-9]{1,8})?$`)

type Agent struct {
	ID                          string    `json:"id"`
	OrgID                       string    `json:"org_id"`
	OwnerActorID                string    `json:"owner_actor_id"`
	DisplayName                 string    `json:"display_name"`
	Handle                      string    `json:"handle"`
	Kind                        string    `json:"kind"`
	Description                 string    `json:"description"`
	Enabled                     bool      `json:"enabled"`
	AllowedScopes               []Scope   `json:"allowed_scopes"`
	Provider                    string    `json:"provider"`
	Model                       string    `json:"model"`
	EndpointURL                 string    `json:"endpoint_url,omitempty"`
	ExternalDataSharingApproved bool      `json:"external_data_sharing_approved"`
	DailyCostLimit              *string   `json:"daily_cost_limit"`
	MonthlyCostLimit            *string   `json:"monthly_cost_limit"`
	MaxOutputTokens             int       `json:"max_output_tokens"`
	MaxToolIterations           int       `json:"max_tool_iterations"`
	MaxChainDepth               int       `json:"max_chain_depth"`
	PerChatConcurrency          int       `json:"per_chat_concurrency"`
	RateLimitPerMinute          int       `json:"rate_limit_per_minute"`
	ProviderRateLimitPerMinute  int       `json:"provider_rate_limit_per_minute"`
	ChatIDs                     []string  `json:"chat_ids"`
	AvatarVersion               int64     `json:"avatar_version"`
	CreatedAt                   time.Time `json:"created_at"`
	UpdatedAt                   time.Time `json:"updated_at"`
}

type CreateInput struct {
	DisplayName                 string   `json:"display_name"`
	Handle                      string   `json:"handle"`
	Kind                        string   `json:"kind"`
	Description                 string   `json:"description"`
	Enabled                     bool     `json:"enabled"`
	AllowedScopes               []Scope  `json:"allowed_scopes"`
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
	ChatIDs                     []string `json:"chat_ids"`
}

type UpdateInput struct {
	DisplayName                 *string   `json:"display_name"`
	Handle                      *string   `json:"handle"`
	Description                 *string   `json:"description"`
	Enabled                     *bool     `json:"enabled"`
	AllowedScopes               *[]Scope  `json:"allowed_scopes"`
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
	ChatIDs                     *[]string `json:"chat_ids"`
}

type PlatformSettings struct {
	OrganizationRateLimitPerMinute int `json:"organization_rate_limit_per_minute"`
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

func (service *Service) Create(ctx context.Context, current identity.User, input CreateInput) (Agent, error) {
	if !canManage(current) {
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
		INSERT INTO agents(actor_id,org_id,owner_actor_id,kind,description,enabled,allowed_scopes,provider,model,endpoint_url,
			external_data_sharing_approved,daily_cost_limit,monthly_cost_limit,max_output_tokens,max_tool_iterations,max_chain_depth,per_chat_concurrency,
			rate_limit_per_minute,provider_rate_limit_per_minute)
		VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NULLIF($12,'')::numeric,NULLIF($13,'')::numeric,$14,$15,$16,$17,$18,$19)`, agentID, current.OrgID, current.ActorID, normalized.Kind,
		normalized.Description, normalized.Enabled, scopes, normalized.Provider, normalized.Model, normalized.EndpointURL,
		normalized.ExternalDataSharingApproved, costLimitValue(normalized.DailyCostLimit), costLimitValue(normalized.MonthlyCostLimit),
		*normalized.MaxOutputTokens, *normalized.MaxToolIterations, *normalized.MaxChainDepth,
		*normalized.PerChatConcurrency, normalized.RateLimitPerMinute, normalized.ProviderRateLimitPerMinute); err != nil {
		return Agent{}, mapWriteError("insert agent", err)
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
	metadata, _ := json.Marshal(map[string]any{"kind": normalized.Kind, "enabled": normalized.Enabled, "scopes": scopes, "chat_ids": normalized.ChatIDs})
	if _, err := tx.Exec(ctx, `INSERT INTO audit_log(id,org_id,actor_id,action,target_type,target_id,metadata) VALUES($1,$2,$3,'agent.create','agent',$4,$5)`, auditID, current.OrgID, current.ActorID, agentID, metadata); err != nil {
		return Agent{}, fmt.Errorf("audit agent creation: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return Agent{}, mapWriteError("commit agent creation", err)
	}
	return service.Get(ctx, current, agentID)
}

func (service *Service) List(ctx context.Context, current identity.User) ([]Agent, error) {
	manager := canManage(current)
	rows, err := service.pool.Query(ctx, agentSelect+` WHERE agent.org_id=$1 AND (agent.enabled OR $2) ORDER BY actor.display_name, actor.id`, current.OrgID, manager)
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
		}
		result = append(result, item)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate agents: %w", err)
	}
	return result, nil
}

func (service *Service) Usage(ctx context.Context, current identity.User, agentID string) (UsageReport, error) {
	if !canManage(current) {
		return UsageReport{}, ErrForbidden
	}
	if uuid.Validate(agentID) != nil {
		return UsageReport{}, ErrNotFound
	}
	var exists bool
	if err := service.pool.QueryRow(ctx, `SELECT true FROM agents WHERE org_id=$1 AND actor_id=$2`, current.OrgID, agentID).Scan(&exists); errors.Is(err, pgx.ErrNoRows) {
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
		count(*) FILTER (WHERE created_at >= date_trunc('month',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')
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

func (service *Service) Get(ctx context.Context, current identity.User, agentID string) (Agent, error) {
	if _, err := uuid.Parse(agentID); err != nil {
		return Agent{}, ErrNotFound
	}
	manager := canManage(current)
	result, err := scanAgent(service.pool.QueryRow(ctx, agentSelect+` WHERE agent.org_id=$1 AND agent.actor_id=$2 AND (agent.enabled OR $3)`, current.OrgID, agentID, manager))
	if errors.Is(err, pgx.ErrNoRows) {
		return Agent{}, ErrNotFound
	}
	if err != nil {
		return Agent{}, fmt.Errorf("get agent: %w", err)
	}
	if !manager {
		result.EndpointURL = ""
	}
	return result, nil
}

func (service *Service) Update(ctx context.Context, current identity.User, agentID string, input UpdateInput) (Agent, error) {
	if !canManage(current) {
		return Agent{}, ErrForbidden
	}
	if _, err := uuid.Parse(agentID); err != nil {
		return Agent{}, ErrNotFound
	}
	if input.DisplayName == nil && input.Handle == nil && input.Description == nil && input.Enabled == nil && input.AllowedScopes == nil && input.Provider == nil && input.Model == nil && input.EndpointURL == nil && input.ExternalDataSharingApproved == nil && input.RateLimitPerMinute == nil && input.ProviderRateLimitPerMinute == nil && input.ChatIDs == nil {
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
	lockedAgent, err := scanAgent(tx.QueryRow(ctx, agentSelect+` WHERE agent.org_id=$1 AND agent.actor_id=$2 FOR UPDATE OF agent,actor`, current.OrgID, agentID))
	if errors.Is(err, pgx.ErrNoRows) {
		return Agent{}, ErrNotFound
	} else if err != nil {
		return Agent{}, fmt.Errorf("lock agent: %w", err)
	}
	prospective, err := mergeUpdate(lockedAgent, input)
	if err != nil {
		return Agent{}, err
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
	if _, err := tx.Exec(ctx, `UPDATE agents SET description=$3,enabled=$4,allowed_scopes=$5,provider=$6,model=$7,
		endpoint_url=$8,external_data_sharing_approved=$9,daily_cost_limit=NULLIF($10,'')::numeric,monthly_cost_limit=NULLIF($11,'')::numeric,
		max_output_tokens=$12,max_tool_iterations=$13,max_chain_depth=$14,per_chat_concurrency=$15,
		rate_limit_per_minute=$16,provider_rate_limit_per_minute=$17,updated_at=now()
		WHERE org_id=$1 AND actor_id=$2`, current.OrgID, agentID, prospective.Description, prospective.Enabled,
		scopeStrings(prospective.AllowedScopes), prospective.Provider, prospective.Model, prospective.EndpointURL,
		prospective.ExternalDataSharingApproved, costLimitValue(prospective.DailyCostLimit), costLimitValue(prospective.MonthlyCostLimit),
		*prospective.MaxOutputTokens, *prospective.MaxToolIterations,
		*prospective.MaxChainDepth, *prospective.PerChatConcurrency, prospective.RateLimitPerMinute,
		prospective.ProviderRateLimitPerMinute); err != nil {
		return Agent{}, mapWriteError("update agent", err)
	}
	if input.ChatIDs != nil {
		if _, err := tx.Exec(ctx, `DELETE FROM chat_members WHERE org_id=$1 AND actor_id=$2`, current.OrgID, agentID); err != nil {
			return Agent{}, fmt.Errorf("replace agent memberships: %w", err)
		}
		if len(prospective.ChatIDs) > 0 {
			if _, err := tx.Exec(ctx, `INSERT INTO chat_members(chat_id,actor_id,org_id,role) SELECT chat_id,$1,$2,'member' FROM unnest($3::uuid[]) selected(chat_id)`, agentID, current.OrgID, prospective.ChatIDs); err != nil {
				return Agent{}, mapWriteError("replace agent memberships", err)
			}
		}
	}
	revokedKeyIDs := make([]string, 0)
	revokedRows, err := tx.Query(ctx, `UPDATE agent_api_keys SET revoked_at=now() WHERE org_id=$1 AND agent_id=$2 AND revoked_at IS NULL AND NOT (scopes <@ $3::text[]) RETURNING id`, current.OrgID, agentID, scopeStrings(prospective.AllowedScopes))
	if err != nil {
		return Agent{}, fmt.Errorf("revoke over-scoped agent keys: %w", err)
	}
	for revokedRows.Next() {
		var keyID string
		if err := revokedRows.Scan(&keyID); err != nil {
			revokedRows.Close()
			return Agent{}, fmt.Errorf("scan revoked agent key: %w", err)
		}
		revokedKeyIDs = append(revokedKeyIDs, keyID)
	}
	if err := revokedRows.Err(); err != nil {
		revokedRows.Close()
		return Agent{}, fmt.Errorf("iterate revoked agent keys: %w", err)
	}
	revokedRows.Close()
	if !prospective.Enabled {
		rows, err := tx.Query(ctx, `SELECT id FROM agent_api_keys WHERE org_id=$1 AND agent_id=$2 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at>now())`, current.OrgID, agentID)
		if err != nil {
			return Agent{}, fmt.Errorf("list disabled agent keys: %w", err)
		}
		for rows.Next() {
			var keyID string
			if err := rows.Scan(&keyID); err != nil {
				rows.Close()
				return Agent{}, fmt.Errorf("scan disabled agent key: %w", err)
			}
			revokedKeyIDs = append(revokedKeyIDs, keyID)
		}
		if err := rows.Err(); err != nil {
			rows.Close()
			return Agent{}, fmt.Errorf("iterate disabled agent keys: %w", err)
		}
		rows.Close()
	}
	metadata, _ := json.Marshal(map[string]any{"enabled": prospective.Enabled, "scopes": scopeStrings(prospective.AllowedScopes), "chat_ids": prospective.ChatIDs})
	if _, err := tx.Exec(ctx, `INSERT INTO audit_log(id,org_id,actor_id,action,target_type,target_id,metadata) VALUES($1,$2,$3,'agent.update','agent',$4,$5)`, auditID, current.OrgID, current.ActorID, agentID, metadata); err != nil {
		return Agent{}, fmt.Errorf("audit agent update: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return Agent{}, mapWriteError("commit agent update", err)
	}
	service.revokeRealtimeKeys(revokedKeyIDs)
	return service.Get(ctx, current, agentID)
}

func (service *Service) CreateKey(ctx context.Context, current identity.User, agentID string, input CreateKeyInput) (CreatedAPIKey, error) {
	if !canManage(current) {
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
	if !canManage(current) {
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
	if !canManage(current) {
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
		  AND agent.enabled AND key.scopes <@ agent.allowed_scopes AND actor.status='active' AND actor.deleted_at IS NULL`, digest[:]).Scan(
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
	       agent.kind,agent.description,agent.enabled,agent.allowed_scopes,agent.provider,agent.model,
	       agent.endpoint_url,agent.external_data_sharing_approved,agent.daily_cost_limit::text,agent.monthly_cost_limit::text,agent.max_output_tokens,
	       agent.max_tool_iterations,agent.max_chain_depth,agent.per_chat_concurrency,
	       agent.rate_limit_per_minute,agent.provider_rate_limit_per_minute,
	       COALESCE((SELECT array_agg(member.chat_id ORDER BY member.chat_id) FROM chat_members member WHERE member.org_id=agent.org_id AND member.actor_id=agent.actor_id),'{}'::uuid[]),
	       actor.avatar_version,agent.created_at,agent.updated_at
	FROM agents agent JOIN actors actor ON actor.org_id=agent.org_id AND actor.id=agent.actor_id`

type scanner interface{ Scan(...any) error }

func scanAgent(row scanner) (Agent, error) {
	var result Agent
	var scopes []string
	if err := row.Scan(&result.ID, &result.OrgID, &result.OwnerActorID, &result.DisplayName, &result.Handle,
		&result.Kind, &result.Description, &result.Enabled, &scopes, &result.Provider, &result.Model,
		&result.EndpointURL, &result.ExternalDataSharingApproved, &result.DailyCostLimit, &result.MonthlyCostLimit, &result.MaxOutputTokens,
		&result.MaxToolIterations, &result.MaxChainDepth, &result.PerChatConcurrency,
		&result.RateLimitPerMinute, &result.ProviderRateLimitPerMinute, &result.ChatIDs, &result.AvatarVersion, &result.CreatedAt, &result.UpdatedAt); err != nil {
		return Agent{}, err
	}
	result.AllowedScopes = make([]Scope, len(scopes))
	for index, value := range scopes {
		result.AllowedScopes[index] = Scope(value)
	}
	return result, nil
}

func normalizeCreate(input CreateInput) (CreateInput, error) {
	input.DisplayName = strings.TrimSpace(input.DisplayName)
	input.Handle = strings.ToLower(strings.TrimSpace(input.Handle))
	input.Kind = strings.TrimSpace(input.Kind)
	input.Description = strings.TrimSpace(input.Description)
	input.Provider = strings.TrimSpace(input.Provider)
	input.Model = strings.TrimSpace(input.Model)
	input.EndpointURL = strings.TrimSpace(input.EndpointURL)
	if input.RateLimitPerMinute == 0 {
		input.RateLimitPerMinute = 60
	}
	if input.ProviderRateLimitPerMinute == 0 {
		input.ProviderRateLimitPerMinute = 300
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
		*input.MaxOutputTokens < 1 || *input.MaxOutputTokens > 1000000 || *input.MaxToolIterations < 0 || *input.MaxToolIterations > 64 ||
		*input.MaxChainDepth < 0 || *input.MaxChainDepth > 16 || *input.PerChatConcurrency < 1 || *input.PerChatConcurrency > 32 {
		return CreateInput{}, fmt.Errorf("%w: invalid agent profile", ErrInvalid)
	}
	if input.Kind == "builtin" && input.EndpointURL != "" {
		return CreateInput{}, fmt.Errorf("%w: builtin agent cannot have an endpoint", ErrInvalid)
	}
	if input.Kind == "external" {
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
	return input, nil
}

func mergeUpdate(existing Agent, input UpdateInput) (CreateInput, error) {
	prospective := CreateInput{
		DisplayName: existing.DisplayName, Handle: existing.Handle, Kind: existing.Kind,
		Description: existing.Description, Enabled: existing.Enabled, AllowedScopes: existing.AllowedScopes,
		Provider: existing.Provider, Model: existing.Model, EndpointURL: existing.EndpointURL,
		ExternalDataSharingApproved: existing.ExternalDataSharingApproved, RateLimitPerMinute: existing.RateLimitPerMinute,
		DailyCostLimit: existing.DailyCostLimit, MonthlyCostLimit: existing.MonthlyCostLimit,
		ProviderRateLimitPerMinute: existing.ProviderRateLimitPerMinute, ChatIDs: existing.ChatIDs,
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
	if input.ChatIDs != nil {
		prospective.ChatIDs = *input.ChatIDs
	}
	return normalizeCreate(prospective)
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

func canManage(current identity.User) bool {
	return permission.Allows(current.OrgRole, current.Permissions, permission.AgentsManage)
}

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
