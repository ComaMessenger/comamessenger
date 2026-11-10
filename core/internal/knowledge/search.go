package knowledge

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"sort"
	"strings"
	"unicode/utf8"

	"github.com/comamessenger/comamessenger/core/internal/identity"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

const (
	defaultSearchLimit = 8
	maxSearchLimit     = 50
	maxQueryRunes      = 500
	// candidatePool is how many hits each retriever contributes before fusion.
	candidatePool = 50
	// minSimilarity drops semantic neighbours that are not about the query, so
	// an empty answer stays possible when the knowledge base has none.
	minSimilarity = 0.3
	// rrfK is the usual reciprocal-rank-fusion constant.
	rrfK = 60.0
)

type SearchInput struct {
	Query         string   `json:"query"`
	CollectionIDs []string `json:"collection_ids"`
	Limit         int      `json:"limit"`
}

// Fragment is one search hit with everything needed to cite it.
type Fragment struct {
	ChunkID        string  `json:"chunk_id"`
	CollectionID   string  `json:"collection_id"`
	CollectionName string  `json:"collection_name"`
	DocumentID     string  `json:"document_id"`
	DocumentTitle  string  `json:"document_title"`
	DocumentKind   string  `json:"document_kind"`
	Section        string  `json:"section"`
	Position       int     `json:"position"`
	Content        string  `json:"content"`
	Score          float64 `json:"score"`
	Match          string  `json:"match"`
}

type SearchResult struct {
	Fragments []Fragment `json:"fragments"`
	// Semantic reports whether vector search contributed to the ranking.
	Semantic bool `json:"semantic"`
}

// Search finds fragments in collections the user may read.
func (s *Service) Search(ctx context.Context, current identity.User, input SearchInput) (SearchResult, error) {
	query, limit, requested, err := normalizeSearch(input)
	if err != nil {
		return SearchResult{}, err
	}
	rows, err := s.pool.Query(ctx, `SELECT collection.id::text,collection.embedding_connection_id::text FROM knowledge_collections collection
		WHERE `+readableCondition+` AND (cardinality($4::uuid[])=0 OR collection.id=ANY($4::uuid[]))`,
		current.OrgID, current.ActorID, CanManage(current), requested)
	if err != nil {
		return SearchResult{}, fmt.Errorf("resolve readable knowledge collections: %w", err)
	}
	scopes, err := scanScopes(rows)
	if err != nil {
		return SearchResult{}, err
	}
	if len(requested) > 0 && len(scopes) != len(requested) {
		return SearchResult{}, ErrNotFound
	}
	return s.search(ctx, current.OrgID, query, limit, scopes)
}

type collectionScope struct {
	id           string
	connectionID *string
}

func scanScopes(rows pgx.Rows) ([]collectionScope, error) {
	defer rows.Close()
	result := make([]collectionScope, 0)
	for rows.Next() {
		var scope collectionScope
		if err := rows.Scan(&scope.id, &scope.connectionID); err != nil {
			return nil, err
		}
		result = append(result, scope)
	}
	return result, rows.Err()
}

func normalizeSearch(input SearchInput) (string, int, []string, error) {
	query := strings.Join(strings.Fields(input.Query), " ")
	limit := input.Limit
	if limit == 0 {
		limit = defaultSearchLimit
	}
	if query == "" || utf8.RuneCountInString(query) > maxQueryRunes || limit < 1 || limit > maxSearchLimit {
		return "", 0, nil, fmt.Errorf("%w: query must contain 1 to %d characters and limit must be 1 to %d", ErrInvalid, maxQueryRunes, maxSearchLimit)
	}
	requested, err := normalizeIDs(input.CollectionIDs, 50)
	if err != nil {
		return "", 0, nil, err
	}
	return query, limit, requested, nil
}

// AgentSearchInput identifies the run whose bound collections are searched.
type AgentSearchInput struct {
	OrgID      string
	AgentID    string
	RunID      string
	ToolCallID string
	Query      string
	Limit      int
}

