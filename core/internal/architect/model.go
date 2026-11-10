package architect

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// ErrModel is a failure of the language model call: network, provider error
// or an answer Core could not read. The conversation stays as it was.
var ErrModel = errors.New("architect model call failed")

// Message is one entry of the model transcript. Role is "user", "assistant"
// or "tool"; a tool message answers ToolCallID.
type Message struct {
	Role       string     `json:"role"`
	Text       string     `json:"text,omitempty"`
	ToolCalls  []ToolCall `json:"tool_calls,omitempty"`
	ToolCallID string     `json:"tool_call_id,omitempty"`
}

type ToolCall struct {
	ID        string          `json:"id"`
	Name      string          `json:"name"`
	Arguments json.RawMessage `json:"arguments"`
}

type ToolSpec struct {
	Name        string
	Description string
	Parameters  map[string]any
}

type ModelRequest struct {
	Provider, EndpointURL, APIKey, Model string
	System                               string
	Messages                             []Message
	Tools                                []ToolSpec
	MaxOutputTokens                      int
}

type ModelResponse struct {
	Text         string
	ToolCalls    []ToolCall
	InputTokens  int64
	OutputTokens int64
}

// Model is the chat model the Architect talks to. Production uses
// HTTPModel; tests script the answers.
type Model interface {
	Complete(ctx context.Context, request ModelRequest) (ModelResponse, error)
}

// HTTPModel calls OpenAI, OpenAI-compatible and Anthropic chat APIs without
// streaming. Redirects are refused, as in the runtime provider gateway.
type HTTPModel struct{ client *http.Client }

func NewHTTPModel() *HTTPModel {
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.ResponseHeaderTimeout = 90 * time.Second
	return &HTTPModel{client: &http.Client{
		Transport: transport,
		Timeout:   2 * time.Minute,
		CheckRedirect: func(*http.Request, []*http.Request) error {
			return errors.New("provider redirects are disabled")
		},
	}}
}

const maxModelResponseBytes = 4 << 20

func (model *HTTPModel) Complete(ctx context.Context, request ModelRequest) (ModelResponse, error) {
	provider := strings.ToLower(strings.TrimSpace(request.Provider))
	var target string
	var body any
	headers := map[string]string{"Content-Type": "application/json", "Accept": "application/json"}
	switch provider {
	case "anthropic":
		target = "https://api.anthropic.com/v1/messages"
		headers["x-api-key"] = request.APIKey
		headers["anthropic-version"] = "2023-06-01"
		body = anthropicBody(request)
	case "openai", "openai-compatible", "openai_compatible", "ollama", "vllm":
		target = "https://api.openai.com/v1/chat/completions"
		if provider != "openai" {
			parsed, err := url.Parse(strings.TrimSpace(request.EndpointURL))
			if err != nil || parsed.Host == "" || (parsed.Scheme != "https" && parsed.Scheme != "http") || parsed.User != nil {
				return ModelResponse{}, fmt.Errorf("%w: invalid endpoint", ErrModel)
			}
			target = strings.TrimRight(parsed.String(), "/") + "/chat/completions"
		}
		headers["Authorization"] = "Bearer " + request.APIKey
		body = openAIBody(request, provider == "openai")
	default:
		return ModelResponse{}, fmt.Errorf("%w: unsupported provider", ErrModel)
	}
	encoded, err := json.Marshal(body)
	if err != nil {
		return ModelResponse{}, err
	}
	httpRequest, err := http.NewRequestWithContext(ctx, http.MethodPost, target, bytes.NewReader(encoded))
	if err != nil {
		return ModelResponse{}, err
	}
	for name, value := range headers {
		httpRequest.Header.Set(name, value)
	}
	response, err := model.client.Do(httpRequest)
	if err != nil {
		return ModelResponse{}, fmt.Errorf("%w: %v", ErrModel, err)
	}
	defer response.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(response.Body, maxModelResponseBytes))
	if err != nil {
		return ModelResponse{}, fmt.Errorf("%w: %v", ErrModel, err)
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return ModelResponse{}, fmt.Errorf("%w: provider status %d", ErrModel, response.StatusCode)
	}
	if provider == "anthropic" {
		return parseAnthropic(raw)
	}
	return parseOpenAI(raw)
}

func openAIBody(request ModelRequest, official bool) map[string]any {
	messages := []map[string]any{{"role": "system", "content": request.System}}
	for _, message := range request.Messages {
		switch message.Role {
		case "tool":
			messages = append(messages, map[string]any{"role": "tool", "tool_call_id": message.ToolCallID, "content": message.Text})
		case "assistant":
			entry := map[string]any{"role": "assistant", "content": message.Text}
			if len(message.ToolCalls) > 0 {
				calls := make([]map[string]any, 0, len(message.ToolCalls))
				for _, call := range message.ToolCalls {
					calls = append(calls, map[string]any{"id": call.ID, "type": "function", "function": map[string]any{"name": call.Name, "arguments": string(call.Arguments)}})
				}
				entry["tool_calls"] = calls
			}
			messages = append(messages, entry)
		default:
			messages = append(messages, map[string]any{"role": "user", "content": message.Text})
		}
	}
	tools := make([]map[string]any, 0, len(request.Tools))
	for _, tool := range request.Tools {
		tools = append(tools, map[string]any{"type": "function", "function": map[string]any{"name": tool.Name, "description": tool.Description, "parameters": tool.Parameters}})
	}
	body := map[string]any{"model": request.Model, "messages": messages}
	if len(tools) > 0 {
		body["tools"] = tools
	}
	if official && usesCompletionTokenLimit(request.Model) {
		body["max_completion_tokens"] = request.MaxOutputTokens
	} else {
		body["max_tokens"] = request.MaxOutputTokens
	}
	return body
}

