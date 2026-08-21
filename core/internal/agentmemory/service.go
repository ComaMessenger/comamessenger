package agentmemory

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"time"

	"github.com/comamessenger/comamessenger/core/internal/identity"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

var (
	ErrInvalid  = errors.New("invalid agent memory input")
	ErrNotFound = errors.New("agent memory not found")
)

var namespacePattern = regexp.MustCompile(`^[a-z0-9][a-z0-9_.-]{0,63}$`)

type Entry struct {
	Namespace string          `json:"namespace"`
	Key       string          `json:"key"`
	Value     json.RawMessage `json:"value"`
	CreatedAt time.Time       `json:"created_at"`
	UpdatedAt time.Time       `json:"updated_at"`
}

type RecallInput struct {
	Namespace string   `json:"namespace"`
	Keys      []string `json:"keys"`
	Prefix    string   `json:"prefix"`
	Limit     int      `json:"limit"`
}

type Service struct{ pool *pgxpool.Pool }

func NewService(pool *pgxpool.Pool) *Service { return &Service{pool: pool} }

func (service *Service) Remember(ctx context.Context, agent identity.User, namespace, key string, value json.RawMessage) (Entry, error) {
	namespace, key = normalize(namespace, key)
	if !valid(namespace, key) || len(value) == 0 || len(value) > 65536 || !json.Valid(value) {
		return Entry{}, ErrInvalid
	}
	var result Entry
	err := service.pool.QueryRow(ctx, `INSERT INTO agent_memory(org_id,agent_id,namespace,key,value) VALUES($1,$2,$3,$4,$5) ON CONFLICT(agent_id,namespace,key) DO UPDATE SET value=EXCLUDED.value,updated_at=now() RETURNING namespace,key,value,created_at,updated_at`, agent.OrgID, agent.ActorID, namespace, key, value).Scan(&result.Namespace, &result.Key, &result.Value, &result.CreatedAt, &result.UpdatedAt)
	if err != nil {
		return Entry{}, fmt.Errorf("remember agent memory: %w", err)
	}
	return result, nil
}

func (service *Service) Recall(ctx context.Context, agent identity.User, input RecallInput) ([]Entry, error) {
	input.Namespace = strings.ToLower(strings.TrimSpace(input.Namespace))
	if input.Namespace == "" {
		input.Namespace = "default"
	}
	input.Prefix = strings.TrimSpace(input.Prefix)
	if input.Limit == 0 {
		input.Limit = 20
	}
	if !namespacePattern.MatchString(input.Namespace) || len(input.Keys) > 100 || len(input.Prefix) > 255 || input.Limit < 1 || input.Limit > 100 {
		return nil, ErrInvalid
	}
	for _, key := range input.Keys {
		if strings.TrimSpace(key) == "" || len(key) > 255 {
			return nil, ErrInvalid
		}
	}
	rows, err := service.pool.Query(ctx, `SELECT namespace,key,value,created_at,updated_at FROM agent_memory WHERE org_id=$1 AND agent_id=$2 AND namespace=$3 AND (cardinality($4::text[])=0 OR key=ANY($4::text[])) AND ($5='' OR key LIKE $5||'%') ORDER BY key LIMIT $6`, agent.OrgID, agent.ActorID, input.Namespace, input.Keys, input.Prefix, input.Limit)
	if err != nil {
		return nil, fmt.Errorf("recall agent memory: %w", err)
	}
	defer rows.Close()
	result := make([]Entry, 0)
	for rows.Next() {
		var entry Entry
		if err := rows.Scan(&entry.Namespace, &entry.Key, &entry.Value, &entry.CreatedAt, &entry.UpdatedAt); err != nil {
			return nil, err
		}
		result = append(result, entry)
	}
	return result, rows.Err()
}

func (service *Service) Get(ctx context.Context, agent identity.User, namespace, key string) (Entry, error) {
	namespace, key = normalize(namespace, key)
	if !valid(namespace, key) {
		return Entry{}, ErrInvalid
	}
	var result Entry
	err := service.pool.QueryRow(ctx, `SELECT namespace,key,value,created_at,updated_at FROM agent_memory WHERE org_id=$1 AND agent_id=$2 AND namespace=$3 AND key=$4`, agent.OrgID, agent.ActorID, namespace, key).Scan(&result.Namespace, &result.Key, &result.Value, &result.CreatedAt, &result.UpdatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return Entry{}, ErrNotFound
	}
	if err != nil {
		return Entry{}, fmt.Errorf("get agent memory: %w", err)
	}
	return result, nil
}

func normalize(namespace, key string) (string, string) {
	namespace = strings.ToLower(strings.TrimSpace(namespace))
	if namespace == "" {
		namespace = "default"
	}
	return namespace, strings.TrimSpace(key)
}
func valid(namespace, key string) bool {
	return namespacePattern.MatchString(namespace) && len(key) >= 1 && len(key) <= 255
}
