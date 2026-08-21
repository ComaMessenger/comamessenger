package agentprovider

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

	"github.com/comamessenger/comamessenger/core/internal/access"
	"github.com/comamessenger/comamessenger/core/internal/agentconfig"
	"github.com/comamessenger/comamessenger/core/internal/agentrun"
	"github.com/comamessenger/comamessenger/core/internal/identity"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

var (
	ErrInvalid     = errors.New("invalid provider proxy request")
	ErrUnsupported = errors.New("unsupported provider")
)

const maxRequestBytes = 2 << 20

type ProxyInput struct {
	CallID     string          `json:"call_id"`
	RunID      string          `json:"run_id"`
	LeaseToken string          `json:"lease_token"`
	Request    json.RawMessage `json:"request"`
}

type Service struct {
	pool       *pgxpool.Pool
	config     *agentconfig.Service
	runs       *agentrun.Service
	httpClient *http.Client
}

type Session struct {
	service        *Service
	current        identity.User
	authentication access.Identity
	call           agentrun.ProviderCall
	leaseToken     string
	observer       usageObserver
}

func NewService(pool *pgxpool.Pool, config *agentconfig.Service, runs *agentrun.Service) *Service {
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.ResponseHeaderTimeout = 45 * time.Second
	return &Service{
		pool:   pool,
		config: config,
		runs:   runs,
		httpClient: &http.Client{
			Transport: transport,
			Timeout:   15 * time.Minute,
			CheckRedirect: func(*http.Request, []*http.Request) error {
				return errors.New("provider redirects are disabled")
			},
		},
	}
}

func (service *Service) Start(ctx context.Context, current identity.User, authentication access.Identity, input ProxyInput) (*http.Response, *Session, error) {
	if len(input.Request) == 0 || len(input.Request) > maxRequestBytes {
		return nil, nil, ErrInvalid
	}
	var payload map[string]any
	if err := json.Unmarshal(input.Request, &payload); err != nil || payload == nil {
		return nil, nil, ErrInvalid
	}
	agentID, err := service.runs.RuntimeAgentID(ctx, current, authentication, input.RunID, input.LeaseToken)
	if err != nil {
		return nil, nil, err
	}
	var endpoint string
	var approved bool
	err = service.pool.QueryRow(ctx, `SELECT endpoint_url,external_data_sharing_approved FROM agents WHERE org_id=$1 AND actor_id=$2 AND deleted_at IS NULL`, current.OrgID, agentID).Scan(&endpoint, &approved)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil, agentrun.ErrNotFound
	}
	if err != nil {
		return nil, nil, err
	}
	if !approved {
		return nil, nil, agentrun.ErrForbidden
	}
	credential, err := service.config.RuntimeCredentialForAgent(ctx, current, authentication, agentID)
	if err != nil {
		return nil, nil, err
	}
	provider, model, maxOutputTokens, err := service.runProvider(ctx, current.OrgID, agentID, input.RunID, input.LeaseToken)
	if err != nil {
		return nil, nil, err
	}
	payload["model"] = model
	payload["stream"] = true
	delete(payload, "max_tokens")
	delete(payload, "max_completion_tokens")
	if provider == "openai" || isOpenAICompatible(provider) {
		payload["stream_options"] = map[string]any{"include_usage": true}
		if provider == "openai" && usesCompletionTokenLimit(model) {
			payload["max_completion_tokens"] = maxOutputTokens
		} else {
			payload["max_tokens"] = maxOutputTokens
		}
	} else {
		payload["max_tokens"] = maxOutputTokens
	}
	encoded, err := json.Marshal(payload)
	if err != nil {
		return nil, nil, ErrInvalid
	}
	requestURL, headers, err := providerTarget(provider, endpoint, credential.APIKey)
	if err != nil {
		return nil, nil, err
	}
	reserved, _ := estimateCost(provider, model, int64(len(encoded)/4), int64(number(payload["max_tokens"])+number(payload["max_completion_tokens"])))
	call, err := service.runs.StartProviderCallServer(ctx, current, authentication, agentrun.StartProviderCallInput{
		CallID: input.CallID, RunID: input.RunID, LeaseToken: input.LeaseToken, ReservedCost: reserved, Currency: "USD",
	}, reserved)
	if err != nil {
		return nil, nil, err
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, requestURL, bytes.NewReader(encoded))
	if err != nil {
		return nil, nil, err
	}
	for name, value := range headers {
		request.Header.Set(name, value)
	}
	response, err := service.httpClient.Do(request)
	session := &Session{service: service, current: current, authentication: authentication, call: call, leaseToken: input.LeaseToken, observer: usageObserver{provider: provider}}
	if err != nil {
		_ = session.Finish(context.Background(), "failed")
		return nil, nil, fmt.Errorf("provider request: %w", err)
	}
	return response, session, nil
}

func (session *Session) Observe(chunk []byte) { session.observer.observe(chunk) }

func (session *Session) Finish(ctx context.Context, status string) error {
	inputTokens, outputTokens := session.observer.usage()
	cost, source := estimateCost(session.call.Provider, session.call.Model, inputTokens, outputTokens)
	if status != "completed" && inputTokens == 0 && outputTokens == 0 {
		cost, source = "0.00000000", "unknown"
	}
	_, err := session.service.runs.FinishProviderCallServer(ctx, session.current, session.authentication, session.call.ID, agentrun.FinishProviderCallInput{
		RunID: session.call.RunID, LeaseToken: session.leaseToken, Status: status, ActualCost: cost, Currency: "USD", InputTokens: inputTokens, OutputTokens: outputTokens, PriceSource: source,
	})
	return err
}

