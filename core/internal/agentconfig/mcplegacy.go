package agentconfig

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"strings"

	"github.com/comamessenger/comamessenger/core/internal/id"
	"github.com/comamessenger/comamessenger/core/internal/identity"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// The per-agent /agents/{id}/mcp-servers API predates workspace connections.
// It stays as a compatibility view: every "server" is a workspace connection
// bound to the agent, written straight into the published bindings (and the
// draft, when one exists), as the old API applied changes immediately.
// Writing requires integrations.manage because the secret now belongs to the
// workspace.

const legacyServerSelect = `SELECT connection.id::text,connection.name,connection.endpoint_url,connection.enabled,binding.value->'allowed_tools',
	connection.encrypted_headers IS NOT NULL,connection.timeout_ms,connection.max_output_bytes,
	COALESCE((binding.value->>'require_write_confirmation')::boolean,true),connection.created_at,connection.updated_at
	FROM agents agent CROSS JOIN LATERAL jsonb_array_elements(agent.mcp_bindings) binding
	JOIN integration_mcp_connections connection ON connection.org_id=agent.org_id AND connection.id::text=binding.value->>'connection_id'`

func scanLegacyServer(row pgx.Row, agentID string) (MCPServer, error) {
	server := MCPServer{AgentID: agentID}
	var tools []byte
	err := row.Scan(&server.ID, &server.Name, &server.EndpointURL, &server.Enabled, &tools, &server.HeadersConfigured, &server.TimeoutMS, &server.MaxOutputBytes,
		&server.RequireWriteConfirmation, &server.CreatedAt, &server.UpdatedAt)
	if err != nil {
		return MCPServer{}, err
	}
	server.AllowedTools = make([]string, 0)
	_ = json.Unmarshal(tools, &server.AllowedTools)
	return server, nil
}

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
	rows, err := service.pool.Query(ctx, legacyServerSelect+` WHERE agent.org_id=$1 AND agent.actor_id=$2 ORDER BY connection.name`, current.OrgID, agentID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := make([]MCPServer, 0)
	for rows.Next() {
		server, err := scanLegacyServer(rows, agentID)
		if err != nil {
			return nil, err
		}
		if !canManageIntegrations(current) {
			server.EndpointURL = endpointHost(server.EndpointURL)
		}
		result = append(result, server)
	}
	return result, rows.Err()
}

func (service *Service) getLegacyServer(ctx context.Context, orgID, agentID, connectionID string) (MCPServer, error) {
	server, err := scanLegacyServer(service.pool.QueryRow(ctx, legacyServerSelect+` WHERE agent.org_id=$1 AND agent.actor_id=$2 AND connection.id=$3`, orgID, agentID, connectionID), agentID)
	if errors.Is(err, pgx.ErrNoRows) {
		return MCPServer{}, ErrNotFound
	}
	return server, err
}

