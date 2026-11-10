package knowledge

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/comamessenger/comamessenger/core/internal/agentconfig"
)

const embeddingBatchSize = 64

// ConnectionResolver opens a workspace LLM connection for embeddings.
// agentconfig.Service implements it.
type ConnectionResolver interface {
	EmbeddingConnection(ctx context.Context, orgID, connectionID string) (agentconfig.EmbeddingConnection, error)
}

// Embedder turns texts into vectors through an embeddings API.
type Embedder interface {
	Embed(ctx context.Context, connection agentconfig.EmbeddingConnection, inputs []string) ([][]float32, error)
}

// HTTPEmbedder calls OpenAI and OpenAI-compatible /embeddings endpoints.
type HTTPEmbedder struct {
	client *http.Client
}

func NewHTTPEmbedder() *HTTPEmbedder {
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.ResponseHeaderTimeout = 60 * time.Second
	return &HTTPEmbedder{client: &http.Client{
		Transport: transport,
		Timeout:   2 * time.Minute,
		CheckRedirect: func(*http.Request, []*http.Request) error {
			return errors.New("embedding provider redirects are disabled")
		},
	}}
}

// ErrEmbeddingRejected is a permanent provider refusal (bad key, unknown
// model, malformed answer) that retrying will not fix.
var ErrEmbeddingRejected = errors.New("embedding provider rejected the request")

func (embedder *HTTPEmbedder) Embed(ctx context.Context, connection agentconfig.EmbeddingConnection, inputs []string) ([][]float32, error) {
	if len(inputs) == 0 {
		return nil, nil
	}
	target, err := embeddingURL(connection.Provider, connection.EndpointURL)
	if err != nil {
		return nil, err
	}
	encoded, err := json.Marshal(map[string]any{"model": connection.Model, "input": inputs})
	if err != nil {
		return nil, err
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, target, bytes.NewReader(encoded))
	if err != nil {
		return nil, err
	}
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Accept", "application/json")
	request.Header.Set("Authorization", "Bearer "+connection.APIKey)
	response, err := embedder.client.Do(request)
	if err != nil {
		return nil, fmt.Errorf("embedding request: %w", err)
	}
	defer response.Body.Close()
	body, err := io.ReadAll(io.LimitReader(response.Body, 64<<20))
	if err != nil {
		return nil, fmt.Errorf("read embedding response: %w", err)
	}
	if response.StatusCode == http.StatusTooManyRequests || response.StatusCode >= 500 {
		return nil, fmt.Errorf("embedding provider status %d", response.StatusCode)
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return nil, fmt.Errorf("%w: status %s", ErrEmbeddingRejected, strconv.Itoa(response.StatusCode))
	}
	var payload struct {
		Data []struct {
			Index     int       `json:"index"`
			Embedding []float32 `json:"embedding"`
		} `json:"data"`
	}
	if err := json.Unmarshal(body, &payload); err != nil || len(payload.Data) != len(inputs) {
		return nil, fmt.Errorf("%w: unexpected embedding response", ErrEmbeddingRejected)
	}
	result := make([][]float32, len(inputs))
	for _, item := range payload.Data {
		if item.Index < 0 || item.Index >= len(inputs) || result[item.Index] != nil || len(item.Embedding) < 1 || len(item.Embedding) > 4096 {
			return nil, fmt.Errorf("%w: invalid embedding vector", ErrEmbeddingRejected)
		}
		result[item.Index] = item.Embedding
	}
	dimensions := len(result[0])
	for _, vector := range result {
		if len(vector) != dimensions {
			return nil, fmt.Errorf("%w: inconsistent embedding dimensions", ErrEmbeddingRejected)
		}
	}
	return result, nil
}

func embeddingURL(provider, endpoint string) (string, error) {
	switch provider {
	case "openai":
		return "https://api.openai.com/v1/embeddings", nil
	case "openai-compatible":
		parsed, err := url.Parse(strings.TrimSpace(endpoint))
		if err != nil || parsed.Host == "" || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.User != nil {
			return "", fmt.Errorf("%w: invalid embedding endpoint", ErrEmbeddingRejected)
		}
		return strings.TrimRight(parsed.String(), "/") + "/embeddings", nil
	default:
		return "", fmt.Errorf("%w: provider %q has no embeddings API", ErrEmbeddingRejected, provider)
	}
}

func vectorLiteral(values []float32) string {
	var builder strings.Builder
	builder.Grow(len(values) * 10)
	builder.WriteByte('[')
	for index, value := range values {
		if index > 0 {
			builder.WriteByte(',')
		}
		builder.WriteString(strconv.FormatFloat(float64(value), 'g', -1, 32))
	}
	builder.WriteByte(']')
	return builder.String()
}
