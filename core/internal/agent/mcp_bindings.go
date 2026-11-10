package agent

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"slices"
	"sort"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// MCPBinding assigns a workspace MCP connection to an agent version with
// the subset of its tools the agent may call. Secrets stay on the connection.
type MCPBinding struct {
	ConnectionID string   `json:"connection_id"`
	AllowedTools []string `json:"allowed_tools"`
	// RequireWriteConfirmation sends every non read-only tool call to a
	// person for approval before Core executes it. Omitted means true; the
	// connection's own policy can force it on but never off.
	RequireWriteConfirmation bool `json:"require_write_confirmation"`
}

// UnmarshalJSON treats a missing require_write_confirmation as true.
func (binding *MCPBinding) UnmarshalJSON(data []byte) error {
	type plain MCPBinding
	decoded := plain{RequireWriteConfirmation: true}
	if err := json.Unmarshal(data, &decoded); err != nil {
		return err
	}
	*binding = MCPBinding(decoded)
	return nil
}

const maxMCPBindings = 64

var mcpToolNamePattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$`)

func normalizeMCPBindings(input []MCPBinding) ([]MCPBinding, error) {
	if len(input) > maxMCPBindings {
		return nil, fmt.Errorf("%w: too many MCP connections", ErrInvalid)
	}
	seen := make(map[string]struct{}, len(input))
	result := make([]MCPBinding, 0, len(input))
	for _, binding := range input {
		parsed, err := uuid.Parse(strings.TrimSpace(binding.ConnectionID))
		if err != nil {
			return nil, fmt.Errorf("%w: invalid MCP connection", ErrInvalid)
		}
		connectionID := parsed.String()
		if _, exists := seen[connectionID]; exists {
			return nil, fmt.Errorf("%w: duplicate MCP connection", ErrInvalid)
		}
		seen[connectionID] = struct{}{}
		if len(binding.AllowedTools) > 128 {
			return nil, fmt.Errorf("%w: too many MCP tools", ErrInvalid)
		}
		tools := make([]string, 0, len(binding.AllowedTools))
		known := make(map[string]struct{}, len(binding.AllowedTools))
		for _, tool := range binding.AllowedTools {
			if !mcpToolNamePattern.MatchString(tool) {
				return nil, fmt.Errorf("%w: invalid MCP tool name", ErrInvalid)
			}
			if _, exists := known[tool]; exists {
				continue
			}
			known[tool] = struct{}{}
			tools = append(tools, tool)
		}
		sort.Strings(tools)
		result = append(result, MCPBinding{ConnectionID: connectionID, AllowedTools: tools, RequireWriteConfirmation: binding.RequireWriteConfirmation})
	}
	sort.Slice(result, func(left, right int) bool { return result[left].ConnectionID < result[right].ConnectionID })
	return result, nil
}

// validateMCPBindings enforces the connection policy chosen by
// integrations.manage: the connection must be released for agents, every
// tool must be assignable and, once Core knows the server's catalog, offered
// by the server. A connection that requires confirmation for writes forces it
// on in the binding.
func validateMCPBindings(ctx context.Context, tx pgx.Tx, orgID string, bindings []MCPBinding) error {
	for index, binding := range bindings {
		var agentUse, writesConfirmed, catalogKnown bool
		var assignable []string
		var catalog []byte
		err := tx.QueryRow(ctx, `SELECT agent_use_allowed,writes_require_confirmation,assignable_tools,tools,tools_refreshed_at IS NOT NULL
			FROM integration_mcp_connections WHERE org_id=$1 AND id=$2`, orgID, binding.ConnectionID).Scan(&agentUse, &writesConfirmed, &assignable, &catalog, &catalogKnown)
		if errors.Is(err, pgx.ErrNoRows) {
			return fmt.Errorf("%w: every MCP connection must belong to the organization", ErrInvalid)
		}
		if err != nil {
			return fmt.Errorf("validate MCP connections: %w", err)
		}
		if !agentUse {
			return fmt.Errorf("%w: the MCP connection is not released for agents", ErrInvalid)
		}
		var offered []struct {
			Name string `json:"name"`
		}
		_ = json.Unmarshal(catalog, &offered)
		for _, tool := range binding.AllowedTools {
			if assignable != nil && !slices.Contains(assignable, tool) {
				return fmt.Errorf("%w: tool %s is not assignable to agents", ErrInvalid, tool)
			}
			if catalogKnown && !slices.ContainsFunc(offered, func(item struct {
				Name string `json:"name"`
			}) bool {
				return item.Name == tool
			}) {
				return fmt.Errorf("%w: the MCP server does not offer tool %s", ErrInvalid, tool)
			}
		}
		if writesConfirmed {
			bindings[index].RequireWriteConfirmation = true
		}
	}
	return nil
}

// existingMCPBindings drops bindings to connections deleted since a version
// was published, so a rollback never references a missing connection.
func existingMCPBindings(ctx context.Context, tx pgx.Tx, orgID string, bindings []MCPBinding) ([]MCPBinding, error) {
	if len(bindings) == 0 {
		return []MCPBinding{}, nil
	}
	var present []string
	if err := tx.QueryRow(ctx, `SELECT COALESCE(array_agg(id::text),'{}'::text[]) FROM integration_mcp_connections WHERE org_id=$1 AND id=ANY($2::uuid[])`, orgID, bindingConnectionIDs(bindings)).Scan(&present); err != nil {
		return nil, fmt.Errorf("resolve version MCP connections: %w", err)
	}
	keep := make(map[string]struct{}, len(present))
	for _, value := range present {
		keep[value] = struct{}{}
	}
	result := make([]MCPBinding, 0, len(bindings))
	for _, binding := range bindings {
		if _, exists := keep[binding.ConnectionID]; exists {
			result = append(result, binding)
		}
	}
	return result, nil
}

func bindingConnectionIDs(bindings []MCPBinding) []string {
	ids := make([]string, len(bindings))
	for index, binding := range bindings {
		ids[index] = binding.ConnectionID
	}
	return ids
}

func bindingsOrEmpty(bindings []MCPBinding) []MCPBinding {
	if bindings == nil {
		return []MCPBinding{}
	}
	return bindings
}

func bindingsJSON(bindings []MCPBinding) []byte {
	encoded, _ := json.Marshal(bindingsOrEmpty(bindings))
	return encoded
}
