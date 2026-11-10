// Package knowledge implements the workspace knowledge base: collections of
// uploaded files and Markdown pages, cut into fragments that are indexed for
// full-text search and, when a workspace connection allows it, embeddings.
package knowledge

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/comamessenger/comamessenger/core/internal/files"
	"github.com/comamessenger/comamessenger/core/internal/id"
	"github.com/comamessenger/comamessenger/core/internal/identity"
	"github.com/comamessenger/comamessenger/core/internal/permission"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

var (
	ErrInvalid   = errors.New("invalid knowledge input")
	ErrForbidden = errors.New("knowledge access forbidden")
	ErrNotFound  = errors.New("knowledge item not found")
	ErrConflict  = errors.New("knowledge state conflict")
)

const (
	maxPageBytes         = 1 << 20
	maxCollectionChats   = 100
	maxDocumentsPerPage  = 200
	maxCollectionsListed = 500
)

type Collection struct {
	ID                    string   `json:"id"`
	Name                  string   `json:"name"`
	Description           string   `json:"description"`
	Access                string   `json:"access"`
	ChatIDs               []string `json:"chat_ids"`
	EmbeddingConnectionID *string  `json:"embedding_connection_id"`
	DocumentCount         int      `json:"document_count"`
	// SemanticSearch reports whether the collection's embedding connection is
	// usable now (enabled, with an embedding model and approved data sharing).
	SemanticSearch bool      `json:"semantic_search"`
	CanManage      bool      `json:"can_manage"`
	CreatedBy      string    `json:"created_by"`
	CreatedAt      time.Time `json:"created_at"`
	UpdatedAt      time.Time `json:"updated_at"`
}

type CreateCollectionInput struct {
	Name                  string   `json:"name"`
	Description           string   `json:"description"`
	Access                string   `json:"access"`
	ChatIDs               []string `json:"chat_ids"`
	EmbeddingConnectionID *string  `json:"embedding_connection_id"`
}

// OptionalID distinguishes an absent JSON field from an explicit null.
type OptionalID struct {
	Set   bool
	Value *string
}

func (value *OptionalID) UnmarshalJSON(data []byte) error {
	value.Set = true
	if bytes.Equal(bytes.TrimSpace(data), []byte("null")) {
		value.Value = nil
		return nil
	}
	var decoded string
	if err := json.Unmarshal(data, &decoded); err != nil {
		return err
	}
	value.Value = &decoded
	return nil
}

type UpdateCollectionInput struct {
	Name                  *string    `json:"name"`
	Description           *string    `json:"description"`
	Access                *string    `json:"access"`
	ChatIDs               *[]string  `json:"chat_ids"`
	EmbeddingConnectionID OptionalID `json:"embedding_connection_id"`
}

type Document struct {
	ID              string     `json:"id"`
	CollectionID    string     `json:"collection_id"`
	Kind            string     `json:"kind"`
	Title           string     `json:"title"`
	FileID          *string    `json:"file_id"`
	FileName        *string    `json:"file_name"`
	FileMIME        *string    `json:"file_mime"`
	FileSize        *int64     `json:"file_size"`
	Body            *string    `json:"body,omitempty"`
	Status          string     `json:"status"`
	ErrorCode       string     `json:"error_code"`
	EmbeddingStatus string     `json:"embedding_status"`
	ChunkCount      int        `json:"chunk_count"`
	ContentVersion  int        `json:"content_version"`
	IndexedAt       *time.Time `json:"indexed_at"`
	CreatedBy       string     `json:"created_by"`
	CreatedAt       time.Time  `json:"created_at"`
	UpdatedAt       time.Time  `json:"updated_at"`
}

type CreateDocumentInput struct {
	Kind   string `json:"kind"`
	Title  string `json:"title"`
	FileID string `json:"file_id"`
	Body   string `json:"body"`
}

type UpdateDocumentInput struct {
	Title *string `json:"title"`
	Body  *string `json:"body"`
}

type Service struct {
	pool         *pgxpool.Pool
	files        *files.Service
	connections  ConnectionResolver
	embedder     Embedder
	enqueueIndex func(context.Context, pgx.Tx, string, int) error
	enqueueEmbed func(context.Context, pgx.Tx, string, int) error
}

