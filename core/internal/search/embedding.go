package search

import (
	"context"
	"errors"
	"fmt"
	"strconv"
	"strings"

	"github.com/jackc/pgx/v5/pgxpool"
)

type EmbeddingWriter interface {
	Upsert(context.Context, string, string, string, []float32) error
	Delete(context.Context, string, string, string) error
}

type PostgreSQLEmbeddingWriter struct {
	pool *pgxpool.Pool
}

func NewEmbeddingWriter(pool *pgxpool.Pool) *PostgreSQLEmbeddingWriter {
	return &PostgreSQLEmbeddingWriter{pool: pool}
}

func (writer *PostgreSQLEmbeddingWriter) Upsert(ctx context.Context, messageID, provider, model string, embedding []float32) error {
	provider = strings.TrimSpace(provider)
	model = strings.TrimSpace(model)
	if writer.pool == nil || messageID == "" || provider == "" || model == "" || len(provider) > 100 || len(model) > 200 || len(embedding) < 1 || len(embedding) > 4096 {
		return fmt.Errorf("%w: invalid embedding metadata or dimensions", ErrInvalid)
	}
	values := make([]string, len(embedding))
	for index, value := range embedding {
		values[index] = strconv.FormatFloat(float64(value), 'g', -1, 32)
	}
	if _, err := writer.pool.Exec(ctx, `
		INSERT INTO message_embeddings(message_id, provider, model, dimensions, embedding)
		VALUES($1,$2,$3,$4,$5::vector)
		ON CONFLICT(message_id,provider,model) DO UPDATE SET
		  dimensions=excluded.dimensions, embedding=excluded.embedding, created_at=now()`,
		messageID, provider, model, len(embedding), "["+strings.Join(values, ",")+"]"); err != nil {
		return fmt.Errorf("upsert message embedding: %w", err)
	}
	return nil
}

func (writer *PostgreSQLEmbeddingWriter) Delete(ctx context.Context, messageID, provider, model string) error {
	if writer.pool == nil || messageID == "" || strings.TrimSpace(provider) == "" || strings.TrimSpace(model) == "" {
		return fmt.Errorf("%w: invalid embedding identity", ErrInvalid)
	}
	result, err := writer.pool.Exec(ctx, `DELETE FROM message_embeddings WHERE message_id=$1 AND provider=$2 AND model=$3`, messageID, provider, model)
	if err != nil {
		return fmt.Errorf("delete message embedding: %w", err)
	}
	if result.RowsAffected() == 0 {
		return errors.New("message embedding not found")
	}
	return nil
}
