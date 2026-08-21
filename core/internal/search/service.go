package search

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"strings"
	"time"

	"github.com/comamessenger/comamessenger/core/internal/identity"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

var ErrInvalid = errors.New("invalid search input")

type Input struct {
	Query    string
	ChatID   string
	AuthorID string
	From     *time.Time
	To       *time.Time
	Type     string
	InThread *bool
	Cursor   string
	Limit    int
}

type Result struct {
	Kind         string    `json:"kind"`
	ChatID       string    `json:"chat_id"`
	MessageID    string    `json:"message_id"`
	ThreadRootID *string   `json:"thread_root_id"`
	ActorID      string    `json:"actor_id"`
	FileID       *string   `json:"file_id,omitempty"`
	FileName     *string   `json:"file_name,omitempty"`
	FileMIME     *string   `json:"file_mime,omitempty"`
	Snippet      string    `json:"snippet"`
	Rank         float32   `json:"rank"`
	CreatedSeq   int64     `json:"created_seq"`
	CreatedAt    time.Time `json:"created_at"`
	resultID     string
}

type Page struct {
	Results    []Result `json:"results"`
	NextCursor *string  `json:"next_cursor"`
}

type Service struct{ pool *pgxpool.Pool }

func NewService(pool *pgxpool.Pool) *Service { return &Service{pool: pool} }

type cursor struct {
	Fingerprint string `json:"f"`
	RankBits    uint32 `json:"r"`
	CreatedSeq  int64  `json:"s"`
	ResultID    string `json:"i"`
}

func (s *Service) Search(ctx context.Context, user identity.User, input Input) (Page, error) {
	if s.pool == nil {
		return Page{}, errors.New("search database is unavailable")
	}
	input.Query = strings.TrimSpace(input.Query)
	input.Type = strings.TrimSpace(input.Type)
	if input.Type == "" {
		input.Type = "all"
	}
	if input.Limit == 0 {
		input.Limit = 30
	}
	if input.Query == "" || len([]rune(input.Query)) > 200 || input.Limit < 1 || input.Limit > 100 || (input.Type != "all" && input.Type != "message" && input.Type != "file") {
		return Page{}, fmt.Errorf("%w: invalid query, type, or limit", ErrInvalid)
	}
	if input.ChatID != "" {
		if _, err := uuid.Parse(input.ChatID); err != nil {
			return Page{}, fmt.Errorf("%w: invalid chat_id", ErrInvalid)
		}
	}
	if input.AuthorID != "" {
		if _, err := uuid.Parse(input.AuthorID); err != nil {
			return Page{}, fmt.Errorf("%w: invalid author_id", ErrInvalid)
		}
	}
	if input.From != nil && input.To != nil && input.From.After(*input.To) {
		return Page{}, fmt.Errorf("%w: from must not be after to", ErrInvalid)
	}
	fingerprint := inputFingerprint(input)
	var afterRank *float32
	var afterSeq int64
	var afterID string
	if input.Cursor != "" {
		decoded, err := decodeCursor(input.Cursor)
		if err != nil || decoded.Fingerprint != fingerprint || decoded.CreatedSeq < 1 || decoded.ResultID == "" {
			return Page{}, fmt.Errorf("%w: invalid cursor", ErrInvalid)
		}
		value := math.Float32frombits(decoded.RankBits)
		afterRank, afterSeq, afterID = &value, decoded.CreatedSeq, decoded.ResultID
	}
	rows, err := s.pool.Query(ctx, searchSQL, user.OrgID, user.ActorID, input.Query, input.ChatID, input.AuthorID,
		input.From, input.To, input.Type, input.InThread, afterRank, afterSeq, afterID, input.Limit+1)
	if err != nil {
		return Page{}, fmt.Errorf("search messages and files: %w", err)
	}
	defer rows.Close()
	results := make([]Result, 0, input.Limit+1)
	for rows.Next() {
		var result Result
		if err := rows.Scan(&result.Kind, &result.ChatID, &result.MessageID, &result.ThreadRootID, &result.ActorID,
			&result.FileID, &result.FileName, &result.FileMIME, &result.Snippet, &result.Rank,
			&result.CreatedSeq, &result.CreatedAt, &result.resultID); err != nil {
			return Page{}, fmt.Errorf("scan search result: %w", err)
		}
		results = append(results, result)
	}
	if err := rows.Err(); err != nil {
		return Page{}, fmt.Errorf("iterate search results: %w", err)
	}
	page := Page{Results: results}
	if len(results) > input.Limit {
		page.Results = results[:input.Limit]
		last := page.Results[len(page.Results)-1]
		encoded := encodeCursor(cursor{Fingerprint: fingerprint, RankBits: math.Float32bits(last.Rank), CreatedSeq: last.CreatedSeq, ResultID: last.resultID})
		page.NextCursor = &encoded
	}
	return page, nil
}