func NewService(pool *pgxpool.Pool, fileService *files.Service, connections ConnectionResolver, embedder Embedder) *Service {
	return &Service{pool: pool, files: fileService, connections: connections, embedder: embedder}
}

// SetEnqueuers wires the durable job queue. Both callbacks run inside the
// transaction that changes the document, so a commit always has a job.
func (s *Service) SetEnqueuers(index, embed func(context.Context, pgx.Tx, string, int) error) {
	s.enqueueIndex, s.enqueueEmbed = index, embed
}

func CanManage(user identity.User) bool {
	return permission.Allows(user.OrgRole, user.Permissions, permission.KnowledgeManage)
}

// readableCondition limits collections to those the actor may read: all of
// them for managers, otherwise organization-wide ones and those shared with a
// chat the actor belongs to. $1 is the org, $2 the actor, $3 the manage flag.
const readableCondition = `collection.org_id=$1 AND ($3::boolean OR collection.access='organization' OR EXISTS(
	SELECT 1 FROM knowledge_collection_chats shared
	JOIN chat_members member ON member.org_id=shared.org_id AND member.chat_id=shared.chat_id AND member.actor_id=$2
	JOIN chats chat ON chat.org_id=shared.org_id AND chat.id=shared.chat_id AND chat.archived_at IS NULL
	WHERE shared.org_id=collection.org_id AND shared.collection_id=collection.id))`

const collectionSelect = `SELECT collection.id,collection.name,collection.description,collection.access,
	ARRAY(SELECT shared.chat_id::text FROM knowledge_collection_chats shared WHERE shared.org_id=collection.org_id AND shared.collection_id=collection.id ORDER BY shared.chat_id),
	collection.embedding_connection_id::text,
	(SELECT count(*) FROM knowledge_documents document WHERE document.org_id=collection.org_id AND document.collection_id=collection.id),
	EXISTS(SELECT 1 FROM agent_llm_connections connection WHERE connection.org_id=collection.org_id AND connection.id=collection.embedding_connection_id AND ` + embeddingReadyCondition + `),
	collection.created_by,collection.created_at,collection.updated_at
	FROM knowledge_collections collection`

type rowScanner interface{ Scan(...any) error }

func scanCollection(row rowScanner, manage bool) (Collection, error) {
	var result Collection
	err := row.Scan(&result.ID, &result.Name, &result.Description, &result.Access, &result.ChatIDs, &result.EmbeddingConnectionID,
		&result.DocumentCount, &result.SemanticSearch, &result.CreatedBy, &result.CreatedAt, &result.UpdatedAt)
	result.CanManage = manage
	if !manage {
		result.ChatIDs = []string{}
		result.EmbeddingConnectionID = nil
	}
	return result, err
}

func (s *Service) ListCollections(ctx context.Context, current identity.User) ([]Collection, error) {
	manage := CanManage(current)
	rows, err := s.pool.Query(ctx, collectionSelect+` WHERE `+readableCondition+` ORDER BY lower(collection.name),collection.id LIMIT `+fmt.Sprint(maxCollectionsListed), current.OrgID, current.ActorID, manage)
	if err != nil {
		return nil, fmt.Errorf("list knowledge collections: %w", err)
	}
	defer rows.Close()
	result := make([]Collection, 0)
	for rows.Next() {
		collection, err := scanCollection(rows, manage)
		if err != nil {
			return nil, fmt.Errorf("scan knowledge collection: %w", err)
		}
		result = append(result, collection)
	}
	return result, rows.Err()
}

func (s *Service) GetCollection(ctx context.Context, current identity.User, collectionID string) (Collection, error) {
	if uuid.Validate(collectionID) != nil {
		return Collection{}, ErrNotFound
	}
	manage := CanManage(current)
	collection, err := scanCollection(s.pool.QueryRow(ctx, collectionSelect+` WHERE `+readableCondition+` AND collection.id=$4`, current.OrgID, current.ActorID, manage, collectionID), manage)
	if errors.Is(err, pgx.ErrNoRows) {
		return Collection{}, ErrNotFound
	}
	if err != nil {
		return Collection{}, fmt.Errorf("get knowledge collection: %w", err)
	}
	return collection, nil
}

