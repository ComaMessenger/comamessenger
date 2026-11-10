package knowledge

import (
	"context"
	"errors"
	"fmt"

	"github.com/comamessenger/comamessenger/core/internal/files"
	"github.com/comamessenger/comamessenger/core/internal/identity"
)

// maxFragmentsListed bounds the extracted-text view of one document.
const maxFragmentsListed = 1000

// embeddingReadyCondition mirrors agentconfig.EmbeddingConnection: a
// connection embeds only when it is enabled, names an embedding model on a
// provider with an embeddings API and is approved to receive document text.
const embeddingReadyCondition = `connection.enabled AND connection.embedding_model<>'' AND connection.embedding_data_sharing_approved
	AND connection.provider IN ('openai','openai-compatible')`

// DocumentFragment is one indexed piece of a document's extracted text.
type DocumentFragment struct {
	ChunkID  string `json:"chunk_id"`
	Position int    `json:"position"`
	Section  string `json:"section"`
	Content  string `json:"content"`
}

type DocumentFragments struct {
	Fragments []DocumentFragment `json:"fragments"`
	// Truncated is true when the document has more fragments than listed.
	Truncated bool `json:"truncated"`
}

// DocumentFragments lists the extracted text of a readable document in
// reading order, so people can check what the knowledge base actually holds.
func (s *Service) DocumentFragments(ctx context.Context, current identity.User, documentID string) (DocumentFragments, error) {
	if _, err := s.GetDocument(ctx, current, documentID); err != nil {
		return DocumentFragments{}, err
	}
	rows, err := s.pool.Query(ctx, `SELECT id::text,position,section,content FROM knowledge_chunks
		WHERE org_id=$1 AND document_id=$2 ORDER BY position LIMIT $3`, current.OrgID, documentID, maxFragmentsListed+1)
	if err != nil {
		return DocumentFragments{}, fmt.Errorf("list knowledge document fragments: %w", err)
	}
	defer rows.Close()
	result := DocumentFragments{Fragments: make([]DocumentFragment, 0)}
	for rows.Next() {
		var fragment DocumentFragment
		if err := rows.Scan(&fragment.ChunkID, &fragment.Position, &fragment.Section, &fragment.Content); err != nil {
			return DocumentFragments{}, err
		}
		result.Fragments = append(result.Fragments, fragment)
	}
	if err := rows.Err(); err != nil {
		return DocumentFragments{}, err
	}
	if len(result.Fragments) > maxFragmentsListed {
		result.Fragments = result.Fragments[:maxFragmentsListed]
		result.Truncated = true
	}
	return result, nil
}

// DocumentSource delivers the original upload of a file document to anyone
// who may read its collection, including members of the chats a restricted
// collection is shared with. Pages have no source file.
func (s *Service) DocumentSource(ctx context.Context, current identity.User, documentID string) (files.Download, error) {
	document, err := s.GetDocument(ctx, current, documentID)
	if err != nil {
		return files.Download{}, err
	}
	if document.Kind != "file" || document.FileID == nil || s.files == nil {
		return files.Download{}, ErrNotFound
	}
	download, err := s.files.DownloadAuthorized(ctx, current.OrgID, *document.FileID)
	if errors.Is(err, files.ErrNotFound) {
		return files.Download{}, ErrNotFound
	}
	if errors.Is(err, files.ErrConflict) {
		return files.Download{}, fmt.Errorf("%w: the source file is not available", ErrConflict)
	}
	return download, err
}

// EmbeddingOption is a workspace connection that can embed documents. It
// carries no endpoint or credential details.
type EmbeddingOption struct {
	ID                  string `json:"id"`
	Name                string `json:"name"`
	Provider            string `json:"provider"`
	EmbeddingModel      string `json:"embedding_model"`
	Enabled             bool   `json:"enabled"`
	DataSharingApproved bool   `json:"data_sharing_approved"`
	// Available is true when documents would be embedded right now.
	Available bool `json:"available"`
}

// EmbeddingConnections lists connections with an embedding model for people
// who manage the knowledge base and choose one for a collection.
func (s *Service) EmbeddingConnections(ctx context.Context, current identity.User) ([]EmbeddingOption, error) {
	if !CanManage(current) {
		return nil, ErrForbidden
	}
	rows, err := s.pool.Query(ctx, `SELECT connection.id::text,connection.name,connection.provider,connection.embedding_model,
		connection.enabled,connection.embedding_data_sharing_approved,(`+embeddingReadyCondition+`)
		FROM agent_llm_connections connection
		WHERE connection.org_id=$1 AND connection.embedding_model<>'' AND connection.provider IN ('openai','openai-compatible')
		ORDER BY lower(connection.name),connection.id`, current.OrgID)
	if err != nil {
		return nil, fmt.Errorf("list embedding connections: %w", err)
	}
	defer rows.Close()
	result := make([]EmbeddingOption, 0)
	for rows.Next() {
		var option EmbeddingOption
		if err := rows.Scan(&option.ID, &option.Name, &option.Provider, &option.EmbeddingModel, &option.Enabled, &option.DataSharingApproved, &option.Available); err != nil {
			return nil, err
		}
		result = append(result, option)
	}
	return result, rows.Err()
}