func inputFingerprint(input Input) string {
	encoded, _ := json.Marshal(struct {
		Query, ChatID, AuthorID, Type string
		From, To                      *time.Time
		InThread                      *bool
	}{input.Query, input.ChatID, input.AuthorID, input.Type, input.From, input.To, input.InThread})
	digest := sha256.Sum256(encoded)
	return hex.EncodeToString(digest[:8])
}

func encodeCursor(value cursor) string {
	encoded, _ := json.Marshal(value)
	return base64.RawURLEncoding.EncodeToString(encoded)
}

func decodeCursor(value string) (cursor, error) {
	decoded, err := base64.RawURLEncoding.DecodeString(value)
	if err != nil || len(decoded) > 1024 {
		return cursor{}, ErrInvalid
	}
	var result cursor
	if err := json.Unmarshal(decoded, &result); err != nil {
		return cursor{}, ErrInvalid
	}
	return result, nil
}

const searchSQL = `
WITH query AS (
  SELECT
    websearch_to_tsquery('russian'::regconfig, $3) ||
    websearch_to_tsquery('english'::regconfig, $3) ||
    websearch_to_tsquery('simple'::regconfig, $3) AS terms,
    websearch_to_tsquery('simple'::regconfig, $3) AS headline_terms
), matches AS (
  SELECT 'message'::text AS kind, m.chat_id, m.id AS message_id, m.thread_root_id, m.actor_id,
         NULL::uuid AS file_id, NULL::text AS file_name, NULL::text AS file_mime,
         regexp_replace(ts_headline('simple'::regconfig, m.body, query.headline_terms,
           'MaxFragments=2, MinWords=8, MaxWords=35, ShortWord=2'), '</?b>', '', 'gi') AS snippet,
         ts_rank_cd(m.search_vector, query.terms, 32) AS rank,
         m.created_seq, m.created_at, 'm:' || m.id::text AS result_id
  FROM query
  JOIN messages m ON m.org_id = $1 AND m.deleted_at IS NULL AND m.search_vector @@ query.terms
  JOIN chats c ON c.org_id = m.org_id AND c.id = m.chat_id AND c.archived_at IS NULL
  JOIN chat_members visible ON visible.org_id = m.org_id AND visible.chat_id = m.chat_id AND visible.actor_id = $2
  WHERE $8 IN ('all', 'message')
    AND ($4 = '' OR m.chat_id = NULLIF($4, '')::uuid)
    AND ($5 = '' OR m.actor_id = NULLIF($5, '')::uuid)
    AND ($6::timestamptz IS NULL OR m.created_at >= $6)
    AND ($7::timestamptz IS NULL OR m.created_at <= $7)
    AND ($9::boolean IS NULL OR ($9 AND m.thread_root_id IS NOT NULL) OR (NOT $9 AND m.thread_root_id IS NULL))
  UNION ALL
  SELECT 'file'::text, m.chat_id, m.id, m.thread_root_id, m.actor_id,
         f.id, f.name, f.mime,
         regexp_replace(ts_headline('simple'::regconfig, coalesce(f.extracted_text, f.name), query.headline_terms,
           'MaxFragments=2, MinWords=8, MaxWords=35, ShortWord=2'), '</?b>', '', 'gi'),
         ts_rank_cd(f.search_vector, query.terms, 32),
         m.created_seq, m.created_at, 'f:' || f.id::text || ':' || m.id::text
  FROM query
  JOIN files f ON f.org_id = $1 AND f.status = 'ready' AND f.search_vector @@ query.terms
  JOIN message_files mf ON mf.org_id = f.org_id AND mf.file_id = f.id
  JOIN messages m ON m.org_id = mf.org_id AND m.id = mf.message_id AND m.deleted_at IS NULL
  JOIN chats c ON c.org_id = m.org_id AND c.id = m.chat_id AND c.archived_at IS NULL
  JOIN chat_members visible ON visible.org_id = m.org_id AND visible.chat_id = m.chat_id AND visible.actor_id = $2
  WHERE $8 IN ('all', 'file')
    AND ($4 = '' OR m.chat_id = NULLIF($4, '')::uuid)
    AND ($5 = '' OR m.actor_id = NULLIF($5, '')::uuid)
    AND ($6::timestamptz IS NULL OR m.created_at >= $6)
    AND ($7::timestamptz IS NULL OR m.created_at <= $7)
    AND ($9::boolean IS NULL OR ($9 AND m.thread_root_id IS NOT NULL) OR (NOT $9 AND m.thread_root_id IS NULL))
)
SELECT kind, chat_id, message_id, thread_root_id, actor_id, file_id, file_name, file_mime,
       snippet, rank, created_seq, created_at, result_id
FROM matches
WHERE $10::real IS NULL OR rank < $10 OR
      (rank = $10 AND created_seq < $11) OR
      (rank = $10 AND created_seq = $11 AND result_id > $12)
ORDER BY rank DESC, created_seq DESC, result_id
LIMIT $13`
