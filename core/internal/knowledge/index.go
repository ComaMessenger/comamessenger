package knowledge

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"github.com/comamessenger/comamessenger/core/internal/agentconfig"
	"github.com/comamessenger/comamessenger/core/internal/files"
	"github.com/comamessenger/comamessenger/core/internal/id"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/riverqueue/river"
	"github.com/riverqueue/river/riverdriver/riverpgxv5"
	"github.com/riverqueue/river/rivertype"
)

const (
	indexingQueue     = "knowledge-indexing"
	indexMaxAttempts  = 5
	embedMaxAttempts  = 8
	embeddingTextSize = 6000
)

// IndexArgs carries the content version so that editing a page while an
// older job is queued schedules a fresh job instead of being deduplicated.
type IndexArgs struct {
	DocumentID string `json:"document_id" river:"unique"`
	Version    int    `json:"version" river:"unique"`
}

func (IndexArgs) Kind() string { return "knowledge.index" }

type EmbedArgs struct {
	DocumentID string `json:"document_id" river:"unique"`
	Version    int    `json:"version" river:"unique"`
}

func (EmbedArgs) Kind() string { return "knowledge.embed" }

type indexWorker struct {
	river.WorkerDefaults[IndexArgs]
	service *Service
}

func (w *indexWorker) Timeout(*river.Job[IndexArgs]) time.Duration { return 2 * time.Minute }

func (w *indexWorker) Work(ctx context.Context, job *river.Job[IndexArgs]) error {
	err := w.service.IndexDocument(ctx, job.Args.DocumentID, job.Args.Version)
	if err != nil && job.Attempt >= job.MaxAttempts {
		w.service.markIndexFailed(context.WithoutCancel(ctx), job.Args.DocumentID, job.Args.Version, "indexing_failed")
	}
	return err
}

type embedWorker struct {
	river.WorkerDefaults[EmbedArgs]
	service *Service
}

func (w *embedWorker) Timeout(*river.Job[EmbedArgs]) time.Duration { return 5 * time.Minute }

func (w *embedWorker) Work(ctx context.Context, job *river.Job[EmbedArgs]) error {
	err := w.service.EmbedDocument(ctx, job.Args.DocumentID, job.Args.Version)
	if err != nil && job.Attempt >= job.MaxAttempts {
		w.service.setEmbeddingStatus(context.WithoutCancel(ctx), job.Args.DocumentID, job.Args.Version, "failed")
	}
	return err
}

// NewIndexingClient installs the knowledge workers and wires transactional
// enqueueing, following the file.process pattern.
func NewIndexingClient(pool *pgxpool.Pool, service *Service, logger *slog.Logger) (*river.Client[pgx.Tx], error) {
	workers := river.NewWorkers()
	river.AddWorker(workers, &indexWorker{service: service})
	river.AddWorker(workers, &embedWorker{service: service})
	client, err := river.NewClient(riverpgxv5.New(pool), &river.Config{
		Logger:  logger,
		Queues:  map[string]river.QueueConfig{indexingQueue: {MaxWorkers: 2}},
		Workers: workers,
	})
	if err != nil {
		return nil, fmt.Errorf("create knowledge indexing client: %w", err)
	}
	unique := river.UniqueOpts{ByArgs: true, ByState: rivertype.UniqueOptsByStateDefault()}
	service.SetEnqueuers(
		func(ctx context.Context, tx pgx.Tx, documentID string, version int) error {
			_, err := client.InsertTx(ctx, tx, IndexArgs{DocumentID: documentID, Version: version}, &river.InsertOpts{Queue: indexingQueue, MaxAttempts: indexMaxAttempts, UniqueOpts: unique})
			return err
		},
		func(ctx context.Context, tx pgx.Tx, documentID string, version int) error {
			_, err := client.InsertTx(ctx, tx, EmbedArgs{DocumentID: documentID, Version: version}, &river.InsertOpts{Queue: indexingQueue, MaxAttempts: embedMaxAttempts, UniqueOpts: unique})
			return err
		},
	)
	return client, nil
}