func parseOpenAI(raw []byte) (ModelResponse, error) {
	var decoded struct {
		Choices []struct {
			Message struct {
				Content   *string `json:"content"`
				ToolCalls []struct {
					ID       string `json:"id"`
					Function struct {
						Name      string `json:"name"`
						Arguments string `json:"arguments"`
					} `json:"function"`
				} `json:"tool_calls"`
			} `json:"message"`
		} `json:"choices"`
		Usage struct {
			PromptTokens     int64 `json:"prompt_tokens"`
			CompletionTokens int64 `json:"completion_tokens"`
		} `json:"usage"`
	}
	if err := json.Unmarshal(raw, &decoded); err != nil || len(decoded.Choices) == 0 {
		return ModelResponse{}, fmt.Errorf("%w: unreadable answer", ErrModel)
	}
	choice := decoded.Choices[0].Message
	result := ModelResponse{InputTokens: decoded.Usage.PromptTokens, OutputTokens: decoded.Usage.CompletionTokens}
	if choice.Content != nil {
		result.Text = *choice.Content
	}
	for _, call := range choice.ToolCalls {
		arguments := json.RawMessage(call.Function.Arguments)
		if !json.Valid(arguments) {
			arguments = json.RawMessage(`{}`)
		}
		result.ToolCalls = append(result.ToolCalls, ToolCall{ID: call.ID, Name: call.Function.Name, Arguments: arguments})
	}
	return result, nil
}

func anthropicBody(request ModelRequest) map[string]any {
	messages := make([]map[string]any, 0, len(request.Messages))
	appendBlock := func(role string, block map[string]any) {
		if count := len(messages); count > 0 && messages[count-1]["role"] == role {
			messages[count-1]["content"] = append(messages[count-1]["content"].([]map[string]any), block)
			return
		}
		messages = append(messages, map[string]any{"role": role, "content": []map[string]any{block}})
	}
	for _, message := range request.Messages {
		switch message.Role {
		case "tool":
			appendBlock("user", map[string]any{"type": "tool_result", "tool_use_id": message.ToolCallID, "content": message.Text})
		case "assistant":
			if message.Text != "" {
				appendBlock("assistant", map[string]any{"type": "text", "text": message.Text})
			}
			for _, call := range message.ToolCalls {
				var input any = map[string]any{}
				_ = json.Unmarshal(call.Arguments, &input)
				appendBlock("assistant", map[string]any{"type": "tool_use", "id": call.ID, "name": call.Name, "input": input})
			}
		default:
			appendBlock("user", map[string]any{"type": "text", "text": message.Text})
		}
	}
	tools := make([]map[string]any, 0, len(request.Tools))
	for _, tool := range request.Tools {
		tools = append(tools, map[string]any{"name": tool.Name, "description": tool.Description, "input_schema": tool.Parameters})
	}
	body := map[string]any{"model": request.Model, "system": request.System, "messages": messages, "max_tokens": request.MaxOutputTokens}
	if len(tools) > 0 {
		body["tools"] = tools
	}
	return body
}

func parseAnthropic(raw []byte) (ModelResponse, error) {
	var decoded struct {
		Content []struct {
			Type  string          `json:"type"`
			Text  string          `json:"text"`
			ID    string          `json:"id"`
			Name  string          `json:"name"`
			Input json.RawMessage `json:"input"`
		} `json:"content"`
		Usage struct {
			InputTokens  int64 `json:"input_tokens"`
			OutputTokens int64 `json:"output_tokens"`
		} `json:"usage"`
	}
	if err := json.Unmarshal(raw, &decoded); err != nil {
		return ModelResponse{}, fmt.Errorf("%w: unreadable answer", ErrModel)
	}
	result := ModelResponse{InputTokens: decoded.Usage.InputTokens, OutputTokens: decoded.Usage.OutputTokens}
	var text []string
	for _, block := range decoded.Content {
		switch block.Type {
		case "text":
			text = append(text, block.Text)
		case "tool_use":
			arguments := block.Input
			if len(arguments) == 0 || !json.Valid(arguments) {
				arguments = json.RawMessage(`{}`)
			}
			result.ToolCalls = append(result.ToolCalls, ToolCall{ID: block.ID, Name: block.Name, Arguments: arguments})
		}
	}
	result.Text = strings.Join(text, "\n")
	return result, nil
}

func usesCompletionTokenLimit(model string) bool {
	model = strings.ToLower(strings.TrimSpace(model))
	return strings.HasPrefix(model, "gpt-5") || (len(model) >= 2 && model[0] == 'o' && model[1] >= '1' && model[1] <= '9')
}
