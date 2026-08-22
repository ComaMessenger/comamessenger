package agentconfig

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/comamessenger/comamessenger/core/internal/agentauthz"
	"github.com/comamessenger/comamessenger/core/internal/id"
	"github.com/comamessenger/comamessenger/core/internal/identity"
	"github.com/comamessenger/comamessenger/core/internal/permission"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

var ErrConflict = errors.New("agent configuration conflict")

type LLMConnection struct {
	ID            string     `json:"id"`
	Name          string     `json:"name"`
	Provider      string     `json:"provider"`
	EndpointURL   string     `json:"endpoint_url"`
	DefaultModel  string     `json:"default_model"`
	Enabled       bool       `json:"enabled"`
	KeyHint       string     `json:"key_hint"`
	HealthStatus  string     `json:"health_status"`
	LastTestedAt  *time.Time `json:"last_tested_at"`
	LastErrorCode string     `json:"last_error_code"`
	CreatedAt     time.Time  `json:"created_at"`
	UpdatedAt     time.Time  `json:"updated_at"`
}

type CreateLLMConnectionInput struct {
	Name         string `json:"name"`
	Provider     string `json:"provider"`
	EndpointURL  string `json:"endpoint_url"`
	DefaultModel string `json:"default_model"`
	APIKey       string `json:"api_key"`
	Enabled      *bool  `json:"enabled"`
}

type UpdateLLMConnectionInput struct {
	Name         *string `json:"name"`
	Provider     *string `json:"provider"`
	EndpointURL  *string `json:"endpoint_url"`
	DefaultModel *string `json:"default_model"`
	APIKey       *string `json:"api_key"`
	Enabled      *bool   `json:"enabled"`
}

const llmConnectionSelect = `SELECT id,name,provider,endpoint_url,default_model,enabled,key_hint,health_status,last_tested_at,last_error_code,created_at,updated_at FROM agent_llm_connections`

