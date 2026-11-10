package agentconfig

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/comamessenger/comamessenger/core/internal/netguard"
)

// MCPTool is one tool advertised by an MCP server, as last seen by Core.
type MCPTool struct {
	Name        string `json:"name"`
	Description string `json:"description"`
	// ReadOnly mirrors the server's readOnlyHint. Tools without it are
	// treated as writes.
	ReadOnly bool `json:"read_only"`
}

// MCPError carries a stable code for health reporting and tool results.
type MCPError struct{ Code string }

func (err *MCPError) Error() string { return "mcp: " + err.Code }

// ErrorCode exposes the stable code to callers that classify tool errors.
func (err *MCPError) ErrorCode() string { return err.Code }

func mcpFailure(code string) error { return &MCPError{Code: code} }

// MCPErrorCode returns the stable code of an MCP failure.
func MCPErrorCode(err error) string {
	var mcpErr *MCPError
	if errors.As(err, &mcpErr) {
		return mcpErr.Code
	}
	return "mcp_call_failed"
}

// mcpClient speaks the streamable HTTP transport of MCP (JSON-RPC over POST,
// JSON or event-stream responses) through the SSRF-guarded HTTP client.
type mcpClient struct {
	http      *http.Client
	endpoint  string
	headers   map[string]string
	maxBytes  int
	sessionID string
	requestID int
	ready     bool
}

func newMCPClient(endpoint string, headers map[string]string, policy netguard.Policy, timeout time.Duration, maxBytes int) (*mcpClient, error) {
	scoped, _, err := policy.ForURL(endpoint)
	if err != nil {
		return nil, mcpFailure("mcp_endpoint_forbidden")
	}
	return &mcpClient{http: scoped.Client(timeout), endpoint: endpoint, headers: headers, maxBytes: maxBytes}, nil
}

func (client *mcpClient) close() {
	if transport, ok := client.http.Transport.(*http.Transport); ok {
		transport.CloseIdleConnections()
	}
}

func (client *mcpClient) initialize(ctx context.Context) error {
	if client.ready {
		return nil
	}
	if _, err := client.request(ctx, "initialize", map[string]any{
		"protocolVersion": "2025-03-26",
		"capabilities":    map[string]any{},
		"clientInfo":      map[string]any{"name": "comamessenger-core", "version": "0.1.0"},
	}); err != nil {
		return err
	}
	if _, err := client.send(ctx, map[string]any{"jsonrpc": "2.0", "method": "notifications/initialized"}, true); err != nil {
		return err
	}
	client.ready = true
	return nil
}

func (client *mcpClient) listTools(ctx context.Context) ([]MCPTool, error) {
	if err := client.initialize(ctx); err != nil {
		return nil, err
	}
	result := make([]MCPTool, 0)
	cursor := ""
	for page := 0; page < 10; page++ {
		params := map[string]any{}
		if cursor != "" {
			params["cursor"] = cursor
		}
		raw, err := client.request(ctx, "tools/list", params)
		if err != nil {
			return nil, err
		}
		var listed struct {
			Tools []struct {
				Name        string `json:"name"`
				Description string `json:"description"`
				Annotations struct {
					ReadOnlyHint *bool `json:"readOnlyHint"`
				} `json:"annotations"`
			} `json:"tools"`
			NextCursor string `json:"nextCursor"`
		}
		if err := json.Unmarshal(raw, &listed); err != nil {
			return nil, mcpFailure("mcp_invalid_response")
		}
		for _, tool := range listed.Tools {
			if !mcpToolPattern.MatchString(tool.Name) || len(result) >= 256 {
				continue
			}
			description := strings.TrimSpace(tool.Description)
			if len([]rune(description)) > 500 {
				description = string([]rune(description)[:500])
			}
			result = append(result, MCPTool{Name: tool.Name, Description: description, ReadOnly: tool.Annotations.ReadOnlyHint != nil && *tool.Annotations.ReadOnlyHint})
		}
		if listed.NextCursor == "" {
			break
		}
		cursor = listed.NextCursor
	}
	return result, nil
}

