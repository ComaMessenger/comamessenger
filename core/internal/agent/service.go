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

	"github.com/comamessenger/comamessenger/core/internal/id"
	"github.com/comamessenger/comamessenger/core/internal/identity"
	"github.com/comamessenger/comamessenger/core/internal/permission"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

var (
	ErrInvalid   = errors.New("invalid agent input")
	ErrForbidden = errors.New("agent management forbidden")
	ErrNotFound  = errors.New("agent not found")
	ErrConflict  = errors.New("agent conflicts with existing data")
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
)

var validScopes = map[Scope]struct{}{
	ScopeChatsRead: {}, ScopeMessagesRead: {}, ScopeMessagesWrite: {}, ScopeReactionsWrite: {},
	ScopeFilesRead: {}, ScopeSearchRead: {}, ScopeMembersRead: {}, ScopeMemoryRead: {}, ScopeMemoryWrite: {},
}

var handlePattern = regexp.MustCompile(`^[a-z0-9][a-z0-9_.-]{1,31}$`)

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
	MaxOutputTokens             int       `json:"max_output_tokens"`
	MaxToolIterations           int       `json:"max_tool_iterations"`
	MaxChainDepth               int       `json:"max_chain_depth"`
	PerChatConcurrency          int       `json:"per_chat_concurrency"`
	RateLimitPerMinute          int       `json:"rate_limit_per_minute"`
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
	ChatIDs                     []string `json:"chat_ids"`
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

type CreateKeyInput struct {
	Name               string     `json:"name"`
	Scopes             []Scope    `json:"scopes"`
	RateLimitPerMinute int        `json:"rate_limit_per_minute"`
	ExpiresAt          *time.Time `json:"expires_at"`
}

type Service struct {
	pool *pgxpool.Pool
	now  func() time.Time
}

func NewService(pool *pgxpool.Pool) *Service {
	return &Service{pool: pool, now: time.Now}
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
		INSERT INTO agents(actor_id,org_id,owner_actor_id,kind,description,enabled,allowed_scopes,provider,model,endpoint_url,external_data_sharing_approved)
		VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`, agentID, current.OrgID, current.ActorID, normalized.Kind,
		normalized.Description, normalized.Enabled, scopes, normalized.Provider, normalized.Model, normalized.EndpointURL,
		normalized.ExternalDataSharingApproved); err != nil {
		return Agent{}, mapWriteError("insert agent", err)
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

func (service *Service) CreateKey(ctx context.Context, current identity.User, agentID string, input CreateKeyInput) (CreatedAPIKey, error) {
	if !canManage(current) {
		return CreatedAPIKey{}, ErrForbidden
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
	return tx.Commit(ctx)
}

const agentSelect = `
	SELECT agent.actor_id,agent.org_id,agent.owner_actor_id,actor.display_name,actor.handle,
	       agent.kind,agent.description,agent.enabled,agent.allowed_scopes,agent.provider,agent.model,
	       agent.endpoint_url,agent.external_data_sharing_approved,agent.max_output_tokens,
	       agent.max_tool_iterations,agent.max_chain_depth,agent.per_chat_concurrency,
	       agent.rate_limit_per_minute,
	       COALESCE((SELECT array_agg(member.chat_id ORDER BY member.chat_id) FROM chat_members member WHERE member.org_id=agent.org_id AND member.actor_id=agent.actor_id),'{}'::uuid[]),
	       actor.avatar_version,agent.created_at,agent.updated_at
	FROM agents agent JOIN actors actor ON actor.org_id=agent.org_id AND actor.id=agent.actor_id`

type scanner interface{ Scan(...any) error }

func scanAgent(row scanner) (Agent, error) {
	var result Agent
	var scopes []string
	if err := row.Scan(&result.ID, &result.OrgID, &result.OwnerActorID, &result.DisplayName, &result.Handle,
		&result.Kind, &result.Description, &result.Enabled, &scopes, &result.Provider, &result.Model,
		&result.EndpointURL, &result.ExternalDataSharingApproved, &result.MaxOutputTokens,
		&result.MaxToolIterations, &result.MaxChainDepth, &result.PerChatConcurrency,
		&result.RateLimitPerMinute, &result.ChatIDs, &result.AvatarVersion, &result.CreatedAt, &result.UpdatedAt); err != nil {
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
	if len([]rune(input.DisplayName)) < 1 || len([]rune(input.DisplayName)) > 120 || !handlePattern.MatchString(input.Handle) ||
		(input.Kind != "builtin" && input.Kind != "external") || len([]rune(input.Description)) > 2000 || len(input.Provider) > 100 || len(input.Model) > 200 {
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

func mapWriteError(operation string, err error) error {
	var postgresError *pgconn.PgError
	if errors.As(err, &postgresError) && (postgresError.Code == "23505" || postgresError.Code == "23503" || postgresError.Code == "23514") {
		return fmt.Errorf("%w: %s", ErrConflict, operation)
	}
	return fmt.Errorf("%s: %w", operation, err)
}