// SearchForAgent searches only the collections bound to the agent version
// the run executes. Collections shared with selected chats are visible only
// when the run belongs to one of those chats. Every returned fragment is
// recorded against the tool call for sources and audit.
func (s *Service) SearchForAgent(ctx context.Context, input AgentSearchInput) (SearchResult, error) {
	query, limit, _, err := normalizeSearch(SearchInput{Query: input.Query, Limit: input.Limit})
	if err != nil {
		return SearchResult{}, err
	}
	if uuid.Validate(input.RunID) != nil || uuid.Validate(input.ToolCallID) != nil {
		return SearchResult{}, fmt.Errorf("%w: run and tool call are required", ErrInvalid)
	}
	rows, err := s.pool.Query(ctx, `SELECT collection.id::text,collection.embedding_connection_id::text
		FROM agent_runs run
		JOIN agents agent ON agent.org_id=run.org_id AND agent.actor_id=run.agent_id
		JOIN knowledge_collections collection ON collection.org_id=run.org_id AND collection.id=ANY(
			CASE WHEN run.agent_config ? 'knowledge_collection_ids'
			THEN ARRAY(SELECT jsonb_array_elements_text(run.agent_config->'knowledge_collection_ids'))::uuid[]
			ELSE agent.knowledge_collection_ids END)
		WHERE run.org_id=$1 AND run.id=$2 AND run.agent_id=$3
		  AND (collection.access='organization' OR EXISTS(
			SELECT 1 FROM knowledge_collection_chats shared
			WHERE shared.org_id=collection.org_id AND shared.collection_id=collection.id AND shared.chat_id=run.chat_id))`,
		input.OrgID, input.RunID, input.AgentID)
	if err != nil {
		return SearchResult{}, fmt.Errorf("resolve agent knowledge collections: %w", err)
	}
	scopes, err := scanScopes(rows)
	if err != nil {
		return SearchResult{}, err
	}
	result, err := s.search(ctx, input.OrgID, query, limit, scopes)
	if err != nil {
		return SearchResult{}, err
	}
	if len(result.Fragments) == 0 {
		return result, nil
	}
	batch := &pgx.Batch{}
	for index, fragment := range result.Fragments {
		batch.Queue(`INSERT INTO agent_run_knowledge_chunks(org_id,run_id,tool_call_id,chunk_id,document_id,collection_id,document_title,section,position,rank)
			VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT DO NOTHING`,
			input.OrgID, input.RunID, input.ToolCallID, fragment.ChunkID, fragment.DocumentID, fragment.CollectionID,
			fragment.DocumentTitle, fragment.Section, fragment.Position, index+1)
	}
	if err := s.pool.SendBatch(ctx, batch).Close(); err != nil {
		return SearchResult{}, fmt.Errorf("record issued knowledge fragments: %w", err)
	}
	return result, nil
}

// IssuedFragment is a fragment that was handed to a model during a run.
type IssuedFragment struct {
	ToolCallID    string `json:"tool_call_id"`
	ChunkID       string `json:"chunk_id"`
	DocumentID    string `json:"document_id"`
	CollectionID  string `json:"collection_id"`
	DocumentTitle string `json:"document_title"`
	Section       string `json:"section"`
	Position      int    `json:"position"`
	Rank          int    `json:"rank"`
	// Available is false once the document or fragment has been removed.
	Available bool `json:"available"`
}

