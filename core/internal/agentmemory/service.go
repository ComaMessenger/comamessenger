package agentmemory

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"regexp"
	"strconv"
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
	Namespace      string          `json:"namespace"`
	Key            string          `json:"key"`
	Value          json.RawMessage `json:"value"`
	EmbeddingModel string          `json:"embedding_model,omitempty"`
	Similarity     *float64        `json:"similarity,omitempty"`
	CreatedAt      time.Time       `json:"created_at"`
	UpdatedAt      time.Time       `json:"updated_at"`
}

type RememberInput struct {
	Namespace      string          `json:"namespace"`
	Key            string          `json:"key"`
	Value          json.RawMessage `json:"value"`
	EmbeddingModel string          `json:"embedding_model"`
	Embedding      []float64       `json:"embedding"`
}

type RecallInput struct {
	Namespace      string    `json:"namespace"`
	Keys           []string  `json:"keys"`
	Prefix         string    `json:"prefix"`
	Limit          int       `json:"limit"`
	EmbeddingModel string    `json:"embedding_model"`
	QueryEmbedding []float64 `json:"query_embedding"`
}

type Service struct{ pool *pgxpool.Pool }

func NewService(pool *pgxpool.Pool) *Service { return &Service{pool: pool} }

func (service *Service) Remember(ctx context.Context, agent identity.User, input RememberInput) (Entry, error) {
	input.Namespace, input.Key = normalize(input.Namespace, input.Key)
	input.EmbeddingModel = strings.TrimSpace(input.EmbeddingModel)
	if !valid(input.Namespace, input.Key) || len(input.Value) == 0 || len(input.Value) > 65536 || !json.Valid(input.Value) || !validEmbedding(input.EmbeddingModel, input.Embedding) {
		return Entry{}, ErrInvalid
	}
	var dimensions any
	var embedding any
	if len(input.Embedding) > 0 {
		dimensions = len(input.Embedding)
		embedding = vectorLiteral(input.Embedding)
	}
	var result Entry
	err := service.pool.QueryRow(ctx, `INSERT INTO agent_memory(org_id,agent_id,namespace,key,value,embedding_model,embedding_dimensions,embedding)
		VALUES($1,$2,$3,$4,$5,NULLIF($6,''),$7,$8::vector)
		ON CONFLICT(agent_id,namespace,key) DO UPDATE SET value=EXCLUDED.value,embedding_model=EXCLUDED.embedding_model,
		embedding_dimensions=EXCLUDED.embedding_dimensions,embedding=EXCLUDED.embedding,updated_at=now()
		RETURNING namespace,key,value,COALESCE(embedding_model,''),created_at,updated_at`, agent.OrgID, agent.ActorID, input.Namespace, input.Key, input.Value, input.EmbeddingModel, dimensions, embedding).Scan(&result.Namespace, &result.Key, &result.Value, &result.EmbeddingModel, &result.CreatedAt, &result.UpdatedAt)
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
	input.EmbeddingModel = strings.TrimSpace(input.EmbeddingModel)
	if input.Limit == 0 {
		input.Limit = 20
	}
	if !namespacePattern.MatchString(input.Namespace) || len(input.Keys) > 100 || len(input.Prefix) > 255 || input.Limit < 1 || input.Limit > 100 || !validEmbedding(input.EmbeddingModel, input.QueryEmbedding) {
		return nil, ErrInvalid
	}
	for _, key := range input.Keys {
		if strings.TrimSpace(key) == "" || len(key) > 255 {
			return nil, ErrInvalid
		}
	}
	var rows pgx.Rows
	var err error
	vectorSearch := len(input.QueryEmbedding) > 0
	if vectorSearch {
		rows, err = service.pool.Query(ctx, `SELECT namespace,key,value,COALESCE(embedding_model,''),1-(embedding <=> $4::vector) AS similarity,created_at,updated_at
			FROM agent_memory WHERE org_id=$1 AND agent_id=$2 AND namespace=$3 AND embedding IS NOT NULL
			AND embedding_dimensions=$5 AND embedding_model=$6 ORDER BY embedding <=> $4::vector,key LIMIT $7`, agent.OrgID, agent.ActorID, input.Namespace, vectorLiteral(input.QueryEmbedding), len(input.QueryEmbedding), input.EmbeddingModel, input.Limit)
	} else {
		rows, err = service.pool.Query(ctx, `SELECT namespace,key,value,COALESCE(embedding_model,''),NULL::float8,created_at,updated_at FROM agent_memory WHERE org_id=$1 AND agent_id=$2 AND namespace=$3 AND (cardinality($4::text[])=0 OR key=ANY($4::text[])) AND ($5='' OR key LIKE $5||'%') ORDER BY key LIMIT $6`, agent.OrgID, agent.ActorID, input.Namespace, input.Keys, input.Prefix, input.Limit)
	}
	if err != nil {
		return nil, fmt.Errorf("recall agent memory: %w", err)
	}
	defer rows.Close()
	result := make([]Entry, 0)
	for rows.Next() {
		var entry Entry
		if err := rows.Scan(&entry.Namespace, &entry.Key, &entry.Value, &entry.EmbeddingModel, &entry.Similarity, &entry.CreatedAt, &entry.UpdatedAt); err != nil {
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
	err := service.pool.QueryRow(ctx, `SELECT namespace,key,value,COALESCE(embedding_model,''),created_at,updated_at FROM agent_memory WHERE org_id=$1 AND agent_id=$2 AND namespace=$3 AND key=$4`, agent.OrgID, agent.ActorID, namespace, key).Scan(&result.Namespace, &result.Key, &result.Value, &result.EmbeddingModel, &result.CreatedAt, &result.UpdatedAt)
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

func validEmbedding(model string, embedding []float64) bool {
	if len(embedding) == 0 {
		return model == ""
	}
	if model == "" || len(model) > 200 || len(embedding) > 4096 {
		return false
	}
	norm := 0.0
	for _, value := range embedding {
		if math.IsNaN(value) || math.IsInf(value, 0) {
			return false
		}
		norm += value * value
	}
	return norm > 0
}

func vectorLiteral(embedding []float64) string {
	parts := make([]string, len(embedding))
	for index, value := range embedding {
		parts[index] = strconv.FormatFloat(value, 'g', -1, 64)
	}
	return "[" + strings.Join(parts, ",") + "]"
}
