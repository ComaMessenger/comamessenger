package agentconfig

import (
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/netip"
	"net/url"
	"regexp"
	"strings"
	"time"

	"github.com/comamessenger/comamessenger/core/internal/access"
	"github.com/comamessenger/comamessenger/core/internal/agentauthz"
	"github.com/comamessenger/comamessenger/core/internal/id"
	"github.com/comamessenger/comamessenger/core/internal/identity"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

var (
	ErrInvalid   = errors.New("invalid agent configuration")
	ErrForbidden = errors.New("agent configuration forbidden")
	ErrNotFound  = errors.New("agent configuration not found")
)

type CredentialView struct {
	Configured bool       `json:"configured"`
	KeyHint    string     `json:"key_hint"`
	UpdatedAt  *time.Time `json:"updated_at"`
}

type UpdateCredentialInput struct {
	APIKey string `json:"api_key"`
	Clear  bool   `json:"clear"`
}

type RuntimeCredential struct {
	APIKey string `json:"api_key"`
}

type MCPServer struct {
	ID                       string    `json:"id"`
	AgentID                  string    `json:"agent_id"`
	Name                     string    `json:"name"`
	EndpointURL              string    `json:"endpoint_url"`
	Enabled                  bool      `json:"enabled"`
	AllowedTools             []string  `json:"allowed_tools"`
	HeadersConfigured        bool      `json:"headers_configured"`
	TimeoutMS                int       `json:"timeout_ms"`
	MaxOutputBytes           int       `json:"max_output_bytes"`
	RequireWriteConfirmation bool      `json:"require_write_confirmation"`
	CreatedAt                time.Time `json:"created_at"`
	UpdatedAt                time.Time `json:"updated_at"`
}

type CreateMCPServerInput struct {
	Name                     string            `json:"name"`
	EndpointURL              string            `json:"endpoint_url"`
	Enabled                  bool              `json:"enabled"`
	AllowedTools             []string          `json:"allowed_tools"`
	Headers                  map[string]string `json:"headers"`
	TimeoutMS                int               `json:"timeout_ms"`
	MaxOutputBytes           int               `json:"max_output_bytes"`
	RequireWriteConfirmation *bool             `json:"require_write_confirmation"`
}

type UpdateMCPServerInput struct {
	Name                     *string            `json:"name"`
	EndpointURL              *string            `json:"endpoint_url"`
	Enabled                  *bool              `json:"enabled"`
	AllowedTools             *[]string          `json:"allowed_tools"`
	Headers                  *map[string]string `json:"headers"`
	TimeoutMS                *int               `json:"timeout_ms"`
	MaxOutputBytes           *int               `json:"max_output_bytes"`
	RequireWriteConfirmation *bool              `json:"require_write_confirmation"`
}

type RuntimeMCPServer struct {
	ID                       string            `json:"id"`
	Name                     string            `json:"name"`
	EndpointURL              string            `json:"endpoint_url"`
	AllowedTools             []string          `json:"allowed_tools"`
	Headers                  map[string]string `json:"headers"`
	TimeoutMS                int               `json:"timeout_ms"`
	MaxOutputBytes           int               `json:"max_output_bytes"`
	RequireWriteConfirmation bool              `json:"require_write_confirmation"`
}

type Service struct {
	pool           *pgxpool.Pool
	credentialAEAD cipher.AEAD
	connectionAEAD cipher.AEAD
	mcpAEAD        cipher.AEAD
}

func NewService(pool *pgxpool.Pool, secret string) (*Service, error) {
	credentialAEAD, err := makeAEAD("comamessenger/agent-provider-credentials/v1", secret)
	if err != nil {
		return nil, err
	}
	connectionAEAD, err := makeAEAD("comamessenger/agent-llm-connections/v1", secret)
	if err != nil {
		return nil, err
	}
	mcpAEAD, err := makeAEAD("comamessenger/agent-mcp-headers/v1", secret)
	if err != nil {
		return nil, err
	}
	return &Service{pool: pool, credentialAEAD: credentialAEAD, connectionAEAD: connectionAEAD, mcpAEAD: mcpAEAD}, nil
}

func makeAEAD(domain, secret string) (cipher.AEAD, error) {
	digest := sha256.Sum256([]byte(domain + "\x00" + secret))
	block, err := aes.NewCipher(digest[:])
	if err != nil {
		return nil, err
	}
	return cipher.NewGCM(block)
}

func (service *Service) Credential(ctx context.Context, current identity.User, agentID string) (CredentialView, error) {
	if !canManage(current) {
		return CredentialView{}, ErrForbidden
	}
	if uuid.Validate(agentID) != nil {
		return CredentialView{}, ErrNotFound
	}
	var keyHint string
	var updatedAt time.Time
	err := service.pool.QueryRow(ctx, `SELECT credential.key_hint,credential.updated_at
		FROM agent_provider_credentials credential JOIN agents agent ON agent.org_id=credential.org_id AND agent.actor_id=credential.agent_id
		WHERE credential.org_id=$1 AND credential.agent_id=$2`, current.OrgID, agentID).Scan(&keyHint, &updatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		var exists bool
		if err := service.pool.QueryRow(ctx, `SELECT true FROM agents WHERE org_id=$1 AND actor_id=$2`, current.OrgID, agentID).Scan(&exists); errors.Is(err, pgx.ErrNoRows) {
			return CredentialView{}, ErrNotFound
		} else if err != nil {
			return CredentialView{}, err
		}
		return CredentialView{KeyHint: ""}, nil
	}
	if err != nil {
		return CredentialView{}, err
	}
	return CredentialView{Configured: true, KeyHint: keyHint, UpdatedAt: &updatedAt}, nil
}

func (service *Service) UpdateCredential(ctx context.Context, current identity.User, agentID string, input UpdateCredentialInput) (CredentialView, error) {
	if !canManage(current) {
		return CredentialView{}, ErrForbidden
	}
	if uuid.Validate(agentID) != nil || input.Clear == (strings.TrimSpace(input.APIKey) != "") || len(input.APIKey) > 16384 {
		return CredentialView{}, ErrInvalid
	}
	var nonce, ciphertext []byte
	var err error
	if !input.Clear {
		nonce, ciphertext, err = service.seal(current.OrgID, agentID, strings.TrimSpace(input.APIKey))
		if err != nil {
			return CredentialView{}, err
		}
	}
	tx, err := service.pool.Begin(ctx)
	if err != nil {
		return CredentialView{}, err
	}
	defer tx.Rollback(ctx)
	var exists bool
	if err := tx.QueryRow(ctx, `SELECT true FROM agents WHERE org_id=$1 AND actor_id=$2 FOR UPDATE`, current.OrgID, agentID).Scan(&exists); errors.Is(err, pgx.ErrNoRows) {
		return CredentialView{}, ErrNotFound
	} else if err != nil {
		return CredentialView{}, err
	}
	if input.Clear {
		if _, err := tx.Exec(ctx, `DELETE FROM agent_provider_credentials WHERE org_id=$1 AND agent_id=$2`, current.OrgID, agentID); err != nil {
			return CredentialView{}, err
		}
	} else if _, err := tx.Exec(ctx, `INSERT INTO agent_provider_credentials(agent_id,org_id,nonce,ciphertext,key_hint,updated_by)
		VALUES($1,$2,$3,$4,$5,$6)
		ON CONFLICT(agent_id) DO UPDATE SET nonce=EXCLUDED.nonce,ciphertext=EXCLUDED.ciphertext,key_hint=EXCLUDED.key_hint,updated_by=EXCLUDED.updated_by,updated_at=now()`,
		agentID, current.OrgID, nonce, ciphertext, mask(strings.TrimSpace(input.APIKey)), current.ActorID); err != nil {
		return CredentialView{}, err
	}
	if err := auditCredential(ctx, tx, current, agentID, !input.Clear); err != nil {
		return CredentialView{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return CredentialView{}, err
	}
	if input.Clear {
		return CredentialView{}, nil
	}
	return service.Credential(ctx, current, agentID)
}

func auditCredential(ctx context.Context, tx pgx.Tx, current identity.User, agentID string, configured bool) error {
	auditID, err := id.New()
	if err != nil {
		return err
	}
	metadata, _ := json.Marshal(map[string]bool{"configured": configured})
	_, err = tx.Exec(ctx, `INSERT INTO audit_log(id,org_id,actor_id,action,target_type,target_id,metadata)
		VALUES($1,$2,$3,'agent.provider_credential.update','agent',$4,$5)`, auditID, current.OrgID, current.ActorID, agentID, metadata)
	return err
}

func (service *Service) RuntimeCredential(ctx context.Context, current identity.User, authentication access.Identity) (RuntimeCredential, error) {
	if !agentauthz.New().IsRuntime(current, authentication) {
		return RuntimeCredential{}, ErrForbidden
	}
	return service.RuntimeCredentialForAgent(ctx, current, authentication, current.ActorID)
}

func (service *Service) RuntimeCredentialForAgent(ctx context.Context, current identity.User, authentication access.Identity, agentID string) (RuntimeCredential, error) {
	if !agentauthz.New().CanWork(current, authentication) || uuid.Validate(agentID) != nil {
		return RuntimeCredential{}, ErrForbidden
	}
	var connectionID *string
	var nonce, ciphertext []byte
	var connectionEnabled *bool
	err := service.pool.QueryRow(ctx, `SELECT connection.id,connection.nonce,connection.ciphertext,connection.enabled
		FROM agents agent LEFT JOIN agent_llm_connections connection ON connection.org_id=agent.org_id AND connection.id=agent.llm_connection_id
		WHERE agent.org_id=$1 AND agent.actor_id=$2 AND agent.deleted_at IS NULL`, current.OrgID, agentID).Scan(&connectionID, &nonce, &ciphertext, &connectionEnabled)
	if errors.Is(err, pgx.ErrNoRows) {
		return RuntimeCredential{}, ErrNotFound
	}
	if err != nil {
		return RuntimeCredential{}, err
	}
	if connectionID != nil {
		if connectionEnabled == nil || !*connectionEnabled {
			return RuntimeCredential{}, ErrNotFound
		}
		plain, err := service.openLLMConnection(current.OrgID, *connectionID, nonce, ciphertext)
		if err != nil {
			return RuntimeCredential{}, err
		}
		return RuntimeCredential{APIKey: plain}, nil
	}
	err = service.pool.QueryRow(ctx, `SELECT nonce,ciphertext FROM agent_provider_credentials WHERE org_id=$1 AND agent_id=$2`, current.OrgID, agentID).Scan(&nonce, &ciphertext)
	if errors.Is(err, pgx.ErrNoRows) {
		return RuntimeCredential{}, ErrNotFound
	}
	if err != nil {
		return RuntimeCredential{}, err
	}
	plain, err := service.open(current.OrgID, agentID, nonce, ciphertext)
	if err != nil {
		return RuntimeCredential{}, err
	}
	return RuntimeCredential{APIKey: plain}, nil
}

func (service *Service) RuntimeCredentialForRun(ctx context.Context, current identity.User, authentication access.Identity, agentID, runID string) (RuntimeCredential, error) {
	if !agentauthz.New().CanWork(current, authentication) || uuid.Validate(agentID) != nil || uuid.Validate(runID) != nil {
		return RuntimeCredential{}, ErrForbidden
	}
	var dryRun bool
	var connectionID *string
	var nonce, ciphertext []byte
	var connectionEnabled *bool
	err := service.pool.QueryRow(ctx, `SELECT run.dry_run,NULLIF(run.agent_config->>'llm_connection_id','')::uuid,
		connection.nonce,connection.ciphertext,connection.enabled
		FROM agent_runs run LEFT JOIN agent_llm_connections connection ON connection.org_id=run.org_id AND connection.id=NULLIF(run.agent_config->>'llm_connection_id','')::uuid
		WHERE run.org_id=$1 AND run.agent_id=$2 AND run.id=$3`, current.OrgID, agentID, runID).Scan(&dryRun, &connectionID, &nonce, &ciphertext, &connectionEnabled)
	if errors.Is(err, pgx.ErrNoRows) {
		return RuntimeCredential{}, ErrNotFound
	}
	if err != nil {
		return RuntimeCredential{}, err
	}
	if !dryRun {
		return service.RuntimeCredentialForAgent(ctx, current, authentication, agentID)
	}
	if connectionID != nil {
		if connectionEnabled == nil || !*connectionEnabled {
			return RuntimeCredential{}, ErrNotFound
		}
		plain, err := service.openLLMConnection(current.OrgID, *connectionID, nonce, ciphertext)
		if err != nil {
			return RuntimeCredential{}, err
		}
		return RuntimeCredential{APIKey: plain}, nil
	}
	return service.RuntimeCredentialForAgent(ctx, current, authentication, agentID)
}

func (service *Service) seal(orgID, agentID, value string) ([]byte, []byte, error) {
	nonce := make([]byte, service.credentialAEAD.NonceSize())
	if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
		return nil, nil, err
	}
	return nonce, service.credentialAEAD.Seal(nil, nonce, []byte(value), aad(orgID, agentID)), nil
}

func (service *Service) open(orgID, agentID string, nonce, ciphertext []byte) (string, error) {
	plain, err := service.credentialAEAD.Open(nil, nonce, ciphertext, aad(orgID, agentID))
	if err != nil {
		return "", fmt.Errorf("decrypt agent provider credential: %w", err)
	}
	return string(plain), nil
}

var mcpNamePattern = regexp.MustCompile(`^[a-z0-9][a-z0-9_-]{0,63}$`)
var mcpToolPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$`)
var headerNamePattern = regexp.MustCompile(`^[!#$%&'*+.^_` + "`" + `|~0-9A-Za-z-]+$`)

func (service *Service) ListMCPServers(ctx context.Context, current identity.User, agentID string) ([]MCPServer, error) {
	if !canManage(current) {
		return nil, ErrForbidden
	}
	if uuid.Validate(agentID) != nil {
		return nil, ErrNotFound
	}
	var exists bool
	if err := service.pool.QueryRow(ctx, `SELECT true FROM agents WHERE org_id=$1 AND actor_id=$2`, current.OrgID, agentID).Scan(&exists); errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	} else if err != nil {
		return nil, err
	}
	rows, err := service.pool.Query(ctx, mcpSelect+` WHERE server.org_id=$1 AND server.agent_id=$2 ORDER BY server.name`, current.OrgID, agentID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := make([]MCPServer, 0)
	for rows.Next() {
		server, err := scanMCPServer(rows)
		if err != nil {
			return nil, err
		}
		result = append(result, server)
	}
	return result, rows.Err()
}

func (service *Service) CreateMCPServer(ctx context.Context, current identity.User, agentID string, input CreateMCPServerInput) (MCPServer, error) {
	if !canManage(current) {
		return MCPServer{}, ErrForbidden
	}
	if input.TimeoutMS == 0 {
		input.TimeoutMS = 10000
	}
	if input.MaxOutputBytes == 0 {
		input.MaxOutputBytes = 262144
	}
	requireConfirmation := true
	if input.RequireWriteConfirmation != nil {
		requireConfirmation = *input.RequireWriteConfirmation
	}
	if uuid.Validate(agentID) != nil || !validMCPConfig(input.Name, input.EndpointURL, input.AllowedTools, input.Headers, input.TimeoutMS, input.MaxOutputBytes) {
		return MCPServer{}, ErrInvalid
	}
	serverID, err := id.New()
	if err != nil {
		return MCPServer{}, err
	}
	encryptedHeaders, err := service.sealMCPHeaders(current.OrgID, agentID, serverID, input.Headers)
	if err != nil {
		return MCPServer{}, err
	}
	tx, err := service.pool.Begin(ctx)
	if err != nil {
		return MCPServer{}, err
	}
	defer tx.Rollback(ctx)
	result, err := tx.Exec(ctx, `INSERT INTO agent_mcp_servers(id,org_id,agent_id,name,endpoint_url,enabled,allowed_tools,encrypted_headers,timeout_ms,max_output_bytes,require_write_confirmation)
		SELECT $3,org_id,actor_id,$4,$5,$6,$7,$8,$9,$10,$11 FROM agents WHERE org_id=$1 AND actor_id=$2`, current.OrgID, agentID, serverID, strings.TrimSpace(input.Name), strings.TrimSpace(input.EndpointURL), input.Enabled, input.AllowedTools, encryptedHeaders, input.TimeoutMS, input.MaxOutputBytes, requireConfirmation)
	if err != nil {
		if isUniqueViolation(err) {
			return MCPServer{}, ErrInvalid
		}
		return MCPServer{}, err
	}
	if result.RowsAffected() != 1 {
		return MCPServer{}, ErrNotFound
	}
	if err := auditMCP(ctx, tx, current, serverID, "create", input.Headers != nil); err != nil {
		return MCPServer{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return MCPServer{}, err
	}
	return service.getMCPServer(ctx, current.OrgID, agentID, serverID)
}

func (service *Service) UpdateMCPServer(ctx context.Context, current identity.User, agentID, serverID string, input UpdateMCPServerInput) (MCPServer, error) {
	if !canManage(current) {
		return MCPServer{}, ErrForbidden
	}
	if uuid.Validate(agentID) != nil || uuid.Validate(serverID) != nil || !hasMCPUpdate(input) {
		return MCPServer{}, ErrInvalid
	}
	tx, err := service.pool.Begin(ctx)
	if err != nil {
		return MCPServer{}, err
	}
	defer tx.Rollback(ctx)
	var currentServer MCPServer
	var encryptedHeaders []byte
	err = tx.QueryRow(ctx, mcpSelect+` WHERE server.org_id=$1 AND server.agent_id=$2 AND server.id=$3 FOR UPDATE`, current.OrgID, agentID, serverID).Scan(mcpScanTargets(&currentServer, &encryptedHeaders)...)
	if errors.Is(err, pgx.ErrNoRows) {
		return MCPServer{}, ErrNotFound
	}
	if err != nil {
		return MCPServer{}, err
	}
	name, endpoint := currentServer.Name, currentServer.EndpointURL
	allowedTools := currentServer.AllowedTools
	timeoutMS, maxOutputBytes := currentServer.TimeoutMS, currentServer.MaxOutputBytes
	if input.Name != nil {
		name = strings.TrimSpace(*input.Name)
	}
	if input.EndpointURL != nil {
		endpoint = strings.TrimSpace(*input.EndpointURL)
	}
	if input.AllowedTools != nil {
		allowedTools = *input.AllowedTools
	}
	if input.TimeoutMS != nil {
		timeoutMS = *input.TimeoutMS
	}
	if input.MaxOutputBytes != nil {
		maxOutputBytes = *input.MaxOutputBytes
	}
	var headers map[string]string
	if input.Headers != nil {
		headers = *input.Headers
	}
	if !validMCPConfig(name, endpoint, allowedTools, headers, timeoutMS, maxOutputBytes) {
		return MCPServer{}, ErrInvalid
	}
	if input.Headers != nil {
		encryptedHeaders, err = service.sealMCPHeaders(current.OrgID, agentID, serverID, headers)
		if err != nil {
			return MCPServer{}, err
		}
	}
	_, err = tx.Exec(ctx, `UPDATE agent_mcp_servers SET
		name=$4,endpoint_url=$5,enabled=COALESCE($6,enabled),allowed_tools=$7,encrypted_headers=$8,timeout_ms=$9,max_output_bytes=$10,
		require_write_confirmation=COALESCE($11,require_write_confirmation),updated_at=now()
		WHERE org_id=$1 AND agent_id=$2 AND id=$3`, current.OrgID, agentID, serverID, name, endpoint, input.Enabled, allowedTools, encryptedHeaders, timeoutMS, maxOutputBytes, input.RequireWriteConfirmation)
	if err != nil {
		if isUniqueViolation(err) {
			return MCPServer{}, ErrInvalid
		}
		return MCPServer{}, err
	}
	if err := auditMCP(ctx, tx, current, serverID, "update", len(encryptedHeaders) > 0); err != nil {
		return MCPServer{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return MCPServer{}, err
	}
	return service.getMCPServer(ctx, current.OrgID, agentID, serverID)
}

func (service *Service) DeleteMCPServer(ctx context.Context, current identity.User, agentID, serverID string) error {
	if !canManage(current) {
		return ErrForbidden
	}
	if uuid.Validate(agentID) != nil || uuid.Validate(serverID) != nil {
		return ErrNotFound
	}
	tx, err := service.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	result, err := tx.Exec(ctx, `DELETE FROM agent_mcp_servers WHERE org_id=$1 AND agent_id=$2 AND id=$3`, current.OrgID, agentID, serverID)
	if err != nil {
		return err
	}
	if result.RowsAffected() != 1 {
		return ErrNotFound
	}
	if err := auditMCP(ctx, tx, current, serverID, "delete", false); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (service *Service) RuntimeMCPServers(ctx context.Context, current identity.User, authentication access.Identity) ([]RuntimeMCPServer, error) {
	if !agentauthz.New().IsRuntime(current, authentication) {
		return nil, ErrForbidden
	}
	return service.RuntimeMCPServersForAgent(ctx, current, authentication, current.ActorID)
}

func (service *Service) RuntimeMCPServersForAgent(ctx context.Context, current identity.User, authentication access.Identity, agentID string) ([]RuntimeMCPServer, error) {
	if !agentauthz.New().CanWork(current, authentication) || uuid.Validate(agentID) != nil {
		return nil, ErrForbidden
	}
	rows, err := service.pool.Query(ctx, `SELECT id,name,endpoint_url,allowed_tools,encrypted_headers,timeout_ms,max_output_bytes,require_write_confirmation
		FROM agent_mcp_servers WHERE org_id=$1 AND agent_id=$2 AND enabled ORDER BY name`, current.OrgID, agentID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := make([]RuntimeMCPServer, 0)
	for rows.Next() {
		var server RuntimeMCPServer
		var encrypted []byte
		if err := rows.Scan(&server.ID, &server.Name, &server.EndpointURL, &server.AllowedTools, &encrypted, &server.TimeoutMS, &server.MaxOutputBytes, &server.RequireWriteConfirmation); err != nil {
			return nil, err
		}
		headers, err := service.openMCPHeaders(current.OrgID, agentID, server.ID, encrypted)
		if err != nil {
			return nil, err
		}
		server.Headers = headers
		result = append(result, server)
	}
	return result, rows.Err()
}

const mcpSelect = `SELECT server.id,server.agent_id,server.name,server.endpoint_url,server.enabled,server.allowed_tools,
	server.encrypted_headers IS NOT NULL,server.timeout_ms,server.max_output_bytes,server.require_write_confirmation,server.created_at,server.updated_at,server.encrypted_headers
	FROM agent_mcp_servers server`

func scanMCPServer(row pgx.Row) (MCPServer, error) {
	var server MCPServer
	var encrypted []byte
	err := row.Scan(mcpScanTargets(&server, &encrypted)...)
	return server, err
}

func mcpScanTargets(server *MCPServer, encrypted *[]byte) []any {
	return []any{&server.ID, &server.AgentID, &server.Name, &server.EndpointURL, &server.Enabled, &server.AllowedTools, &server.HeadersConfigured, &server.TimeoutMS, &server.MaxOutputBytes, &server.RequireWriteConfirmation, &server.CreatedAt, &server.UpdatedAt, encrypted}
}

func (service *Service) getMCPServer(ctx context.Context, orgID, agentID, serverID string) (MCPServer, error) {
	server, err := scanMCPServer(service.pool.QueryRow(ctx, mcpSelect+` WHERE server.org_id=$1 AND server.agent_id=$2 AND server.id=$3`, orgID, agentID, serverID))
	if errors.Is(err, pgx.ErrNoRows) {
		return MCPServer{}, ErrNotFound
	}
	return server, err
}

func validMCPConfig(name, endpoint string, tools []string, headers map[string]string, timeoutMS, maxOutputBytes int) bool {
	if !mcpNamePattern.MatchString(strings.TrimSpace(name)) || timeoutMS < 100 || timeoutMS > 120000 || maxOutputBytes < 1024 || maxOutputBytes > 4194304 || len(tools) > 128 || len(headers) > 32 {
		return false
	}
	parsed, err := url.ParseRequestURI(strings.TrimSpace(endpoint))
	if err != nil || parsed.Scheme != "https" || parsed.Host == "" || parsed.User != nil || parsed.Fragment != "" || unsafeMCPHostname(parsed.Hostname()) {
		return false
	}
	seen := make(map[string]struct{}, len(tools))
	for _, tool := range tools {
		if !mcpToolPattern.MatchString(tool) {
			return false
		}
		if _, exists := seen[tool]; exists {
			return false
		}
		seen[tool] = struct{}{}
	}
	total := 0
	for name, value := range headers {
		canonical := http.CanonicalHeaderKey(name)
		if !headerNamePattern.MatchString(name) || canonical == "Host" || canonical == "Content-Length" || canonical == "Transfer-Encoding" || strings.ContainsAny(value, "\r\n") {
			return false
		}
		total += len(name) + len(value)
	}
	return total <= 16384
}

func unsafeMCPHostname(hostname string) bool {
	host := strings.ToLower(strings.TrimSuffix(strings.TrimSpace(hostname), "."))
	if host == "" || host == "localhost" || strings.HasSuffix(host, ".localhost") || strings.HasSuffix(host, ".local") || strings.HasSuffix(host, ".internal") {
		return true
	}
	address, err := netip.ParseAddr(host)
	if err != nil {
		return false
	}
	address = address.Unmap()
	return address.IsPrivate() || address.IsLoopback() || address.IsLinkLocalUnicast() || address.IsLinkLocalMulticast() || address.IsMulticast() || address.IsUnspecified()
}

func hasMCPUpdate(input UpdateMCPServerInput) bool {
	return input.Name != nil || input.EndpointURL != nil || input.Enabled != nil || input.AllowedTools != nil || input.Headers != nil || input.TimeoutMS != nil || input.MaxOutputBytes != nil || input.RequireWriteConfirmation != nil
}

func (service *Service) sealMCPHeaders(orgID, agentID, serverID string, headers map[string]string) ([]byte, error) {
	if len(headers) == 0 {
		return nil, nil
	}
	plain, err := json.Marshal(headers)
	if err != nil {
		return nil, err
	}
	nonce := make([]byte, service.mcpAEAD.NonceSize())
	if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
		return nil, err
	}
	return append(nonce, service.mcpAEAD.Seal(nil, nonce, plain, mcpAAD(orgID, agentID, serverID))...), nil
}

func (service *Service) openMCPHeaders(orgID, agentID, serverID string, encrypted []byte) (map[string]string, error) {
	if len(encrypted) == 0 {
		return map[string]string{}, nil
	}
	nonceSize := service.mcpAEAD.NonceSize()
	if len(encrypted) <= nonceSize {
		return nil, errors.New("invalid encrypted MCP headers")
	}
	plain, err := service.mcpAEAD.Open(nil, encrypted[:nonceSize], encrypted[nonceSize:], mcpAAD(orgID, agentID, serverID))
	if err != nil {
		return nil, fmt.Errorf("decrypt MCP headers: %w", err)
	}
	var headers map[string]string
	if err := json.Unmarshal(plain, &headers); err != nil {
		return nil, fmt.Errorf("decode MCP headers: %w", err)
	}
	return headers, nil
}

func mcpAAD(orgID, agentID, serverID string) []byte {
	return []byte(orgID + "\x00" + agentID + "\x00" + serverID + "\x001")
}

func auditMCP(ctx context.Context, tx pgx.Tx, current identity.User, serverID, operation string, headersConfigured bool) error {
	auditID, err := id.New()
	if err != nil {
		return err
	}
	metadata, _ := json.Marshal(map[string]any{"operation": operation, "headers_configured": headersConfigured})
	_, err = tx.Exec(ctx, `INSERT INTO audit_log(id,org_id,actor_id,action,target_type,target_id,metadata)
		VALUES($1,$2,$3,'agent.mcp_server.' || $4,'agent_mcp_server',$5,$6)`, auditID, current.OrgID, current.ActorID, operation, serverID, metadata)
	return err
}

func isUniqueViolation(err error) bool {
	var pgErr interface{ SQLState() string }
	return errors.As(err, &pgErr) && pgErr.SQLState() == "23505"
}

func aad(orgID, agentID string) []byte { return []byte(orgID + "\x00" + agentID + "\x001") }
func canManage(current identity.User) bool {
	return agentauthz.New().CanManage(current)
}
func mask(value string) string {
	if len(value) <= 8 {
		return "••••"
	}
	return value[:4] + "••••" + value[len(value)-4:]
}