func normalizeCollection(name, description, access string, chatIDs []string, connectionID *string) (string, string, string, []string, *string, error) {
	name, description, access = strings.TrimSpace(name), strings.TrimSpace(description), strings.TrimSpace(access)
	if access == "" {
		access = "organization"
	}
	if utf8.RuneCountInString(name) < 1 || utf8.RuneCountInString(name) > 120 || utf8.RuneCountInString(description) > 2000 || (access != "organization" && access != "chats") {
		return "", "", "", nil, nil, fmt.Errorf("%w: name, description or access is invalid", ErrInvalid)
	}
	normalized, err := normalizeIDs(chatIDs, maxCollectionChats)
	if err != nil {
		return "", "", "", nil, nil, err
	}
	if access == "chats" && len(normalized) == 0 {
		return "", "", "", nil, nil, fmt.Errorf("%w: chat access requires at least one chat", ErrInvalid)
	}
	if access == "organization" {
		normalized = []string{}
	}
	if connectionID != nil {
		value := strings.TrimSpace(*connectionID)
		if uuid.Validate(value) != nil {
			return "", "", "", nil, nil, fmt.Errorf("%w: invalid embedding connection", ErrInvalid)
		}
		connectionID = &value
	}
	return name, description, access, normalized, connectionID, nil
}

func normalizeIDs(values []string, limit int) ([]string, error) {
	if len(values) > limit {
		return nil, fmt.Errorf("%w: too many identifiers", ErrInvalid)
	}
	seen := make(map[string]struct{}, len(values))
	result := make([]string, 0, len(values))
	for _, value := range values {
		parsed, err := uuid.Parse(strings.TrimSpace(value))
		if err != nil {
			return nil, fmt.Errorf("%w: invalid identifier", ErrInvalid)
		}
		if _, duplicate := seen[parsed.String()]; duplicate {
			continue
		}
		seen[parsed.String()] = struct{}{}
		result = append(result, parsed.String())
	}
	return result, nil
}

