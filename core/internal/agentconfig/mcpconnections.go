package agentconfig

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"sort"
	"strings"
	"time"

	"github.com/comamessenger/comamessenger/core/internal/access"
	"github.com/comamessenger/comamessenger/core/internal/agentauthz"
	"github.com/comamessenger/comamessenger/core/internal/id"
	"github.com/comamessenger/comamessenger/core/internal/identity"
	"github.com/comamessenger/comamessenger/core/internal/netguard"
	"github.com/comamessenger/comamessenger/core/internal/permission"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// Workspace MCP connections (phase 5.3 H). The connection owns the endpoint
// and the encrypted headers; agents only reference it with a subset of tools
// through mcp_bindings in their draft and published configuration. Secrets are
// never copied into agent rows and never returned to browsers.

// ErrUsageChanged means the confirmed list of affected agents is stale.
var ErrUsageChanged = errors.New("integration usage changed")

type MCPConnection struct {
	ID                  string     `json:"id"`
	Name                string     `json:"name"`
	Description         string     `json:"description"`
	EndpointURL         string     `json:"endpoint_url"`
	Enabled             bool       `json:"enabled"`
	AllowPrivateNetwork bool       `json:"allow_private_network"`
	HeadersConfigured   bool       `json:"headers_configured"`
	SecretHint          string     `json:"secret_hint"`
	TimeoutMS           int        `json:"timeout_ms"`
	MaxOutputBytes      int        `json:"max_output_bytes"`
	Tools               []MCPTool  `json:"tools"`
	ToolsRefreshedAt    *time.Time `json:"tools_refreshed_at"`
	HealthStatus        string     `json:"health_status"`
	LastTestedAt        *time.Time `json:"last_tested_at"`
	LastErrorCode       string     `json:"last_error_code"`
	AgentCount          int        `json:"agent_count"`
	CreatedBy           string     `json:"created_by"`
	CreatedAt           time.Time  `json:"created_at"`
	UpdatedAt           time.Time  `json:"updated_at"`
}

type CreateMCPConnectionInput struct {
	Name                string            `json:"name"`
	Description         string            `json:"description"`
	EndpointURL         string            `json:"endpoint_url"`
	Enabled             *bool             `json:"enabled"`
	AllowPrivateNetwork bool              `json:"allow_private_network"`
	Headers             map[string]string `json:"headers"`
	TimeoutMS           int               `json:"timeout_ms"`
	MaxOutputBytes      int               `json:"max_output_bytes"`
}

type UpdateMCPConnectionInput struct {
	Name                *string            `json:"name"`
	Description         *string            `json:"description"`
	EndpointURL         *string            `json:"endpoint_url"`
	Enabled             *bool              `json:"enabled"`
	AllowPrivateNetwork *bool              `json:"allow_private_network"`
	Headers             *map[string]string `json:"headers"`
	TimeoutMS           *int               `json:"timeout_ms"`
	MaxOutputBytes      *int               `json:"max_output_bytes"`
}

// MCPConnectionUsage is one agent that references a connection.
type MCPConnectionUsage struct {
	AgentID      string   `json:"agent_id"`
	DisplayName  string   `json:"display_name"`
	Published    bool     `json:"published"`
	Draft        bool     `json:"draft"`
	AllowedTools []string `json:"allowed_tools"`
}

type DetachMCPConnectionInput struct {
	// AgentIDs must list exactly the agents currently using the connection:
	// the administrator confirms the impact they have seen.
	AgentIDs []string `json:"agent_ids"`
}

type mcpBinding struct {
	ConnectionID             string   `json:"connection_id"`
	AllowedTools             []string `json:"allowed_tools"`
	RequireWriteConfirmation bool     `json:"require_write_confirmation"`
}

// SetPrivateNetworksAllowed is the deployment switch: when false, no
// connection may reach private networks regardless of its own setting.
func (service *Service) SetPrivateNetworksAllowed(allowed bool) { service.privateNetworks = allowed }

func (service *Service) policy(connectionAllows bool) netguard.Policy {
	return netguard.Policy{AllowPrivate: connectionAllows && service.privateNetworks}
}