// RunFragments lists the fragments issued to a run, in issue order.
func (s *Service) RunFragments(ctx context.Context, orgID, runID string) ([]IssuedFragment, error) {
	rows, err := s.pool.Query(ctx, `SELECT issued.tool_call_id,issued.chunk_id,issued.document_id,issued.collection_id,issued.document_title,
		issued.section,issued.position,issued.rank,
		EXISTS(SELECT 1 FROM knowledge_chunks chunk WHERE chunk.org_id=issued.org_id AND chunk.id=issued.chunk_id)
		FROM agent_run_knowledge_chunks issued WHERE issued.org_id=$1 AND issued.run_id=$2
		ORDER BY issued.created_at,issued.tool_call_id,issued.rank`, orgID, runID)
	if err != nil {
		return nil, fmt.Errorf("list issued knowledge fragments: %w", err)
	}
	defer rows.Close()
	result := make([]IssuedFragment, 0)
	for rows.Next() {
		var item IssuedFragment
		if err := rows.Scan(&item.ToolCallID, &item.ChunkID, &item.DocumentID, &item.CollectionID, &item.DocumentTitle, &item.Section, &item.Position, &item.Rank, &item.Available); err != nil {
			return nil, err
		}
		result = append(result, item)
	}
	return result, rows.Err()
}

const fragmentFields = `chunk.id::text,chunk.collection_id::text,collection.name,chunk.document_id::text,document.title,document.kind,
	chunk.section,chunk.position,chunk.content`

const fragmentJoins = ` JOIN knowledge_documents document ON document.org_id=chunk.org_id AND document.id=chunk.document_id
	JOIN knowledge_collections collection ON collection.org_id=chunk.org_id AND collection.id=chunk.collection_id`

const textSearchSQL = `WITH query AS (
	SELECT websearch_to_tsquery('russian'::regconfig,$3) || websearch_to_tsquery('english'::regconfig,$3) || websearch_to_tsquery('simple'::regconfig,$3) AS terms
)
SELECT ` + fragmentFields + `,ts_rank_cd(chunk.search_vector,query.terms,32)::float8
FROM query JOIN knowledge_chunks chunk ON chunk.org_id=$1 AND chunk.collection_id=ANY($2::uuid[]) AND chunk.search_vector @@ query.terms` + fragmentJoins + `
ORDER BY 10 DESC,chunk.document_id,chunk.position LIMIT $4`

const vectorSearchSQL = `SELECT ` + fragmentFields + `,(1-(chunk.embedding <=> $3::vector))::float8
FROM knowledge_chunks chunk` + fragmentJoins + `
WHERE chunk.org_id=$1 AND chunk.collection_id=ANY($2::uuid[]) AND chunk.embedding IS NOT NULL
  AND chunk.embedding_provider=$4 AND chunk.embedding_model=$5 AND chunk.embedding_dimensions=$6
ORDER BY chunk.embedding <=> $3::vector LIMIT $7`

func scanFragments(rows pgx.Rows, match string) ([]Fragment, error) {
	defer rows.Close()
	result := make([]Fragment, 0)
	for rows.Next() {
		var fragment Fragment
		if err := rows.Scan(&fragment.ChunkID, &fragment.CollectionID, &fragment.CollectionName, &fragment.DocumentID, &fragment.DocumentTitle,
			&fragment.DocumentKind, &fragment.Section, &fragment.Position, &fragment.Content, &fragment.Score); err != nil {
			return nil, err
		}
		fragment.Match = match
		result = append(result, fragment)
	}
	return result, rows.Err()
}

// search runs full-text search over every collection and, per embedding
// connection, vector search over collections that use it, then merges the
// rankings with reciprocal rank fusion. A failing embeddings provider only
// disables the semantic half; full-text results are still returned.
func (s *Service) search(ctx context.Context, orgID, query string, limit int, scopes []collectionScope) (SearchResult, error) {
	result := SearchResult{Fragments: []Fragment{}}
	if len(scopes) == 0 {
		return result, nil
	}
	allIDs := make([]string, 0, len(scopes))
	byConnection := map[string][]string{}
	for _, scope := range scopes {
		allIDs = append(allIDs, scope.id)
		if scope.connectionID != nil {
			byConnection[*scope.connectionID] = append(byConnection[*scope.connectionID], scope.id)
		}
	}
	rows, err := s.pool.Query(ctx, textSearchSQL, orgID, allIDs, query, candidatePool)
	if err != nil {
		return SearchResult{}, fmt.Errorf("search knowledge text: %w", err)
	}
	textHits, err := scanFragments(rows, "text")
	if err != nil {
		return SearchResult{}, fmt.Errorf("scan knowledge text hits: %w", err)
	}
	var vectorHits [][]Fragment
	connectionIDs := make([]string, 0, len(byConnection))
	for connectionID := range byConnection {
		connectionIDs = append(connectionIDs, connectionID)
	}
	sort.Strings(connectionIDs)
	for _, connectionID := range connectionIDs {
		hits, err := s.vectorSearch(ctx, orgID, connectionID, byConnection[connectionID], query)
		if err != nil {
			slog.Default().Warn("knowledge semantic search unavailable", "org_id", orgID, "connection_id", connectionID, "error", err)
			continue
		}
		if len(hits) > 0 {
			result.Semantic = true
			vectorHits = append(vectorHits, hits)
		}
	}
	result.Fragments = fuse(textHits, vectorHits, limit)
	return result, nil
}