func (service *Service) runProvider(ctx context.Context, orgID, agentID, runID, leaseToken string) (string, string, int, error) {
	var provider, model string
	var maxOutputTokens int
	err := service.pool.QueryRow(ctx, `SELECT run.provider,run.model,agent.max_output_tokens FROM agent_runs run JOIN agents agent ON agent.org_id=run.org_id AND agent.actor_id=run.agent_id WHERE run.org_id=$1 AND run.agent_id=$2 AND run.id=$3 AND run.lease_token=$4 AND run.status='running'`, orgID, agentID, runID, leaseToken).Scan(&provider, &model, &maxOutputTokens)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", "", 0, agentrun.ErrConflict
	}
	return provider, model, maxOutputTokens, err
}

func usesCompletionTokenLimit(model string) bool {
	model = strings.ToLower(strings.TrimSpace(model))
	return strings.HasPrefix(model, "gpt-5") || (len(model) >= 2 && model[0] == 'o' && model[1] >= '1' && model[1] <= '9')
}

func providerTarget(provider, configuredEndpoint, apiKey string) (string, map[string]string, error) {
	headers := map[string]string{"Content-Type": "application/json", "Accept": "text/event-stream"}
	switch strings.ToLower(strings.TrimSpace(provider)) {
	case "openai":
		headers["Authorization"] = "Bearer " + apiKey
		return "https://api.openai.com/v1/chat/completions", headers, nil
	case "anthropic":
		headers["x-api-key"] = apiKey
		headers["anthropic-version"] = "2023-06-01"
		return "https://api.anthropic.com/v1/messages", headers, nil
	case "openai-compatible", "openai_compatible", "ollama", "vllm":
		parsed, err := url.Parse(strings.TrimSpace(configuredEndpoint))
		if err != nil || parsed.Host == "" || (parsed.Scheme != "https" && parsed.Scheme != "http") || parsed.User != nil {
			return "", nil, ErrInvalid
		}
		headers["Authorization"] = "Bearer " + apiKey
		return strings.TrimRight(parsed.String(), "/") + "/chat/completions", headers, nil
	default:
		return "", nil, ErrUnsupported
	}
}

func isOpenAICompatible(provider string) bool {
	provider = strings.ToLower(strings.TrimSpace(provider))
	return provider == "openai-compatible" || provider == "openai_compatible" || provider == "ollama" || provider == "vllm"
}

func number(value any) int {
	switch typed := value.(type) {
	case float64:
		return int(typed)
	case int:
		return typed
	default:
		return 0
	}
}

type usageObserver struct {
	provider string
	buffer   string
	input    int64
	output   int64
}

func (observer *usageObserver) observe(chunk []byte) {
	observer.buffer += string(chunk)
	for {
		index := strings.Index(observer.buffer, "\n\n")
		separator := 2
		if index < 0 {
			index = strings.Index(observer.buffer, "\r\n\r\n")
			separator = 4
		}
		if index < 0 {
			if len(observer.buffer) > 1<<20 {
				observer.buffer = observer.buffer[len(observer.buffer)-(1<<20):]
			}
			return
		}
		event := observer.buffer[:index]
		observer.buffer = observer.buffer[index+separator:]
		var data strings.Builder
		for _, line := range strings.Split(strings.ReplaceAll(event, "\r\n", "\n"), "\n") {
			if strings.HasPrefix(line, "data:") {
				data.WriteString(strings.TrimSpace(strings.TrimPrefix(line, "data:")))
			}
		}
		if data.Len() == 0 || data.String() == "[DONE]" {
			continue
		}
		var payload map[string]any
		if json.Unmarshal([]byte(data.String()), &payload) != nil {
			continue
		}
		observer.readUsage(payload)
	}
}

func (observer *usageObserver) readUsage(payload map[string]any) {
	if usage, ok := payload["usage"].(map[string]any); ok {
		if observer.provider == "anthropic" {
			if value := int64(number(usage["input_tokens"])); value > 0 {
				observer.input = value
			}
			if value := int64(number(usage["output_tokens"])); value > 0 {
				observer.output = value
			}
		} else {
			if value := int64(number(usage["prompt_tokens"])); value > 0 {
				observer.input = value
			}
			if value := int64(number(usage["completion_tokens"])); value > 0 {
				observer.output = value
			}
		}
	}
	if message, ok := payload["message"].(map[string]any); ok {
		if usage, ok := message["usage"].(map[string]any); ok {
			if value := int64(number(usage["input_tokens"])); value > 0 {
				observer.input = value
			}
		}
	}
}

func (observer *usageObserver) usage() (int64, int64) { return observer.input, observer.output }

type price struct{ input, output int64 }

var modelPrices = map[string]price{
	"openai/gpt-5-mini":   {input: 25_000_000, output: 200_000_000},
	"openai/gpt-5.4-mini": {input: 75_000_000, output: 450_000_000},
}

func estimateCost(provider, model string, inputTokens, outputTokens int64) (string, string) {
	rate, found := modelPrices[strings.ToLower(strings.TrimSpace(provider))+"/"+strings.ToLower(strings.TrimSpace(model))]
	if !found {
		return "0.01000000", "estimated"
	}
	// Rates are stored as 1e-8 USD per one million tokens. Integer math keeps
	// accounting deterministic and avoids floating-point drift.
	units := (inputTokens*rate.input + outputTokens*rate.output + 999_999) / 1_000_000
	return fmt.Sprintf("%d.%08d", units/100_000_000, units%100_000_000), "configured"
}

func drainAndClose(body io.ReadCloser) { _, _ = io.Copy(io.Discard, body); _ = body.Close() }