func canManageIntegrations(current identity.User) bool {
	return permission.Allows(current.OrgRole, current.Permissions, permission.IntegrationsManage)
}

func canViewIntegrations(current identity.User) bool {
	return canManageIntegrations(current) || agentauthz.New().CanBuild(current)
}

const mcpConnectionSelect = `SELECT connection.id,connection.name,connection.description,connection.endpoint_url,connection.enabled,connection.allow_private_network,
	connection.encrypted_headers IS NOT NULL,connection.secret_hint,connection.timeout_ms,connection.max_output_bytes,connection.tools,connection.tools_refreshed_at,
	connection.health_status,connection.last_tested_at,connection.last_error_code,
	(SELECT count(DISTINCT agent.actor_id) FROM agents agent LEFT JOIN agent_drafts draft ON draft.org_id=agent.org_id AND draft.agent_id=agent.actor_id
	 WHERE agent.org_id=connection.org_id AND agent.deleted_at IS NULL
	   AND (agent.mcp_bindings @> jsonb_build_array(jsonb_build_object('connection_id',connection.id::text))
	     OR draft.mcp_bindings @> jsonb_build_array(jsonb_build_object('connection_id',connection.id::text)))),
	connection.created_by,connection.created_at,connection.updated_at
	FROM integration_mcp_connections connection`

func scanMCPConnection(row pgx.Row) (MCPConnection, error) {
	var connection MCPConnection
	var tools []byte
	err := row.Scan(&connection.ID, &connection.Name, &connection.Description, &connection.EndpointURL, &connection.Enabled, &connection.AllowPrivateNetwork,
		&connection.HeadersConfigured, &connection.SecretHint, &connection.TimeoutMS, &connection.MaxOutputBytes, &tools, &connection.ToolsRefreshedAt,
		&connection.HealthStatus, &connection.LastTestedAt, &connection.LastErrorCode, &connection.AgentCount, &connection.CreatedBy, &connection.CreatedAt, &connection.UpdatedAt)
	if err != nil {
		return MCPConnection{}, err
	}
	connection.Tools = make([]MCPTool, 0)
	_ = json.Unmarshal(tools, &connection.Tools)
	return connection, nil
}