func (s *Service) vectorSearch(ctx context.Context, orgID, connectionID string, collectionIDs []string, query string) ([]Fragment, error) {
	if s.connections == nil || s.embedder == nil {
		return nil, nil
	}
	var embedded bool
	if err := s.pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM knowledge_chunks WHERE org_id=$1 AND collection_id=ANY($2::uuid[]) AND embedding IS NOT NULL)`, orgID, collectionIDs).Scan(&embedded); err != nil || !embedded {
		return nil, err
	}
	connection, err := s.connections.EmbeddingConnection(ctx, orgID, connectionID)
	if err != nil {
		return nil, err
	}
	vectors, err := s.embedder.Embed(ctx, connection, []string{query})
	if err != nil {
		return nil, err
	}
	if len(vectors) != 1 {
		return nil, errors.New("embedding provider returned no query vector")
	}
	rows, err := s.pool.Query(ctx, vectorSearchSQL, orgID, collectionIDs, vectorLiteral(vectors[0]), connection.Provider, connection.Model, len(vectors[0]), candidatePool)
	if err != nil {
		return nil, fmt.Errorf("search knowledge vectors: %w", err)
	}
	hits, err := scanFragments(rows, "semantic")
	if err != nil {
		return nil, err
	}
	kept := hits[:0]
	for _, hit := range hits {
		if hit.Score >= minSimilarity {
			kept = append(kept, hit)
		}
	}
	return kept, nil
}

func fuse(textHits []Fragment, vectorLists [][]Fragment, limit int) []Fragment {
	type scored struct {
		fragment Fragment
		score    float64
		text     bool
		semantic bool
	}
	merged := map[string]*scored{}
	add := func(hits []Fragment, semantic bool) {
		for rank, hit := range hits {
			entry, exists := merged[hit.ChunkID]
			if !exists {
				entry = &scored{fragment: hit}
				merged[hit.ChunkID] = entry
			}
			entry.score += 1 / (rrfK + float64(rank+1))
			if semantic {
				entry.semantic = true
			} else {
				entry.text = true
			}
		}
	}
	add(textHits, false)
	for _, hits := range vectorLists {
		add(hits, true)
	}
	ordered := make([]*scored, 0, len(merged))
	for _, entry := range merged {
		ordered = append(ordered, entry)
	}
	sort.Slice(ordered, func(left, right int) bool {
		if ordered[left].score != ordered[right].score {
			return ordered[left].score > ordered[right].score
		}
		if ordered[left].fragment.DocumentID != ordered[right].fragment.DocumentID {
			return ordered[left].fragment.DocumentID < ordered[right].fragment.DocumentID
		}
		return ordered[left].fragment.Position < ordered[right].fragment.Position
	})
	if len(ordered) > limit {
		ordered = ordered[:limit]
	}
	result := make([]Fragment, len(ordered))
	for index, entry := range ordered {
		fragment := entry.fragment
		fragment.Score = entry.score
		switch {
		case entry.text && entry.semantic:
			fragment.Match = "hybrid"
		case entry.semantic:
			fragment.Match = "semantic"
		default:
			fragment.Match = "text"
		}
		result[index] = fragment
	}
	return result
}
