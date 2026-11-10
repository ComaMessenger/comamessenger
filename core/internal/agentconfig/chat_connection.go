package agentconfig

import (
	"context"
	"errors"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// ChatConnection is everything a server-side conversation needs to call a
// chat model through a workspace LLM connection.
type ChatConnection struct {
	ID, Name, Provider, EndpointURL, Model, APIKey string
}

// ErrChatConnectionUnavailable means the connection is missing, disabled or
// has no default model.
var ErrChatConnectionUnavailable = errors.New("chat model connection is not available")

// DefaultChatConnectionID picks the workspace connection a server-side
// assistant uses when the person did not choose one: enabled, with a default
// model, healthy ones first, then the oldest.
func (service *Service) DefaultChatConnectionID(ctx context.Context, orgID string) (string, error) {
	var connectionID string
	err := service.pool.QueryRow(ctx, `SELECT id FROM agent_llm_connections
		WHERE org_id=$1 AND enabled AND default_model<>''
		ORDER BY (health_status='healthy') DESC, (health_status='unhealthy') ASC, created_at, id LIMIT 1`, orgID).Scan(&connectionID)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", ErrChatConnectionUnavailable
	}
	return connectionID, err
}

// ChatConnection resolves an enabled connection with its secret for a
// server-side call. Callers must have authorized the operation already; the
// secret never leaves Core.
func (service *Service) ChatConnection(ctx context.Context, orgID, connectionID string) (ChatConnection, error) {
	if uuid.Validate(connectionID) != nil {
		return ChatConnection{}, ErrChatConnectionUnavailable
	}
	var result ChatConnection
	var enabled bool
	var nonce, ciphertext []byte
	err := service.pool.QueryRow(ctx, `SELECT id,name,provider,endpoint_url,default_model,enabled,nonce,ciphertext
		FROM agent_llm_connections WHERE org_id=$1 AND id=$2`, orgID, connectionID).Scan(&result.ID, &result.Name, &result.Provider, &result.EndpointURL, &result.Model, &enabled, &nonce, &ciphertext)
	if errors.Is(err, pgx.ErrNoRows) {
		return ChatConnection{}, ErrChatConnectionUnavailable
	}
	if err != nil {
		return ChatConnection{}, err
	}
	if !enabled || result.Model == "" {
		return ChatConnection{}, ErrChatConnectionUnavailable
	}
	result.APIKey, err = service.openLLMConnection(orgID, connectionID, nonce, ciphertext)
	if err != nil {
		return ChatConnection{}, err
	}
	return result, nil
}