func (service *Service) ListMCPConnections(ctx context.Context, current identity.User) ([]MCPConnection, error) {
	if !canViewIntegrations(current) {
		return nil, ErrForbidden
	}
	rows, err := service.pool.Query(ctx, mcpConnectionSelect+` WHERE connection.org_id=$1 ORDER BY connection.name`, current.OrgID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := make([]MCPConnection, 0)
	for rows.Next() {
		connection, err := scanMCPConnection(rows)
		if err != nil {
			return nil, err
		}
		result = append(result, connection)
	}
	return result, rows.Err()
}

func (service *Service) MCPConnection(ctx context.Context, current identity.User, connectionID string) (MCPConnection, error) {
	if !canViewIntegrations(current) {
		return MCPConnection{}, ErrForbidden
	}
	if uuid.Validate(connectionID) != nil {
		return MCPConnection{}, ErrNotFound
	}
	return service.getMCPConnection(ctx, current.OrgID, connectionID)
}

func (service *Service) getMCPConnection(ctx context.Context, orgID, connectionID string) (MCPConnection, error) {
	connection, err := scanMCPConnection(service.pool.QueryRow(ctx, mcpConnectionSelect+` WHERE connection.org_id=$1 AND connection.id=$2`, orgID, connectionID))
	if errors.Is(err, pgx.ErrNoRows) {
		return MCPConnection{}, ErrNotFound
	}
	return connection, err
}

func (service *Service) validMCPConnection(name, description, endpoint string, allowPrivate bool, headers map[string]string, timeoutMS, maxOutputBytes int) bool {
	if len(name) > 40 || len([]rune(description)) > 500 {
		return false
	}
	if !validMCPConfig(name, "https://placeholder.example", nil, headers, timeoutMS, maxOutputBytes) {
		return false
	}
	if allowPrivate && !service.privateNetworks {
		return false
	}
	_, err := service.policy(allowPrivate).ValidateURL(endpoint)
	return err == nil
}

func (service *Service) CreateMCPConnection(ctx context.Context, current identity.User, input CreateMCPConnectionInput) (MCPConnection, error) {
	if !canManageIntegrations(current) {
		return MCPConnection{}, ErrForbidden
	}
	if input.TimeoutMS == 0 {
		input.TimeoutMS = 10000
	}
	if input.MaxOutputBytes == 0 {
		input.MaxOutputBytes = 262144
	}
	name, description, endpoint := strings.TrimSpace(input.Name), strings.TrimSpace(input.Description), strings.TrimSpace(input.EndpointURL)
	if !service.validMCPConnection(name, description, endpoint, input.AllowPrivateNetwork, input.Headers, input.TimeoutMS, input.MaxOutputBytes) {
		return MCPConnection{}, ErrInvalid
	}
	connectionID, err := id.New()
	if err != nil {
		return MCPConnection{}, err
	}
	encrypted, err := service.sealConnectionHeaders(current.OrgID, connectionID, input.Headers)
	if err != nil {
		return MCPConnection{}, err
	}
	enabled := true
	if input.Enabled != nil {
		enabled = *input.Enabled
	}
	tx, err := service.pool.Begin(ctx)
	if err != nil {
		return MCPConnection{}, err
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, `INSERT INTO integration_mcp_connections(id,org_id,name,description,endpoint_url,enabled,allow_private_network,encrypted_headers,secret_hint,
		timeout_ms,max_output_bytes,created_by,updated_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$12)`,
		connectionID, current.OrgID, name, description, endpoint, enabled, input.AllowPrivateNetwork, encrypted, headersHint(input.Headers),
		input.TimeoutMS, input.MaxOutputBytes, current.ActorID); err != nil {
		if isUniqueViolation(err) {
			return MCPConnection{}, ErrInvalid
		}
		return MCPConnection{}, err
	}
	if err := auditIntegration(ctx, tx, current, "mcp_connection", connectionID, "create", map[string]any{
		"name": name, "endpoint_host": endpointHost(endpoint), "allow_private_network": input.AllowPrivateNetwork, "headers_configured": len(input.Headers) > 0, "enabled": enabled,
	}); err != nil {
		return MCPConnection{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return MCPConnection{}, err
	}
	return service.getMCPConnection(ctx, current.OrgID, connectionID)
}

func (service *Service) UpdateMCPConnection(ctx context.Context, current identity.User, connectionID string, input UpdateMCPConnectionInput) (MCPConnection, error) {
	if !canManageIntegrations(current) {
		return MCPConnection{}, ErrForbidden
	}
	if uuid.Validate(connectionID) != nil {
		return MCPConnection{}, ErrNotFound
	}
	if input.Name == nil && input.Description == nil && input.EndpointURL == nil && input.Enabled == nil && input.AllowPrivateNetwork == nil &&
		input.Headers == nil && input.TimeoutMS == nil && input.MaxOutputBytes == nil {
		return MCPConnection{}, ErrInvalid
	}
	tx, err := service.pool.Begin(ctx)
	if err != nil {
		return MCPConnection{}, err
	}
	defer tx.Rollback(ctx)
	var name, description, endpoint, hint string
	var enabled, allowPrivate bool
	var timeoutMS, maxOutputBytes int
	var encrypted []byte
	var legacyAgentID *string
	err = tx.QueryRow(ctx, `SELECT name,description,endpoint_url,enabled,allow_private_network,timeout_ms,max_output_bytes,encrypted_headers,secret_hint,legacy_agent_id::text
		FROM integration_mcp_connections WHERE org_id=$1 AND id=$2 FOR UPDATE`, current.OrgID, connectionID).Scan(
		&name, &description, &endpoint, &enabled, &allowPrivate, &timeoutMS, &maxOutputBytes, &encrypted, &hint, &legacyAgentID)
	if errors.Is(err, pgx.ErrNoRows) {
		return MCPConnection{}, ErrNotFound
	}
	if err != nil {
		return MCPConnection{}, err
	}
	previousName := name
	if input.Name != nil {
		name = strings.TrimSpace(*input.Name)
	}
	if input.Description != nil {
		description = strings.TrimSpace(*input.Description)
	}
	if input.EndpointURL != nil {
		endpoint = strings.TrimSpace(*input.EndpointURL)
	}
	if input.Enabled != nil {
		enabled = *input.Enabled
	}
	if input.AllowPrivateNetwork != nil {
		allowPrivate = *input.AllowPrivateNetwork
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
	// Migrated names may be up to 64 characters; only a new name is held to
	// the shorter limit.
	checkName := name
	if name == previousName && len(name) > 40 {
		checkName = name[:40]
	}
	if !service.validMCPConnection(checkName, description, endpoint, allowPrivate, headers, timeoutMS, maxOutputBytes) {
		return MCPConnection{}, ErrInvalid
	}
	if input.Headers != nil {
		encrypted, err = service.sealConnectionHeaders(current.OrgID, connectionID, headers)
		if err != nil {
			return MCPConnection{}, err
		}
		hint, legacyAgentID = headersHint(headers), nil
	}
	endpointChanged := input.EndpointURL != nil || input.Headers != nil || input.AllowPrivateNetwork != nil
	if _, err := tx.Exec(ctx, `UPDATE integration_mcp_connections SET name=$3,description=$4,endpoint_url=$5,enabled=$6,allow_private_network=$7,
		encrypted_headers=$8,secret_hint=$9,legacy_agent_id=$10,timeout_ms=$11,max_output_bytes=$12,updated_by=$13,updated_at=now(),
		health_status=CASE WHEN $14 THEN 'untested' ELSE health_status END,last_error_code=CASE WHEN $14 THEN '' ELSE last_error_code END,
		last_tested_at=CASE WHEN $14 THEN NULL ELSE last_tested_at END
		WHERE org_id=$1 AND id=$2`, current.OrgID, connectionID, name, description, endpoint, enabled, allowPrivate,
		encrypted, hint, legacyAgentID, timeoutMS, maxOutputBytes, current.ActorID, endpointChanged); err != nil {
		if isUniqueViolation(err) {
			return MCPConnection{}, ErrInvalid
		}
		return MCPConnection{}, err
	}
	if err := auditIntegration(ctx, tx, current, "mcp_connection", connectionID, "update", map[string]any{
		"name": name, "endpoint_host": endpointHost(endpoint), "enabled": enabled, "allow_private_network": allowPrivate,
		"headers_replaced": input.Headers != nil, "endpoint_changed": input.EndpointURL != nil,
	}); err != nil {
		return MCPConnection{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return MCPConnection{}, err
	}
	return service.getMCPConnection(ctx, current.OrgID, connectionID)
}

// DeleteMCPConnection removes an unused connection. A connection referenced
// by any agent draft or published configuration is refused with
// ErrConflict; it can be disabled or detached explicitly instead.
func (service *Service) DeleteMCPConnection(ctx context.Context, current identity.User, connectionID string) error {
	if !canManageIntegrations(current) {
		return ErrForbidden
	}
	if uuid.Validate(connectionID) != nil {
		return ErrNotFound
	}
	tx, err := service.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, `SELECT 1 FROM integration_mcp_connections WHERE org_id=$1 AND id=$2 FOR UPDATE`, current.OrgID, connectionID); err != nil {
		return err
	}
	usage, err := mcpUsage(ctx, tx, current.OrgID, connectionID)
	if err != nil {
		return err
	}
	if len(usage) > 0 {
		return ErrConflict
	}
	result, err := tx.Exec(ctx, `DELETE FROM integration_mcp_connections WHERE org_id=$1 AND id=$2`, current.OrgID, connectionID)
	if err != nil {
		return err
	}
	if result.RowsAffected() != 1 {
		return ErrNotFound
	}
	if err := auditIntegration(ctx, tx, current, "mcp_connection", connectionID, "delete", nil); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// MCPConnectionUsage lists the agents whose draft or published configuration
// references the connection.
func (service *Service) MCPConnectionUsage(ctx context.Context, current identity.User, connectionID string) ([]MCPConnectionUsage, error) {
	if !canViewIntegrations(current) {
		return nil, ErrForbidden
	}
	if _, err := service.MCPConnection(ctx, current, connectionID); err != nil {
		return nil, err
	}
	tx, err := service.pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	return mcpUsage(ctx, tx, current.OrgID, connectionID)
}

func mcpUsage(ctx context.Context, tx pgx.Tx, orgID, connectionID string) ([]MCPConnectionUsage, error) {
	rows, err := tx.Query(ctx, `SELECT agent.actor_id::text,actor.display_name,
		agent.mcp_bindings @> jsonb_build_array(jsonb_build_object('connection_id',$2::text)),
		COALESCE(draft.mcp_bindings @> jsonb_build_array(jsonb_build_object('connection_id',$2::text)),false),
		COALESCE((SELECT binding->'allowed_tools' FROM jsonb_array_elements(COALESCE(draft.mcp_bindings,agent.mcp_bindings)||agent.mcp_bindings) binding
			WHERE binding->>'connection_id'=$2::text LIMIT 1),'[]'::jsonb)
		FROM agents agent JOIN actors actor ON actor.org_id=agent.org_id AND actor.id=agent.actor_id
		LEFT JOIN agent_drafts draft ON draft.org_id=agent.org_id AND draft.agent_id=agent.actor_id
		WHERE agent.org_id=$1 AND agent.deleted_at IS NULL
		  AND (agent.mcp_bindings @> jsonb_build_array(jsonb_build_object('connection_id',$2::text))
		    OR draft.mcp_bindings @> jsonb_build_array(jsonb_build_object('connection_id',$2::text)))
		ORDER BY lower(actor.display_name),agent.actor_id`, orgID, connectionID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := make([]MCPConnectionUsage, 0)
	for rows.Next() {
		var item MCPConnectionUsage
		var tools []byte
		if err := rows.Scan(&item.AgentID, &item.DisplayName, &item.Published, &item.Draft, &tools); err != nil {
			return nil, err
		}
		item.AllowedTools = make([]string, 0)
		_ = json.Unmarshal(tools, &item.AllowedTools)
		result = append(result, item)
	}
	return result, rows.Err()
}

// DetachMCPConnection removes the connection from every agent draft and
// published configuration. The caller confirms the impact by listing the
// affected agents; a different set means someone changed usage meanwhile.
func (service *Service) DetachMCPConnection(ctx context.Context, current identity.User, connectionID string, input DetachMCPConnectionInput) ([]MCPConnectionUsage, error) {
	if !canManageIntegrations(current) {
		return nil, ErrForbidden
	}
	if uuid.Validate(connectionID) != nil {
		return nil, ErrNotFound
	}
	tx, err := service.pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	var exists bool
	if err := tx.QueryRow(ctx, `SELECT true FROM integration_mcp_connections WHERE org_id=$1 AND id=$2 FOR UPDATE`, current.OrgID, connectionID).Scan(&exists); errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	} else if err != nil {
		return nil, err
	}
	usage, err := mcpUsage(ctx, tx, current.OrgID, connectionID)
	if err != nil {
		return nil, err
	}
	affected := make([]string, len(usage))
	for index, item := range usage {
		affected[index] = item.AgentID
	}
	confirmed := append([]string(nil), input.AgentIDs...)
	sort.Strings(affected)
	sort.Strings(confirmed)
	if strings.Join(affected, ",") != strings.Join(confirmed, ",") {
		return usage, ErrUsageChanged
	}
	const strip = `(SELECT COALESCE(jsonb_agg(binding),'[]'::jsonb) FROM jsonb_array_elements(%s) binding WHERE binding->>'connection_id'<>$2::text)`
	if _, err := tx.Exec(ctx, fmt.Sprintf(`UPDATE agents SET mcp_bindings=`+strip+`,updated_at=now() WHERE org_id=$1 AND mcp_bindings @> jsonb_build_array(jsonb_build_object('connection_id',$2::text))`, "mcp_bindings"), current.OrgID, connectionID); err != nil {
		return nil, err
	}
	if _, err := tx.Exec(ctx, fmt.Sprintf(`UPDATE agent_drafts SET mcp_bindings=`+strip+`,updated_at=now() WHERE org_id=$1 AND mcp_bindings @> jsonb_build_array(jsonb_build_object('connection_id',$2::text))`, "mcp_bindings"), current.OrgID, connectionID); err != nil {
		return nil, err
	}
	if err := auditIntegration(ctx, tx, current, "mcp_connection", connectionID, "detach", map[string]any{"agent_ids": affected}); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return usage, nil
}

// TestMCPConnection initializes an MCP session, refreshes the tool catalog and
// records health. It never calls a tool.
func (service *Service) TestMCPConnection(ctx context.Context, current identity.User, connectionID string) (MCPConnection, error) {
	if !canManageIntegrations(current) {
		return MCPConnection{}, ErrForbidden
	}
	if uuid.Validate(connectionID) != nil {
		return MCPConnection{}, ErrNotFound
	}
	target, err := service.loadMCPTarget(ctx, current.OrgID, connectionID)
	if err != nil {
		return MCPConnection{}, err
	}
	status, errorCode := "healthy", ""
	var tools []MCPTool
	client, err := newMCPClient(target.endpoint, target.headers, service.policy(target.allowPrivate), time.Duration(target.timeoutMS)*time.Millisecond, target.maxOutputBytes)
	if err == nil {
		testContext, cancel := context.WithTimeout(ctx, time.Duration(target.timeoutMS)*time.Millisecond+2*time.Second)
		tools, err = client.listTools(testContext)
		cancel()
		client.close()
	}
	if err != nil {
		status, errorCode = "unhealthy", MCPErrorCode(err)
	}
	tx, err := service.pool.Begin(ctx)
	if err != nil {
		return MCPConnection{}, err
	}
	defer tx.Rollback(ctx)
	var encodedTools []byte
	if tools != nil {
		encodedTools, _ = json.Marshal(tools)
	}
	result, err := tx.Exec(ctx, `UPDATE integration_mcp_connections SET health_status=$3,last_error_code=$4,last_tested_at=now(),
		tools=COALESCE($5::jsonb,tools),tools_refreshed_at=CASE WHEN $5::jsonb IS NULL THEN tools_refreshed_at ELSE now() END,updated_at=now()
		WHERE org_id=$1 AND id=$2`, current.OrgID, connectionID, status, errorCode, encodedTools)
	if err != nil {
		return MCPConnection{}, err
	}
	if result.RowsAffected() != 1 {
		return MCPConnection{}, ErrNotFound
	}
	if err := auditIntegration(ctx, tx, current, "mcp_connection", connectionID, "test", map[string]any{"status": status, "error_code": errorCode, "tools": len(tools)}); err != nil {
		return MCPConnection{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return MCPConnection{}, err
	}
	return service.getMCPConnection(ctx, current.OrgID, connectionID)
}

type mcpTarget struct {
	name, endpoint            string
	allowPrivate, enabled     bool
	headers                   map[string]string
	timeoutMS, maxOutputBytes int
	tools                     []MCPTool
	toolsKnown                bool
}

func (service *Service) loadMCPTarget(ctx context.Context, orgID, connectionID string) (mcpTarget, error) {
	var target mcpTarget
	var encrypted, tools []byte
	var legacyAgentID *string
	var refreshed *time.Time
	err := service.pool.QueryRow(ctx, `SELECT name,endpoint_url,allow_private_network,enabled,encrypted_headers,legacy_agent_id::text,timeout_ms,max_output_bytes,tools,tools_refreshed_at
		FROM integration_mcp_connections WHERE org_id=$1 AND id=$2`, orgID, connectionID).Scan(
		&target.name, &target.endpoint, &target.allowPrivate, &target.enabled, &encrypted, &legacyAgentID, &target.timeoutMS, &target.maxOutputBytes, &tools, &refreshed)
	if errors.Is(err, pgx.ErrNoRows) {
		return mcpTarget{}, ErrNotFound
	}
	if err != nil {
		return mcpTarget{}, err
	}
	target.headers, err = service.openConnectionHeaders(orgID, connectionID, legacyAgentID, encrypted)
	if err != nil {
		return mcpTarget{}, err
	}
	_ = json.Unmarshal(tools, &target.tools)
	target.toolsKnown = refreshed != nil
	return target, nil
}

// RuntimeMCPServersForRun returns decrypted MCP configurations for the
// bindings of the run: the draft snapshot of a dry run, otherwise the agent's
// published bindings. Only enabled connections are returned.
func (service *Service) RuntimeMCPServersForRun(ctx context.Context, current identity.User, authentication access.Identity, agentID, runID string) ([]RuntimeMCPServer, error) {
	if !agentauthz.New().CanWork(current, authentication) || uuid.Validate(agentID) != nil || uuid.Validate(runID) != nil {
		return nil, ErrForbidden
	}
	rows, err := service.pool.Query(ctx, `SELECT connection.id::text,connection.name,connection.endpoint_url,connection.allow_private_network,connection.encrypted_headers,
		connection.legacy_agent_id::text,connection.timeout_ms,connection.max_output_bytes,binding.value
		FROM agent_runs run JOIN agents agent ON agent.org_id=run.org_id AND agent.actor_id=run.agent_id
		CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN run.dry_run AND run.agent_config ? 'mcp_bindings' THEN run.agent_config->'mcp_bindings' ELSE agent.mcp_bindings END) binding
		JOIN integration_mcp_connections connection ON connection.org_id=run.org_id AND connection.id::text=binding.value->>'connection_id' AND connection.enabled
		WHERE run.org_id=$1 AND run.agent_id=$2 AND run.id=$3 AND agent.deleted_at IS NULL
		ORDER BY connection.name`, current.OrgID, agentID, runID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := make([]RuntimeMCPServer, 0)
	for rows.Next() {
		var server RuntimeMCPServer
		var encrypted, encodedBinding []byte
		var legacyAgentID *string
		if err := rows.Scan(&server.ID, &server.Name, &server.EndpointURL, &server.AllowPrivateNetwork, &encrypted, &legacyAgentID, &server.TimeoutMS, &server.MaxOutputBytes, &encodedBinding); err != nil {
			return nil, err
		}
		var binding mcpBinding
		if err := json.Unmarshal(encodedBinding, &binding); err != nil {
			return nil, err
		}
		server.AllowPrivateNetwork = server.AllowPrivateNetwork && service.privateNetworks
		server.AllowedTools = binding.AllowedTools
		if server.AllowedTools == nil {
			server.AllowedTools = []string{}
		}
		server.RequireWriteConfirmation = binding.RequireWriteConfirmation
		server.Headers, err = service.openConnectionHeaders(current.OrgID, server.ID, legacyAgentID, encrypted)
		if err != nil {
			return nil, err
		}
		result = append(result, server)
	}
	return result, rows.Err()
}

// ExecuteConfirmedMCPCall runs a write tool after a person approved it. The
// agent's current published bindings must still allow the tool.
func (service *Service) ExecuteConfirmedMCPCall(ctx context.Context, orgID, agentID, connectionID, exposedName string, arguments json.RawMessage) (json.RawMessage, error) {
	if uuid.Validate(connectionID) != nil || uuid.Validate(agentID) != nil {
		return nil, mcpFailure("mcp_tool_not_allowed")
	}
	var bindings []byte
	err := service.pool.QueryRow(ctx, `SELECT mcp_bindings FROM agents WHERE org_id=$1 AND actor_id=$2 AND deleted_at IS NULL AND enabled`, orgID, agentID).Scan(&bindings)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, mcpFailure("mcp_tool_not_allowed")
	}
	if err != nil {
		return nil, err
	}
	target, err := service.loadMCPTarget(ctx, orgID, connectionID)
	if errors.Is(err, ErrNotFound) {
		return nil, mcpFailure("mcp_tool_not_allowed")
	}
	if err != nil {
		return nil, err
	}
	toolName, found := strings.CutPrefix(exposedName, "mcp__"+target.name+"__")
	if !found || !target.enabled || !bindingAllows(bindings, connectionID, toolName) {
		return nil, mcpFailure("mcp_tool_not_allowed")
	}
	client, err := newMCPClient(target.endpoint, target.headers, service.policy(target.allowPrivate), time.Duration(target.timeoutMS)*time.Millisecond, target.maxOutputBytes)
	if err != nil {
		return nil, err
	}
	defer client.close()
	callContext, cancel := context.WithTimeout(ctx, 2*time.Duration(target.timeoutMS)*time.Millisecond)
	defer cancel()
	return client.callTool(callContext, toolName, arguments)
}

func bindingAllows(encoded []byte, connectionID, toolName string) bool {
	var bindings []mcpBinding
	if err := json.Unmarshal(encoded, &bindings); err != nil {
		return false
	}
	for _, binding := range bindings {
		if binding.ConnectionID != connectionID {
			continue
		}
		for _, tool := range binding.AllowedTools {
			if tool == toolName {
				return true
			}
		}
	}
	return false
}

func headersHint(headers map[string]string) string {
	if len(headers) == 0 {
		return ""
	}
	names := make([]string, 0, len(headers))
	for name := range headers {
		names = append(names, name)
	}
	sort.Strings(names)
	hint := http.CanonicalHeaderKey(names[0]) + ": " + mask(headers[names[0]])
	if len(names) > 1 {
		hint += fmt.Sprintf(" +%d", len(names)-1)
	}
	if len(hint) > 200 {
		hint = hint[:200]
	}
	return hint
}

func endpointHost(endpoint string) string {
	parsed, err := netguard.Policy{AllowPrivate: true}.ValidateURL(endpoint)
	if err != nil {
		return ""
	}
	return parsed.Host
}

func (service *Service) sealConnectionHeaders(orgID, connectionID string, headers map[string]string) ([]byte, error) {
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
	return append(nonce, service.mcpAEAD.Seal(nil, nonce, plain, connectionAAD(orgID, connectionID))...), nil
}

// openConnectionHeaders decrypts headers; rows migrated from
// agent_mcp_servers keep their per-agent associated data until replaced.
func (service *Service) openConnectionHeaders(orgID, connectionID string, legacyAgentID *string, encrypted []byte) (map[string]string, error) {
	if len(encrypted) == 0 {
		return map[string]string{}, nil
	}
	aad := connectionAAD(orgID, connectionID)
	if legacyAgentID != nil {
		aad = mcpAAD(orgID, *legacyAgentID, connectionID)
	}
	nonceSize := service.mcpAEAD.NonceSize()
	if len(encrypted) <= nonceSize {
		return nil, errors.New("invalid encrypted MCP headers")
	}
	plain, err := service.mcpAEAD.Open(nil, encrypted[:nonceSize], encrypted[nonceSize:], aad)
	if err != nil {
		return nil, fmt.Errorf("decrypt MCP headers: %w", err)
	}
	var headers map[string]string
	if err := json.Unmarshal(plain, &headers); err != nil {
		return nil, fmt.Errorf("decode MCP headers: %w", err)
	}
	return headers, nil
}

func connectionAAD(orgID, connectionID string) []byte {
	return []byte(orgID + "\x00mcp-connection\x00" + connectionID + "\x001")
}

func auditIntegration(ctx context.Context, tx pgx.Tx, current identity.User, targetType, targetID, operation string, metadata map[string]any) error {
	auditID, err := id.New()
	if err != nil {
		return err
	}
	if metadata == nil {
		metadata = map[string]any{}
	}
	encoded, _ := json.Marshal(metadata)
	_, err = tx.Exec(ctx, `INSERT INTO audit_log(id,org_id,actor_id,action,target_type,target_id,metadata)
		VALUES($1,$2,$3,'integration.' || $4 || '.' || $5,'integration_' || $4,$6,$7)`, auditID, current.OrgID, current.ActorID, targetType, operation, targetID, encoded)
	return err
}