type indexRecord struct {
	OrgID, CollectionID, Kind string
	FileID, Body              *string
	Version                   int
	EmbeddingConnectionID     *string
}

func (s *Service) loadIndexRecord(ctx context.Context, documentID string) (indexRecord, error) {
	var record indexRecord
	err := s.pool.QueryRow(ctx, `SELECT document.org_id,document.collection_id,document.kind,document.file_id::text,document.body,document.content_version,
		collection.embedding_connection_id::text
		FROM knowledge_documents document
		JOIN knowledge_collections collection ON collection.org_id=document.org_id AND collection.id=document.collection_id
		WHERE document.id=$1`, documentID).Scan(&record.OrgID, &record.CollectionID, &record.Kind, &record.FileID, &record.Body, &record.Version, &record.EmbeddingConnectionID)
	return record, err
}

// IndexDocument extracts, cuts and stores the fragments of one document
// version. It is idempotent: a stale version or a deleted document is a no-op,
// and the fragment set is replaced atomically.
func (s *Service) IndexDocument(ctx context.Context, documentID string, version int) error {
	record, err := s.loadIndexRecord(ctx, documentID)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("load knowledge document: %w", err)
	}
	if record.Version != version {
		return nil
	}
	if _, err := s.pool.Exec(ctx, `UPDATE knowledge_documents SET status='processing' WHERE id=$1 AND content_version=$2 AND status IN ('pending','processing')`, documentID, version); err != nil {
		return fmt.Errorf("claim knowledge document: %w", err)
	}
	var document files.ExtractedDocument
	if record.Kind == "page" {
		if record.Body == nil {
			s.markIndexFailed(ctx, documentID, version, "empty_document")
			return nil
		}
		document = files.ParseMarkdown(*record.Body)
	} else {
		if s.files == nil || record.FileID == nil {
			return errors.New("knowledge file reader is not configured")
		}
		source, err := s.files.ReadSource(ctx, record.OrgID, *record.FileID)
		if errors.Is(err, files.ErrNotFound) {
			s.markIndexFailed(ctx, documentID, version, "file_unavailable")
			return nil
		}
		if err != nil {
			return err
		}
		document, err = files.ExtractDocument(source.Name, source.MIME, source.Data)
		if errors.Is(err, files.ErrUnsupportedDocument) {
			s.markIndexFailed(ctx, documentID, version, "unsupported_format")
			return nil
		}
		if err != nil {
			return err
		}
	}
	chunks := SplitDocument(document)
	if len(chunks) == 0 {
		s.markIndexFailed(ctx, documentID, version, "no_text_extracted")
		return nil
	}
	ids := make([]string, len(chunks))
	positions := make([]int32, len(chunks))
	sections := make([]string, len(chunks))
	contents := make([]string, len(chunks))
	for index, chunk := range chunks {
		chunkID, err := id.New()
		if err != nil {
			return err
		}
		ids[index], positions[index], sections[index], contents[index] = chunkID, int32(chunk.Position), chunk.Section, chunk.Content
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	var current int
	err = tx.QueryRow(ctx, `SELECT content_version FROM knowledge_documents WHERE id=$1 FOR UPDATE`, documentID).Scan(&current)
	if errors.Is(err, pgx.ErrNoRows) || err == nil && current != version {
		return nil
	}
	if err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `DELETE FROM knowledge_chunks WHERE org_id=$1 AND document_id=$2`, record.OrgID, documentID); err != nil {
		return fmt.Errorf("replace knowledge chunks: %w", err)
	}
	if _, err := tx.Exec(ctx, `INSERT INTO knowledge_chunks(id,org_id,collection_id,document_id,position,section,content)
		SELECT chunk.id,$1,$2,$3,chunk.position,chunk.section,chunk.content
		FROM unnest($4::uuid[],$5::integer[],$6::text[],$7::text[]) AS chunk(id,position,section,content)`,
		record.OrgID, record.CollectionID, documentID, ids, positions, sections, contents); err != nil {
		return fmt.Errorf("insert knowledge chunks: %w", err)
	}
	embeddingStatus := "none"
	if record.EmbeddingConnectionID != nil {
		embeddingStatus = "pending"
		if err := s.enqueue(ctx, tx, s.enqueueEmbed, documentID, version); err != nil {
			return err
		}
	}
	if _, err := tx.Exec(ctx, `UPDATE knowledge_documents SET status='ready',error_code='',chunk_count=$3,embedding_status=$4,indexed_at=now()
		WHERE id=$1 AND content_version=$2`, documentID, version, len(chunks), embeddingStatus); err != nil {
		return fmt.Errorf("finish knowledge indexing: %w", err)
	}
	return tx.Commit(ctx)
}