func validateCollectionRefs(ctx context.Context, tx pgx.Tx, orgID string, chatIDs []string, connectionID *string) error {
	if len(chatIDs) > 0 {
		var count int
		if err := tx.QueryRow(ctx, `SELECT count(*) FROM chats WHERE org_id=$1 AND id=ANY($2::uuid[]) AND archived_at IS NULL`, orgID, chatIDs).Scan(&count); err != nil {
			return fmt.Errorf("validate knowledge chats: %w", err)
		}
		if count != len(chatIDs) {
			return fmt.Errorf("%w: every chat must be active and belong to the organization", ErrInvalid)
		}
	}
	if connectionID != nil {
		var exists bool
		if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM agent_llm_connections WHERE org_id=$1 AND id=$2)`, orgID, *connectionID).Scan(&exists); err != nil {
			return fmt.Errorf("validate embedding connection: %w", err)
		}
		if !exists {
			return fmt.Errorf("%w: embedding connection was not found", ErrInvalid)
		}
	}
	return nil
}

func replaceCollectionChats(ctx context.Context, tx pgx.Tx, orgID, collectionID string, chatIDs []string) error {
	if _, err := tx.Exec(ctx, `DELETE FROM knowledge_collection_chats WHERE org_id=$1 AND collection_id=$2`, orgID, collectionID); err != nil {
		return fmt.Errorf("clear knowledge collection chats: %w", err)
	}
	if len(chatIDs) == 0 {
		return nil
	}
	if _, err := tx.Exec(ctx, `INSERT INTO knowledge_collection_chats(org_id,collection_id,chat_id) SELECT $1,$2,chat_id FROM unnest($3::uuid[]) chat_id`, orgID, collectionID, chatIDs); err != nil {
		return fmt.Errorf("share knowledge collection: %w", err)
	}
	return nil
}

func (s *Service) CreateCollection(ctx context.Context, current identity.User, input CreateCollectionInput) (Collection, error) {
	if !CanManage(current) {
		return Collection{}, ErrForbidden
	}
	name, description, access, chatIDs, connectionID, err := normalizeCollection(input.Name, input.Description, input.Access, input.ChatIDs, input.EmbeddingConnectionID)
	if err != nil {
		return Collection{}, err
	}
	collectionID, err := id.New()
	if err != nil {
		return Collection{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Collection{}, err
	}
	defer tx.Rollback(ctx)
	if err := validateCollectionRefs(ctx, tx, current.OrgID, chatIDs, connectionID); err != nil {
		return Collection{}, err
	}
	if _, err := tx.Exec(ctx, `INSERT INTO knowledge_collections(id,org_id,name,description,access,embedding_connection_id,created_by,updated_by)
		VALUES($1,$2,$3,$4,$5,$6,$7,$7)`, collectionID, current.OrgID, name, description, access, connectionID, current.ActorID); err != nil {
		return Collection{}, mapWriteError("create knowledge collection", err)
	}
	if err := replaceCollectionChats(ctx, tx, current.OrgID, collectionID, chatIDs); err != nil {
		return Collection{}, err
	}
	if err := audit(ctx, tx, current, "knowledge.collection.create", "knowledge_collection", collectionID, map[string]any{"access": access, "chat_ids": chatIDs, "embedding_connection_id": connectionID}); err != nil {
		return Collection{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Collection{}, mapWriteError("commit knowledge collection", err)
	}
	return s.GetCollection(ctx, current, collectionID)
}

func (s *Service) UpdateCollection(ctx context.Context, current identity.User, collectionID string, input UpdateCollectionInput) (Collection, error) {
	if !CanManage(current) {
		return Collection{}, ErrForbidden
	}
	if uuid.Validate(collectionID) != nil {
		return Collection{}, ErrNotFound
	}
	if input.Name == nil && input.Description == nil && input.Access == nil && input.ChatIDs == nil && !input.EmbeddingConnectionID.Set {
		return Collection{}, fmt.Errorf("%w: update must contain at least one field", ErrInvalid)
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Collection{}, err
	}
	defer tx.Rollback(ctx)
	existing, err := scanCollection(tx.QueryRow(ctx, collectionSelect+` WHERE collection.org_id=$1 AND collection.id=$2 FOR UPDATE OF collection`, current.OrgID, collectionID), true)
	if errors.Is(err, pgx.ErrNoRows) {
		return Collection{}, ErrNotFound
	}
	if err != nil {
		return Collection{}, err
	}
	name, description, access, chatIDs, connectionID := existing.Name, existing.Description, existing.Access, existing.ChatIDs, existing.EmbeddingConnectionID
	if input.Name != nil {
		name = *input.Name
	}
	if input.Description != nil {
		description = *input.Description
	}
	if input.Access != nil {
		access = *input.Access
	}
	if input.ChatIDs != nil {
		chatIDs = *input.ChatIDs
	}
	if input.EmbeddingConnectionID.Set {
		connectionID = input.EmbeddingConnectionID.Value
	}
	name, description, access, chatIDs, connectionID, err = normalizeCollection(name, description, access, chatIDs, connectionID)
	if err != nil {
		return Collection{}, err
	}
	if err := validateCollectionRefs(ctx, tx, current.OrgID, chatIDs, connectionID); err != nil {
		return Collection{}, err
	}
	if _, err := tx.Exec(ctx, `UPDATE knowledge_collections SET name=$3,description=$4,access=$5,embedding_connection_id=$6,updated_by=$7,updated_at=now()
		WHERE org_id=$1 AND id=$2`, current.OrgID, collectionID, name, description, access, connectionID, current.ActorID); err != nil {
		return Collection{}, mapWriteError("update knowledge collection", err)
	}
	if err := replaceCollectionChats(ctx, tx, current.OrgID, collectionID, chatIDs); err != nil {
		return Collection{}, err
	}
	connectionChanged := !sameID(existing.EmbeddingConnectionID, connectionID)
	if connectionChanged {
		if err := s.resetEmbeddings(ctx, tx, current.OrgID, collectionID, connectionID != nil); err != nil {
			return Collection{}, err
		}
	}
	if err := audit(ctx, tx, current, "knowledge.collection.update", "knowledge_collection", collectionID, map[string]any{"access": access, "chat_ids": chatIDs, "embedding_connection_id": connectionID, "embedding_connection_changed": connectionChanged}); err != nil {
		return Collection{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Collection{}, mapWriteError("commit knowledge collection update", err)
	}
	return s.GetCollection(ctx, current, collectionID)
}

// resetEmbeddings drops vectors produced by the previous connection and, when
// a new connection is set, schedules every indexed document for embedding.
func (s *Service) resetEmbeddings(ctx context.Context, tx pgx.Tx, orgID, collectionID string, embed bool) error {
	if _, err := tx.Exec(ctx, `UPDATE knowledge_chunks SET embedding=NULL,embedding_dimensions=NULL,embedding_model=NULL,embedding_provider=NULL
		WHERE org_id=$1 AND collection_id=$2 AND embedding IS NOT NULL`, orgID, collectionID); err != nil {
		return fmt.Errorf("clear knowledge embeddings: %w", err)
	}
	status := "none"
	if embed {
		status = "pending"
	}
	rows, err := tx.Query(ctx, `UPDATE knowledge_documents SET embedding_status=CASE WHEN status='ready' THEN $3 ELSE 'none' END
		WHERE org_id=$1 AND collection_id=$2 RETURNING id,content_version,status`, orgID, collectionID, status)
	if err != nil {
		return fmt.Errorf("reset knowledge embedding status: %w", err)
	}
	type pending struct {
		id      string
		version int
	}
	var queue []pending
	for rows.Next() {
		var item pending
		var documentStatus string
		if err := rows.Scan(&item.id, &item.version, &documentStatus); err != nil {
			rows.Close()
			return err
		}
		if embed && documentStatus == "ready" {
			queue = append(queue, item)
		}
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}
	for _, item := range queue {
		if err := s.enqueue(ctx, tx, s.enqueueEmbed, item.id, item.version); err != nil {
			return err
		}
	}
	return nil
}

func sameID(left, right *string) bool {
	if left == nil || right == nil {
		return left == nil && right == nil
	}
	return *left == *right
}

func (s *Service) DeleteCollection(ctx context.Context, current identity.User, collectionID string) error {
	if !CanManage(current) {
		return ErrForbidden
	}
	if uuid.Validate(collectionID) != nil {
		return ErrNotFound
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	var name string
	var documents int
	err = tx.QueryRow(ctx, `DELETE FROM knowledge_collections collection WHERE org_id=$1 AND id=$2
		RETURNING name,(SELECT count(*) FROM knowledge_documents document WHERE document.org_id=collection.org_id AND document.collection_id=collection.id)`, current.OrgID, collectionID).Scan(&name, &documents)
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrNotFound
	}
	if err != nil {
		return fmt.Errorf("delete knowledge collection: %w", err)
	}
	// Bindings are uuid arrays without foreign keys; drop the stale id from
	// published agents and drafts. Version history keeps it for audit.
	if _, err := tx.Exec(ctx, `UPDATE agents SET knowledge_collection_ids=array_remove(knowledge_collection_ids,$2::uuid) WHERE org_id=$1 AND $2::uuid=ANY(knowledge_collection_ids)`, current.OrgID, collectionID); err != nil {
		return fmt.Errorf("unbind knowledge collection from agents: %w", err)
	}
	if _, err := tx.Exec(ctx, `UPDATE agent_drafts SET knowledge_collection_ids=array_remove(knowledge_collection_ids,$2::uuid) WHERE org_id=$1 AND $2::uuid=ANY(knowledge_collection_ids)`, current.OrgID, collectionID); err != nil {
		return fmt.Errorf("unbind knowledge collection from drafts: %w", err)
	}
	if err := audit(ctx, tx, current, "knowledge.collection.delete", "knowledge_collection", collectionID, map[string]any{"name": name, "documents": documents}); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

const documentSelect = `SELECT document.id,document.collection_id,document.kind,document.title,document.file_id::text,
	file.name,file.mime,file.size,document.status,document.error_code,document.embedding_status,document.chunk_count,
	document.content_version,document.indexed_at,document.created_by,document.created_at,document.updated_at
	FROM knowledge_documents document
	JOIN knowledge_collections collection ON collection.org_id=document.org_id AND collection.id=document.collection_id
	LEFT JOIN files file ON file.org_id=document.org_id AND file.id=document.file_id`

func scanDocument(row rowScanner) (Document, error) {
	var result Document
	err := row.Scan(&result.ID, &result.CollectionID, &result.Kind, &result.Title, &result.FileID, &result.FileName, &result.FileMIME, &result.FileSize,
		&result.Status, &result.ErrorCode, &result.EmbeddingStatus, &result.ChunkCount, &result.ContentVersion, &result.IndexedAt,
		&result.CreatedBy, &result.CreatedAt, &result.UpdatedAt)
	return result, err
}

func (s *Service) ListDocuments(ctx context.Context, current identity.User, collectionID string) ([]Document, error) {
	if _, err := s.GetCollection(ctx, current, collectionID); err != nil {
		return nil, err
	}
	rows, err := s.pool.Query(ctx, documentSelect+` WHERE document.org_id=$1 AND document.collection_id=$2 ORDER BY document.updated_at DESC,document.id LIMIT `+fmt.Sprint(maxDocumentsPerPage), current.OrgID, collectionID)
	if err != nil {
		return nil, fmt.Errorf("list knowledge documents: %w", err)
	}
	defer rows.Close()
	result := make([]Document, 0)
	for rows.Next() {
		document, err := scanDocument(rows)
		if err != nil {
			return nil, fmt.Errorf("scan knowledge document: %w", err)
		}
		result = append(result, document)
	}
	return result, rows.Err()
}

// GetDocument returns a document with the Markdown body of a page.
func (s *Service) GetDocument(ctx context.Context, current identity.User, documentID string) (Document, error) {
	if uuid.Validate(documentID) != nil {
		return Document{}, ErrNotFound
	}
	manage := CanManage(current)
	query := strings.Replace(documentSelect, "SELECT document.id,", "SELECT document.body,document.id,", 1) +
		` WHERE document.org_id=$1 AND document.id=$4 AND ` + readableCondition
	var body *string
	var result Document
	err := s.pool.QueryRow(ctx, query, current.OrgID, current.ActorID, manage, documentID).Scan(&body,
		&result.ID, &result.CollectionID, &result.Kind, &result.Title, &result.FileID, &result.FileName, &result.FileMIME, &result.FileSize,
		&result.Status, &result.ErrorCode, &result.EmbeddingStatus, &result.ChunkCount, &result.ContentVersion, &result.IndexedAt,
		&result.CreatedBy, &result.CreatedAt, &result.UpdatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return Document{}, ErrNotFound
	}
	if err != nil {
		return Document{}, fmt.Errorf("get knowledge document: %w", err)
	}
	result.Body = body
	return result, nil
}

func normalizeTitle(value string) (string, error) {
	value = strings.Join(strings.Fields(value), " ")
	if utf8.RuneCountInString(value) < 1 || utf8.RuneCountInString(value) > 255 {
		return "", fmt.Errorf("%w: title must contain 1 to 255 characters", ErrInvalid)
	}
	return value, nil
}

func normalizeBody(value string) (string, error) {
	value = strings.ReplaceAll(value, "\x00", "")
	if len(value) > maxPageBytes || !utf8.ValidString(value) || strings.TrimSpace(value) == "" {
		return "", fmt.Errorf("%w: page body must be non-empty UTF-8 up to 1 MiB", ErrInvalid)
	}
	return value, nil
}

// CreateDocument adds an uploaded file or a Markdown page to a collection.
// A file must be a ready upload of the current user; ownership of the bytes
// moves to the knowledge base, which keeps the file from upload cleanup.
func (s *Service) CreateDocument(ctx context.Context, current identity.User, collectionID string, input CreateDocumentInput) (Document, error) {
	if !CanManage(current) {
		return Document{}, ErrForbidden
	}
	if uuid.Validate(collectionID) != nil {
		return Document{}, ErrNotFound
	}
	input.Kind = strings.TrimSpace(input.Kind)
	var fileID, body *string
	switch input.Kind {
	case "file":
		value := strings.TrimSpace(input.FileID)
		if uuid.Validate(value) != nil || input.Body != "" {
			return Document{}, fmt.Errorf("%w: file documents require file_id only", ErrInvalid)
		}
		fileID = &value
	case "page":
		value, err := normalizeBody(input.Body)
		if err != nil || input.FileID != "" {
			return Document{}, fmt.Errorf("%w: pages require a Markdown body and no file_id", ErrInvalid)
		}
		body = &value
	default:
		return Document{}, fmt.Errorf("%w: kind must be file or page", ErrInvalid)
	}
	documentID, err := id.New()
	if err != nil {
		return Document{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Document{}, err
	}
	defer tx.Rollback(ctx)
	var exists bool
	if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM knowledge_collections WHERE org_id=$1 AND id=$2 FOR SHARE)`, current.OrgID, collectionID).Scan(&exists); err != nil {
		return Document{}, err
	}
	if !exists {
		return Document{}, ErrNotFound
	}
	title := input.Title
	if fileID != nil {
		var name, mime, uploader string
		err := tx.QueryRow(ctx, `SELECT name,mime,uploader_id FROM files WHERE org_id=$1 AND id=$2 AND status='ready' FOR SHARE`, current.OrgID, *fileID).Scan(&name, &mime, &uploader)
		if errors.Is(err, pgx.ErrNoRows) {
			return Document{}, fmt.Errorf("%w: file is not a ready upload", ErrInvalid)
		}
		if err != nil {
			return Document{}, err
		}
		if uploader != current.ActorID {
			return Document{}, fmt.Errorf("%w: only files uploaded by the current user can be added", ErrInvalid)
		}
		if files.DocumentKind(name, mime) == "" {
			return Document{}, fmt.Errorf("%w: supported formats are text, Markdown, CSV, XLSX, DOCX and PDF", ErrInvalid)
		}
		if strings.TrimSpace(title) == "" {
			title = name
		}
	}
	if title, err = normalizeTitle(title); err != nil {
		return Document{}, err
	}
	if _, err := tx.Exec(ctx, `INSERT INTO knowledge_documents(id,org_id,collection_id,kind,title,file_id,body,created_by,updated_by)
		VALUES($1,$2,$3,$4,$5,$6,$7,$8,$8)`, documentID, current.OrgID, collectionID, input.Kind, title, fileID, body, current.ActorID); err != nil {
		return Document{}, mapWriteError("create knowledge document", err)
	}
	if err := s.enqueue(ctx, tx, s.enqueueIndex, documentID, 1); err != nil {
		return Document{}, err
	}
	if _, err := tx.Exec(ctx, `UPDATE knowledge_collections SET updated_at=now(),updated_by=$3 WHERE org_id=$1 AND id=$2`, current.OrgID, collectionID, current.ActorID); err != nil {
		return Document{}, err
	}
	if err := audit(ctx, tx, current, "knowledge.document.create", "knowledge_document", documentID, map[string]any{"collection_id": collectionID, "kind": input.Kind, "file_id": fileID}); err != nil {
		return Document{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Document{}, mapWriteError("commit knowledge document", err)
	}
	return s.GetDocument(ctx, current, documentID)
}