func (service *Service) CreateMCPServer(ctx context.Context, current identity.User, agentID string, input CreateMCPServerInput) (MCPServer, error) {
	if !canManage(current) || !canManageIntegrations(current) {
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
	name := strings.TrimSpace(input.Name)
	if uuid.Validate(agentID) != nil || len(name) > 40 || !validMCPConfig(name, input.EndpointURL, input.AllowedTools, input.Headers, input.TimeoutMS, input.MaxOutputBytes) {
		return MCPServer{}, ErrInvalid
	}
	if _, err := service.policy(false).ValidateURL(input.EndpointURL); err != nil {
		return MCPServer{}, ErrInvalid
	}
	tools := input.AllowedTools
	if tools == nil {
		tools = []string{}
	}
	connectionID, err := id.New()
	if err != nil {
		return MCPServer{}, err
	}
	encrypted, err := service.sealConnectionHeaders(current.OrgID, connectionID, input.Headers)
	if err != nil {
		return MCPServer{}, err
	}
	tx, err := service.pool.Begin(ctx)
	if err != nil {
		return MCPServer{}, err
	}
	defer tx.Rollback(ctx)
	var exists bool
	if err := tx.QueryRow(ctx, `SELECT true FROM agents WHERE org_id=$1 AND actor_id=$2 FOR UPDATE`, current.OrgID, agentID).Scan(&exists); errors.Is(err, pgx.ErrNoRows) {
		return MCPServer{}, ErrNotFound
	} else if err != nil {
		return MCPServer{}, err
	}
	// The old API configured one server per agent, so the connection's policy
	// mirrors that agent's settings and the connection is released for agents.
	if _, err := tx.Exec(ctx, `INSERT INTO integration_mcp_connections(id,org_id,name,endpoint_url,enabled,encrypted_headers,secret_hint,timeout_ms,max_output_bytes,
		agent_use_allowed,writes_require_confirmation,assignable_tools,created_by,updated_by)
		VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,true,$10,$11,$12,$12)`, connectionID, current.OrgID, name, strings.TrimSpace(input.EndpointURL), input.Enabled, encrypted,
		headersHint(input.Headers), input.TimeoutMS, input.MaxOutputBytes, requireConfirmation, tools, current.ActorID); err != nil {
		if isUniqueViolation(err) {
			return MCPServer{}, ErrInvalid
		}
		return MCPServer{}, err
	}
	binding, _ := json.Marshal([]mcpBinding{{ConnectionID: connectionID, AllowedTools: tools, RequireWriteConfirmation: requireConfirmation}})
	if err := setLegacyBinding(ctx, tx, current.OrgID, agentID, connectionID, binding); err != nil {
		return MCPServer{}, err
	}
	if err := auditIntegration(ctx, tx, current, "mcp_connection", connectionID, "create", map[string]any{"legacy_agent_api": true, "agent_id": agentID, "headers_configured": len(input.Headers) > 0}); err != nil {
		return MCPServer{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return MCPServer{}, err
	}
	return service.getLegacyServer(ctx, current.OrgID, agentID, connectionID)
}

// setLegacyBinding replaces the agent's binding for one connection in the
// published configuration and in the draft, if any. An empty binding array
// removes it.
func setLegacyBinding(ctx context.Context, tx pgx.Tx, orgID, agentID, connectionID string, binding []byte) error {
	const replace = `(SELECT COALESCE(jsonb_agg(item),'[]'::jsonb) FROM jsonb_array_elements(mcp_bindings) item WHERE item->>'connection_id'<>$3::text) || $4::jsonb`
	if _, err := tx.Exec(ctx, `UPDATE agents SET mcp_bindings=`+replace+`,updated_at=now() WHERE org_id=$1 AND actor_id=$2`, orgID, agentID, connectionID, binding); err != nil {
		return mapBindingError(err)
	}
	if _, err := tx.Exec(ctx, `UPDATE agent_drafts SET mcp_bindings=`+replace+`,updated_at=now() WHERE org_id=$1 AND agent_id=$2`, orgID, agentID, connectionID, binding); err != nil {
		return mapBindingError(err)
	}
	return nil
}

func mapBindingError(err error) error {
	var pgErr interface{ SQLState() string }
	if errors.As(err, &pgErr) && pgErr.SQLState() == "23514" {
		return ErrInvalid
	}
	return err
}

func (service *Service) UpdateMCPServer(ctx context.Context, current identity.User, agentID, serverID string, input UpdateMCPServerInput) (MCPServer, error) {
	if !canManage(current) || !canManageIntegrations(current) {
		return MCPServer{}, ErrForbidden
	}
	if uuid.Validate(agentID) != nil || uuid.Validate(serverID) != nil || !hasMCPUpdate(input) {
		return MCPServer{}, ErrInvalid
	}
	existing, err := service.getLegacyServer(ctx, current.OrgID, agentID, serverID)
	if err != nil {
		return MCPServer{}, err
	}
	tools := existing.AllowedTools
	if input.AllowedTools != nil {
		tools = *input.AllowedTools
	}
	requireConfirmation := existing.RequireWriteConfirmation
	if input.RequireWriteConfirmation != nil {
		requireConfirmation = *input.RequireWriteConfirmation
	}
	if !validMCPConfig(existing.Name, "https://placeholder.example", tools, nil, existing.TimeoutMS, existing.MaxOutputBytes) {
		return MCPServer{}, ErrInvalid
	}
	if input.Name != nil || input.EndpointURL != nil || input.Enabled != nil || input.Headers != nil || input.TimeoutMS != nil || input.MaxOutputBytes != nil {
		if input.EndpointURL != nil {
			if _, err := service.policy(false).ValidateURL(*input.EndpointURL); err != nil {
				return MCPServer{}, ErrInvalid
			}
		}
		if _, err := service.UpdateMCPConnection(ctx, current, serverID, UpdateMCPConnectionInput{
			Name: input.Name, EndpointURL: input.EndpointURL, Enabled: input.Enabled, Headers: input.Headers, TimeoutMS: input.TimeoutMS, MaxOutputBytes: input.MaxOutputBytes,
		}); err != nil {
			return MCPServer{}, err
		}
	}
	if input.AllowedTools != nil || input.RequireWriteConfirmation != nil {
		tx, err := service.pool.Begin(ctx)
		if err != nil {
			return MCPServer{}, err
		}
		defer tx.Rollback(ctx)
		// The old per-agent API edits the published binding directly, so it
		// may only tighten it: more tools or fewer confirmations go through
		// the builder and a publish. Per-tool choices of kept tools survive.
		var raw []byte
		if err := tx.QueryRow(ctx, `SELECT COALESCE((SELECT item FROM agents, jsonb_array_elements(mcp_bindings) item
			WHERE org_id=$1 AND actor_id=$2 AND item->>'connection_id'=$3::text LIMIT 1),'{}'::jsonb)`, current.OrgID, agentID, serverID).Scan(&raw); err != nil {
			return MCPServer{}, err
		}
		bound := mcpBinding{}
		_ = json.Unmarshal(raw, &bound)
		for _, tool := range tools {
			if !slices.Contains(bound.AllowedTools, tool) {
				return MCPServer{}, fmt.Errorf("%w: adding tools is done in the agent builder and takes effect on publish", ErrInvalid)
			}
		}
		if bound.RequireWriteConfirmation && !requireConfirmation {
			return MCPServer{}, fmt.Errorf("%w: removing confirmations is done in the agent builder and takes effect on publish", ErrInvalid)
		}
		var policy map[string]string
		for tool, mode := range bound.ConfirmationPolicy {
			if slices.Contains(tools, tool) {
				if policy == nil {
					policy = map[string]string{}
				}
				if requireConfirmation && !bound.RequireWriteConfirmation {
					mode = "confirm"
				}
				policy[tool] = mode
			}
		}
		binding, _ := json.Marshal([]mcpBinding{{ConnectionID: serverID, AllowedTools: tools, RequireWriteConfirmation: requireConfirmation, ConfirmationPolicy: policy}})
		if err := setLegacyBinding(ctx, tx, current.OrgID, agentID, serverID, binding); err != nil {
			return MCPServer{}, err
		}
		if _, err := tx.Exec(ctx, `UPDATE integration_mcp_connections SET assignable_tools=$3,writes_require_confirmation=$4,updated_by=$5,updated_at=now()
			WHERE org_id=$1 AND id=$2`, current.OrgID, serverID, tools, requireConfirmation, current.ActorID); err != nil {
			return MCPServer{}, err
		}
		if err := auditIntegration(ctx, tx, current, "mcp_connection", serverID, "bind", map[string]any{"legacy_agent_api": true, "agent_id": agentID, "allowed_tools": tools}); err != nil {
			return MCPServer{}, err
		}
		if err := tx.Commit(ctx); err != nil {
			return MCPServer{}, err
		}
	}
	return service.getLegacyServer(ctx, current.OrgID, agentID, serverID)
}

// DeleteMCPServer unbinds the connection from the agent and removes the
// connection when no other agent uses it.
func (service *Service) DeleteMCPServer(ctx context.Context, current identity.User, agentID, serverID string) error {
	if !canManage(current) || !canManageIntegrations(current) {
		return ErrForbidden
	}
	if uuid.Validate(agentID) != nil || uuid.Validate(serverID) != nil {
		return ErrNotFound
	}
	if _, err := service.getLegacyServer(ctx, current.OrgID, agentID, serverID); err != nil {
		return err
	}
	tx, err := service.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if err := setLegacyBinding(ctx, tx, current.OrgID, agentID, serverID, []byte(`[]`)); err != nil {
		return err
	}
	usage, err := mcpUsage(ctx, tx, current.OrgID, serverID)
	if err != nil {
		return err
	}
	if len(usage) == 0 {
		if _, err := tx.Exec(ctx, `DELETE FROM integration_mcp_connections WHERE org_id=$1 AND id=$2`, current.OrgID, serverID); err != nil {
			return err
		}
	}
	if err := auditIntegration(ctx, tx, current, "mcp_connection", serverID, "unbind", map[string]any{"legacy_agent_api": true, "agent_id": agentID, "deleted": len(usage) == 0}); err != nil {
		return err
	}
	return tx.Commit(ctx)
}