func (client *mcpClient) callTool(ctx context.Context, name string, arguments json.RawMessage) (json.RawMessage, error) {
	if err := client.initialize(ctx); err != nil {
		return nil, err
	}
	if len(arguments) == 0 {
		arguments = json.RawMessage(`{}`)
	}
	return client.request(ctx, "tools/call", map[string]any{"name": name, "arguments": arguments})
}

func (client *mcpClient) request(ctx context.Context, method string, params map[string]any) (json.RawMessage, error) {
	client.requestID++
	identifier := client.requestID
	response, err := client.send(ctx, map[string]any{"jsonrpc": "2.0", "id": identifier, "method": method, "params": params}, false)
	if err != nil {
		return nil, err
	}
	var decoded struct {
		ID     *int            `json:"id"`
		Result json.RawMessage `json:"result"`
		Error  *struct {
			Code int `json:"code"`
		} `json:"error"`
	}
	if err := json.Unmarshal(response, &decoded); err != nil || decoded.ID == nil || *decoded.ID != identifier {
		return nil, mcpFailure("mcp_invalid_response")
	}
	if decoded.Error != nil {
		return nil, mcpFailure("mcp_rpc_error")
	}
	return decoded.Result, nil
}

func (client *mcpClient) send(ctx context.Context, payload map[string]any, notification bool) (json.RawMessage, error) {
	body, err := json.Marshal(payload)
	if err != nil {
		return nil, err
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, client.endpoint, bytes.NewReader(body))
	if err != nil {
		return nil, mcpFailure("mcp_endpoint_forbidden")
	}
	for name, value := range client.headers {
		request.Header.Set(name, value)
	}
	request.Header.Set("Accept", "application/json, text/event-stream")
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("MCP-Protocol-Version", "2025-03-26")
	if client.sessionID != "" {
		request.Header.Set("Mcp-Session-Id", client.sessionID)
	}
	response, err := client.http.Do(request)
	if err != nil {
		switch {
		case errors.Is(err, netguard.ErrForbidden):
			return nil, mcpFailure("mcp_endpoint_forbidden")
		case errors.Is(err, netguard.ErrRedirect):
			return nil, mcpFailure("mcp_redirect_refused")
		case errors.Is(err, context.DeadlineExceeded) || errors.Is(ctx.Err(), context.DeadlineExceeded):
			return nil, mcpFailure("mcp_timeout")
		default:
			var timeout interface{ Timeout() bool }
			if errors.As(err, &timeout) && timeout.Timeout() {
				return nil, mcpFailure("mcp_timeout")
			}
			return nil, mcpFailure("mcp_transport_error")
		}
	}
	defer response.Body.Close()
	if session := response.Header.Get("Mcp-Session-Id"); session != "" && len(session) <= 256 {
		client.sessionID = session
	}
	data, err := io.ReadAll(io.LimitReader(response.Body, int64(client.maxBytes)+1))
	if err != nil {
		return nil, mcpFailure("mcp_transport_error")
	}
	if len(data) > client.maxBytes {
		return nil, mcpFailure("mcp_output_too_large")
	}
	if notification && (response.StatusCode == http.StatusAccepted || response.StatusCode == http.StatusNoContent || len(data) == 0) {
		return nil, nil
	}
	switch {
	case response.StatusCode == http.StatusUnauthorized || response.StatusCode == http.StatusForbidden:
		return nil, mcpFailure("mcp_unauthorized")
	case response.StatusCode < 200 || response.StatusCode >= 300:
		return nil, mcpFailure("mcp_http_error")
	}
	if strings.Contains(response.Header.Get("Content-Type"), "text/event-stream") {
		return firstEventData(data)
	}
	return data, nil
}

func firstEventData(body []byte) (json.RawMessage, error) {
	normalized := strings.ReplaceAll(string(body), "\r\n", "\n")
	for _, event := range strings.Split(normalized, "\n\n") {
		var lines []string
		for _, line := range strings.Split(event, "\n") {
			if strings.HasPrefix(line, "data:") {
				lines = append(lines, strings.TrimPrefix(strings.TrimPrefix(line, "data:"), " "))
			}
		}
		if len(lines) > 0 {
			return json.RawMessage(strings.Join(lines, "\n")), nil
		}
	}
	return nil, fmt.Errorf("%w", mcpFailure("mcp_invalid_response"))
}