// UpdateDocument renames a document or replaces a page body; a new body bumps
// the content version and schedules re-indexing.
func (s *Service) UpdateDocument(ctx context.Context, current identity.User, documentID string, input UpdateDocumentInput) (Document, error) {
	if !CanManage(current) {
		return Document{}, ErrForbidden
	}
	if uuid.Validate(documentID) != nil {
		return Document{}, ErrNotFound
	}
	if input.Title == nil && input.Body == nil {
		return Document{}, fmt.Errorf("%w: update must contain at least one field", ErrInvalid)
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Document{}, err
	}
	defer tx.Rollback(ctx)
	var kind, title string
	var version int
	err = tx.QueryRow(ctx, `SELECT kind,title,content_version FROM knowledge_documents WHERE org_id=$1 AND id=$2 FOR UPDATE`, current.OrgID, documentID).Scan(&kind, &title, &version)
	if errors.Is(err, pgx.ErrNoRows) {
		return Document{}, ErrNotFound
	}
	if err != nil {
		return Document{}, err
	}
	if input.Title != nil {
		if title, err = normalizeTitle(*input.Title); err != nil {
			return Document{}, err
		}
	}
	if input.Body != nil && kind != "page" {
		return Document{}, fmt.Errorf("%w: only pages have an editable body", ErrInvalid)
	}
	if input.Body != nil {
		body, err := normalizeBody(*input.Body)
		if err != nil {
			return Document{}, err
		}
		version++
		if _, err := tx.Exec(ctx, `UPDATE knowledge_documents SET title=$3,body=$4,content_version=$5,status='pending',error_code='',updated_by=$6,updated_at=now()
			WHERE org_id=$1 AND id=$2`, current.OrgID, documentID, title, body, version, current.ActorID); err != nil {
			return Document{}, mapWriteError("update knowledge page", err)
		}
		if err := s.enqueue(ctx, tx, s.enqueueIndex, documentID, version); err != nil {
			return Document{}, err
		}
	} else if _, err := tx.Exec(ctx, `UPDATE knowledge_documents SET title=$3,updated_by=$4,updated_at=now() WHERE org_id=$1 AND id=$2`, current.OrgID, documentID, title, current.ActorID); err != nil {
		return Document{}, mapWriteError("rename knowledge document", err)
	}
	if err := audit(ctx, tx, current, "knowledge.document.update", "knowledge_document", documentID, map[string]any{"body_replaced": input.Body != nil, "content_version": version}); err != nil {
		return Document{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Document{}, err
	}
	return s.GetDocument(ctx, current, documentID)
}

// DeleteDocument removes a document and, by cascade, every fragment. An
// uploaded file is released to regular unattached-file cleanup.
func (s *Service) DeleteDocument(ctx context.Context, current identity.User, documentID string) error {
	if !CanManage(current) {
		return ErrForbidden
	}
	if uuid.Validate(documentID) != nil {
		return ErrNotFound
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	var collectionID string
	var fileID *string
	var chunks int
	err = tx.QueryRow(ctx, `DELETE FROM knowledge_documents WHERE org_id=$1 AND id=$2 RETURNING collection_id,file_id::text,chunk_count`, current.OrgID, documentID).Scan(&collectionID, &fileID, &chunks)
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrNotFound
	}
	if err != nil {
		return fmt.Errorf("delete knowledge document: %w", err)
	}
	if err := audit(ctx, tx, current, "knowledge.document.delete", "knowledge_document", documentID, map[string]any{"collection_id": collectionID, "file_id": fileID, "chunks": chunks}); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (s *Service) enqueue(ctx context.Context, tx pgx.Tx, enqueue func(context.Context, pgx.Tx, string, int) error, documentID string, version int) error {
	if enqueue == nil {
		return nil
	}
	if err := enqueue(ctx, tx, documentID, version); err != nil {
		return fmt.Errorf("enqueue knowledge job: %w", err)
	}
	return nil
}

func audit(ctx context.Context, tx pgx.Tx, current identity.User, action, targetType, targetID string, metadata map[string]any) error {
	auditID, err := id.New()
	if err != nil {
		return err
	}
	encoded, err := json.Marshal(metadata)
	if err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `INSERT INTO audit_log(id,org_id,actor_id,action,target_type,target_id,metadata) VALUES($1,$2,$3,$4,$5,$6,$7)`,
		auditID, current.OrgID, current.ActorID, action, targetType, targetID, encoded); err != nil {
		return fmt.Errorf("audit %s: %w", action, err)
	}
	return nil
}

func mapWriteError(operation string, err error) error {
	var databaseError *pgconn.PgError
	if errors.As(err, &databaseError) {
		switch databaseError.Code {
		case "23505":
			return fmt.Errorf("%w: a collection with this name already exists", ErrConflict)
		case "23503", "23514":
			return fmt.Errorf("%w: %s", ErrInvalid, databaseError.Message)
		}
	}
	return fmt.Errorf("%s: %w", operation, err)
}