func (service *Service) ListLLMConnections(ctx context.Context, current identity.User) ([]LLMConnection, error) {
	if !canViewLLMConnections(current) {
		return nil, ErrForbidden
	}
	rows, err := service.pool.Query(ctx, llmConnectionSelect+` WHERE org_id=$1 ORDER BY lower(name),id`, current.OrgID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := make([]LLMConnection, 0)
	for rows.Next() {
		connection, err := scanLLMConnection(rows)
		if err != nil {
			return nil, err
		}
		result = append(result, connection)
	}
	return result, rows.Err()
}

func (service *Service) LLMConnection(ctx context.Context, current identity.User, connectionID string) (LLMConnection, error) {
	if !canViewLLMConnections(current) {
		return LLMConnection{}, ErrForbidden
	}
	if uuid.Validate(connectionID) != nil {
		return LLMConnection{}, ErrNotFound
	}
	return service.getLLMConnection(ctx, current.OrgID, connectionID)
}

func (service *Service) CreateLLMConnection(ctx context.Context, current identity.User, input CreateLLMConnectionInput) (LLMConnection, error) {
	if !canManageLLMConnections(current) {
		return LLMConnection{}, ErrForbidden
	}
	name, provider, endpoint, model, apiKey := normalizeLLMConnection(input.Name, input.Provider, input.EndpointURL, input.DefaultModel, input.APIKey)
	if !validLLMConnection(name, provider, endpoint, model, apiKey) {
		return LLMConnection{}, ErrInvalid
	}
	connectionID, err := id.New()
	if err != nil {
		return LLMConnection{}, err
	}
	nonce, ciphertext, err := service.sealLLMConnection(current.OrgID, connectionID, apiKey)
	if err != nil {
		return LLMConnection{}, err
	}
	enabled := true
	if input.Enabled != nil {
		enabled = *input.Enabled
	}
	tx, err := service.pool.Begin(ctx)
	if err != nil {
		return LLMConnection{}, err
	}
	defer tx.Rollback(ctx)
	_, err = tx.Exec(ctx, `INSERT INTO agent_llm_connections(id,org_id,name,provider,endpoint_url,default_model,enabled,nonce,ciphertext,key_hint,created_by,updated_by)
		VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11)`, connectionID, current.OrgID, name, provider, endpoint, model, enabled, nonce, ciphertext, mask(apiKey), current.ActorID)
	if err != nil {
		if isUniqueViolation(err) {
			return LLMConnection{}, ErrInvalid
		}
		return LLMConnection{}, err
	}
	if err := auditLLMConnection(ctx, tx, current, connectionID, "create", map[string]any{"provider": provider}); err != nil {
		return LLMConnection{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return LLMConnection{}, err
	}
	return service.getLLMConnection(ctx, current.OrgID, connectionID)
}

func (service *Service) UpdateLLMConnection(ctx context.Context, current identity.User, connectionID string, input UpdateLLMConnectionInput) (LLMConnection, error) {
	if !canManageLLMConnections(current) {
		return LLMConnection{}, ErrForbidden
	}
	if uuid.Validate(connectionID) != nil || !hasLLMConnectionUpdate(input) {
		return LLMConnection{}, ErrInvalid
	}
	tx, err := service.pool.Begin(ctx)
	if err != nil {
		return LLMConnection{}, err
	}
	defer tx.Rollback(ctx)
	var name, provider, endpoint, model, keyHint string
	var enabled bool
	err = tx.QueryRow(ctx, `SELECT name,provider,endpoint_url,default_model,enabled,key_hint FROM agent_llm_connections WHERE org_id=$1 AND id=$2 FOR UPDATE`, current.OrgID, connectionID).Scan(&name, &provider, &endpoint, &model, &enabled, &keyHint)
	if errors.Is(err, pgx.ErrNoRows) {
		return LLMConnection{}, ErrNotFound
	}
	if err != nil {
		return LLMConnection{}, err
	}
	if input.Name != nil {
		name = strings.TrimSpace(*input.Name)
	}
	if input.Provider != nil {
		provider = strings.ToLower(strings.TrimSpace(*input.Provider))
	}
	if input.EndpointURL != nil {
		endpoint = strings.TrimSpace(*input.EndpointURL)
	}
	if input.DefaultModel != nil {
		model = strings.TrimSpace(*input.DefaultModel)
	}
	if input.Enabled != nil {
		enabled = *input.Enabled
	}
	var nonce, ciphertext []byte
	if input.APIKey != nil {
		apiKey := strings.TrimSpace(*input.APIKey)
		if apiKey == "" || len(apiKey) > 16384 {
			return LLMConnection{}, ErrInvalid
		}
		nonce, ciphertext, err = service.sealLLMConnection(current.OrgID, connectionID, apiKey)
		if err != nil {
			return LLMConnection{}, err
		}
		keyHint = mask(apiKey)
	}
	if !validLLMConnection(name, provider, endpoint, model, "configured") {
		return LLMConnection{}, ErrInvalid
	}
	configurationChanged := input.Provider != nil || input.EndpointURL != nil || input.DefaultModel != nil || input.APIKey != nil
	_, err = tx.Exec(ctx, `UPDATE agent_llm_connections SET name=$3,provider=$4,endpoint_url=$5,default_model=$6,enabled=$7,
		nonce=CASE WHEN $8::bytea IS NULL THEN nonce ELSE $8 END,ciphertext=CASE WHEN $9::bytea IS NULL THEN ciphertext ELSE $9 END,key_hint=$10,
		health_status=CASE WHEN $11 THEN 'untested' ELSE health_status END,last_tested_at=CASE WHEN $11 THEN NULL ELSE last_tested_at END,
		last_error_code=CASE WHEN $11 THEN '' ELSE last_error_code END,updated_by=$12,updated_at=now()
		WHERE org_id=$1 AND id=$2`, current.OrgID, connectionID, name, provider, endpoint, model, enabled, nullableBytes(nonce), nullableBytes(ciphertext), keyHint, configurationChanged, current.ActorID)
	if err != nil {
		if isUniqueViolation(err) {
			return LLMConnection{}, ErrInvalid
		}
		return LLMConnection{}, err
	}
	if err := auditLLMConnection(ctx, tx, current, connectionID, "update", map[string]any{"credential_replaced": input.APIKey != nil}); err != nil {
		return LLMConnection{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return LLMConnection{}, err
	}
	return service.getLLMConnection(ctx, current.OrgID, connectionID)
}

func (service *Service) DeleteLLMConnection(ctx context.Context, current identity.User, connectionID string) error {
	if !canManageLLMConnections(current) {
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
	var agentCount int
	err = tx.QueryRow(ctx, `SELECT count(*) FROM agents WHERE org_id=$1 AND llm_connection_id=$2`, current.OrgID, connectionID).Scan(&agentCount)
	if err != nil {
		return err
	}
	if agentCount > 0 {
		return ErrConflict
	}
	result, err := tx.Exec(ctx, `DELETE FROM agent_llm_connections WHERE org_id=$1 AND id=$2`, current.OrgID, connectionID)
	if err != nil {
		return err
	}
	if result.RowsAffected() != 1 {
		return ErrNotFound
	}
	if err := auditLLMConnection(ctx, tx, current, connectionID, "delete", nil); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (service *Service) TestLLMConnection(ctx context.Context, current identity.User, connectionID string) (LLMConnection, error) {
	if !canManageLLMConnections(current) {
		return LLMConnection{}, ErrForbidden
	}
	if uuid.Validate(connectionID) != nil {
		return LLMConnection{}, ErrNotFound
	}
	var provider, endpoint string
	var nonce, ciphertext []byte
	err := service.pool.QueryRow(ctx, `SELECT provider,endpoint_url,nonce,ciphertext FROM agent_llm_connections WHERE org_id=$1 AND id=$2`, current.OrgID, connectionID).Scan(&provider, &endpoint, &nonce, &ciphertext)
	if errors.Is(err, pgx.ErrNoRows) {
		return LLMConnection{}, ErrNotFound
	}
	if err != nil {
		return LLMConnection{}, err
	}
	apiKey, err := service.openLLMConnection(current.OrgID, connectionID, nonce, ciphertext)
	if err != nil {
		return LLMConnection{}, err
	}
	target, headers, err := llmConnectionTestTarget(provider, endpoint, apiKey)
	if err != nil {
		return LLMConnection{}, ErrInvalid
	}
	testContext, cancel := context.WithTimeout(ctx, 12*time.Second)
	defer cancel()
	request, err := http.NewRequestWithContext(testContext, http.MethodGet, target, nil)
	if err != nil {
		return LLMConnection{}, err
	}
	for name, value := range headers {
		request.Header.Set(name, value)
	}
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.ResponseHeaderTimeout = 10 * time.Second
	defer transport.CloseIdleConnections()
	client := &http.Client{
		Transport: transport,
		Timeout:   12 * time.Second,
		CheckRedirect: func(*http.Request, []*http.Request) error {
			return errors.New("LLM connection redirects are disabled")
		},
	}
	status, errorCode := "healthy", ""
	response, requestErr := client.Do(request)
	if requestErr != nil {
		status, errorCode = "unhealthy", "network_error"
	} else {
		_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 64<<10))
		_ = response.Body.Close()
		if response.StatusCode < 200 || response.StatusCode >= 300 {
			status, errorCode = "unhealthy", providerTestErrorCode(response.StatusCode)
		}
	}
	tx, err := service.pool.Begin(ctx)
	if err != nil {
		return LLMConnection{}, err
	}
	defer tx.Rollback(ctx)
	result, err := tx.Exec(ctx, `UPDATE agent_llm_connections SET health_status=$3,last_tested_at=now(),last_error_code=$4,updated_by=$5,updated_at=now() WHERE org_id=$1 AND id=$2`, current.OrgID, connectionID, status, errorCode, current.ActorID)
	if err != nil {
		return LLMConnection{}, err
	}
	if result.RowsAffected() != 1 {
		return LLMConnection{}, ErrNotFound
	}
	if err := auditLLMConnection(ctx, tx, current, connectionID, "test", map[string]any{"status": status, "error_code": errorCode}); err != nil {
		return LLMConnection{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return LLMConnection{}, err
	}
	return service.getLLMConnection(ctx, current.OrgID, connectionID)
}

func (service *Service) getLLMConnection(ctx context.Context, orgID, connectionID string) (LLMConnection, error) {
	connection, err := scanLLMConnection(service.pool.QueryRow(ctx, llmConnectionSelect+` WHERE org_id=$1 AND id=$2`, orgID, connectionID))
	if errors.Is(err, pgx.ErrNoRows) {
		return LLMConnection{}, ErrNotFound
	}
	return connection, err
}

type llmConnectionScanner interface{ Scan(...any) error }

func scanLLMConnection(row llmConnectionScanner) (LLMConnection, error) {
	var connection LLMConnection
	err := row.Scan(&connection.ID, &connection.Name, &connection.Provider, &connection.EndpointURL, &connection.DefaultModel, &connection.Enabled, &connection.KeyHint, &connection.HealthStatus, &connection.LastTestedAt, &connection.LastErrorCode, &connection.CreatedAt, &connection.UpdatedAt)
	return connection, err
}

func normalizeLLMConnection(name, provider, endpoint, model, apiKey string) (string, string, string, string, string) {
	return strings.TrimSpace(name), strings.ToLower(strings.TrimSpace(provider)), strings.TrimSpace(endpoint), strings.TrimSpace(model), strings.TrimSpace(apiKey)
}

func validLLMConnection(name, provider, endpoint, model, apiKey string) bool {
	if len(name) < 1 || len(name) > 120 || len(model) > 200 || len(apiKey) < 1 || len(apiKey) > 16384 {
		return false
	}
	switch provider {
	case "openai", "anthropic":
		return endpoint == ""
	case "openai-compatible":
		if len(endpoint) > 2048 {
			return false
		}
		parsed, err := url.Parse(endpoint)
		return err == nil && parsed.Host != "" && (parsed.Scheme == "http" || parsed.Scheme == "https") && parsed.User == nil && parsed.Fragment == ""
	default:
		return false
	}
}

func llmConnectionTestTarget(provider, endpoint, apiKey string) (string, map[string]string, error) {
	headers := map[string]string{"Accept": "application/json"}
	switch provider {
	case "openai":
		headers["Authorization"] = "Bearer " + apiKey
		return "https://api.openai.com/v1/models", headers, nil
	case "anthropic":
		headers["x-api-key"] = apiKey
		headers["anthropic-version"] = "2023-06-01"
		return "https://api.anthropic.com/v1/models", headers, nil
	case "openai-compatible":
		parsed, err := url.Parse(strings.TrimSpace(endpoint))
		if err != nil || parsed.Host == "" || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.User != nil {
			return "", nil, ErrInvalid
		}
		headers["Authorization"] = "Bearer " + apiKey
		return strings.TrimRight(parsed.String(), "/") + "/models", headers, nil
	default:
		return "", nil, ErrInvalid
	}
}

func providerTestErrorCode(status int) string {
	switch status {
	case http.StatusUnauthorized:
		return "unauthorized"
	case http.StatusForbidden:
		return "forbidden"
	case http.StatusTooManyRequests:
		return "rate_limited"
	default:
		return "provider_error"
	}
}

func hasLLMConnectionUpdate(input UpdateLLMConnectionInput) bool {
	return input.Name != nil || input.Provider != nil || input.EndpointURL != nil || input.DefaultModel != nil || input.APIKey != nil || input.Enabled != nil
}

func (service *Service) sealLLMConnection(orgID, connectionID, value string) ([]byte, []byte, error) {
	nonce := make([]byte, service.connectionAEAD.NonceSize())
	if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
		return nil, nil, err
	}
	return nonce, service.connectionAEAD.Seal(nil, nonce, []byte(value), llmConnectionAAD(orgID, connectionID)), nil
}

func (service *Service) openLLMConnection(orgID, connectionID string, nonce, ciphertext []byte) (string, error) {
	plain, err := service.connectionAEAD.Open(nil, nonce, ciphertext, llmConnectionAAD(orgID, connectionID))
	if err != nil {
		return "", fmt.Errorf("decrypt LLM connection credential: %w", err)
	}
	return string(plain), nil
}

func llmConnectionAAD(orgID, connectionID string) []byte {
	return []byte(orgID + "\x00" + connectionID + "\x001")
}

func nullableBytes(value []byte) any {
	if len(value) == 0 {
		return nil
	}
	return value
}

func auditLLMConnection(ctx context.Context, tx pgx.Tx, current identity.User, connectionID, operation string, metadata map[string]any) error {
	auditID, err := id.New()
	if err != nil {
		return err
	}
	if metadata == nil {
		metadata = map[string]any{}
	}
	encoded, _ := json.Marshal(metadata)
	_, err = tx.Exec(ctx, `INSERT INTO audit_log(id,org_id,actor_id,action,target_type,target_id,metadata)
		VALUES($1,$2,$3,'agent.llm_connection.' || $4,'agent_llm_connection',$5,$6)`, auditID, current.OrgID, current.ActorID, operation, connectionID, encoded)
	return err
}

func canViewLLMConnections(current identity.User) bool {
	return agentauthz.New().CanManage(current) || canManageLLMConnections(current)
}

func canManageLLMConnections(current identity.User) bool {
	return permission.Allows(current.OrgRole, current.Permissions, permission.IntegrationsManage)
}