// markIndexFailed keeps the previous fragments (if any) searchable; a failed
// re-index of a page must not erase the last good version.
func (s *Service) markIndexFailed(ctx context.Context, documentID string, version int, code string) {
	_, _ = s.pool.Exec(ctx, `UPDATE knowledge_documents SET status='failed',error_code=$3 WHERE id=$1 AND content_version=$2`, documentID, version, code)
}

func (s *Service) setEmbeddingStatus(ctx context.Context, documentID string, version int, status string) {
	_, _ = s.pool.Exec(ctx, `UPDATE knowledge_documents SET embedding_status=$3 WHERE id=$1 AND content_version=$2`, documentID, version, status)
}

// EmbedDocument generates vectors for fragments that lack one for the
// collection's current connection. Without an approved connection it leaves
// the document on full-text search only.
func (s *Service) EmbedDocument(ctx context.Context, documentID string, version int) error {
	record, err := s.loadIndexRecord(ctx, documentID)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("load knowledge document: %w", err)
	}
	if record.Version != version {
		return nil
	}
	if record.EmbeddingConnectionID == nil || s.connections == nil || s.embedder == nil {
		s.setEmbeddingStatus(ctx, documentID, version, "none")
		return nil
	}
	connection, err := s.connections.EmbeddingConnection(ctx, record.OrgID, *record.EmbeddingConnectionID)
	if errors.Is(err, agentconfig.ErrEmbeddingsUnavailable) {
		s.setEmbeddingStatus(ctx, documentID, version, "none")
		return nil
	}
	if err != nil {
		return err
	}
	for {
		rows, err := s.pool.Query(ctx, `SELECT id,section,content FROM knowledge_chunks
			WHERE org_id=$1 AND document_id=$2 AND (embedding IS NULL OR embedding_model IS DISTINCT FROM $3 OR embedding_provider IS DISTINCT FROM $4)
			ORDER BY position LIMIT $5`, record.OrgID, documentID, connection.Model, connection.Provider, embeddingBatchSize)
		if err != nil {
			return fmt.Errorf("load chunks for embedding: %w", err)
		}
		var ids, inputs []string
		for rows.Next() {
			var chunkID, section, content string
			if err := rows.Scan(&chunkID, &section, &content); err != nil {
				rows.Close()
				return err
			}
			ids = append(ids, chunkID)
			inputs = append(inputs, truncateRunes(embeddingText(section, content), embeddingTextSize))
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return err
		}
		if len(ids) == 0 {
			break
		}
		vectors, err := s.embedder.Embed(ctx, connection, inputs)
		if errors.Is(err, ErrEmbeddingRejected) {
			s.setEmbeddingStatus(ctx, documentID, version, "failed")
			return nil
		}
		if err != nil {
			return err
		}
		batch := &pgx.Batch{}
		for index, vector := range vectors {
			batch.Queue(`UPDATE knowledge_chunks SET embedding=$2::vector,embedding_dimensions=$3,embedding_model=$4,embedding_provider=$5 WHERE id=$1`,
				ids[index], vectorLiteral(vector), len(vector), connection.Model, connection.Provider)
		}
		if err := s.pool.SendBatch(ctx, batch).Close(); err != nil {
			return fmt.Errorf("store knowledge embeddings: %w", err)
		}
	}
	s.setEmbeddingStatus(ctx, documentID, version, "ready")
	return nil
}

func embeddingText(section, content string) string {
	if section == "" {
		return content
	}
	return section + "\n\n" + content
}
