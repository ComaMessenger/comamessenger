package userstate

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/comamessenger/comamessenger/core/internal/identity"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

var (
	ErrForbidden       = errors.New("user state action forbidden")
	ErrNotFound        = errors.New("user state target not found")
	ErrInvalid         = errors.New("invalid user state input")
	ErrVersionConflict = errors.New("draft version conflict")
	ErrTooLarge        = errors.New("draft body too large")
)

type ReadMarker struct {
	ChatID       string    `json:"chat_id"`
	ThreadRootID *string   `json:"thread_root_id"`
	LastReadSeq  int64     `json:"last_read_seq"`
	LastReadAt   time.Time `json:"last_read_at"`
}

type Draft struct {
	ChatID       string    `json:"chat_id"`
	ThreadRootID *string   `json:"thread_root_id"`
	Body         string    `json:"body"`
	BodyFormat   string    `json:"body_format"`
	Version      int       `json:"version"`
	UpdatedAt    time.Time `json:"updated_at"`
}

type PutDraftInput struct {
	ThreadRootID    *string `json:"thread_root_id"`
	Body            string  `json:"body"`
	BodyFormat      string  `json:"body_format"`
	ExpectedVersion int     `json:"expected_version"`
}

type ChatUnread struct {
	ChatID       string `json:"chat_id"`
	LastReadSeq  int64  `json:"last_read_seq"`
	UnreadCount  int64  `json:"unread_count"`
	MentionCount int64  `json:"mention_count"`
}

type ThreadUnread struct {
	ThreadRootID string `json:"thread_root_id"`
	ChatID       string `json:"chat_id"`
	LastReadSeq  int64  `json:"last_read_seq"`
	UnreadCount  int64  `json:"unread_count"`
	MentionCount int64  `json:"mention_count"`
}

type UnreadSnapshot struct {
	Chats   []ChatUnread   `json:"chats"`
	Threads []ThreadUnread `json:"threads"`
}

type Service struct {
	pool         *pgxpool.Pool
	maxBodyBytes int
	afterCommit  func(orgID string, highWatermark int64)
}

func NewService(pool *pgxpool.Pool, maxBodyBytes int, afterCommit func(string, int64)) *Service {
	return &Service{pool: pool, maxBodyBytes: maxBodyBytes, afterCommit: afterCommit}
}

func (s *Service) MarkChatRead(ctx context.Context, user identity.User, sessionID, chatID string, lastReadSeq int64) (ReadMarker, bool, error) {
	if err := validateID("chat_id", chatID); err != nil || lastReadSeq < 1 {
		if err != nil {
			return ReadMarker{}, false, err
		}
		return ReadMarker{}, false, fmt.Errorf("%w: last_read_seq must be positive", ErrInvalid)
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return ReadMarker{}, false, fmt.Errorf("begin mark chat read: %w", err)
	}
	defer tx.Rollback(ctx)
	if err := lockOrganization(ctx, tx, user.OrgID); err != nil {
		return ReadMarker{}, false, err
	}
	if err := requireMembership(ctx, tx, user, chatID); err != nil {
		return ReadMarker{}, false, err
	}
	var exists bool
	if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM messages WHERE org_id=$1 AND chat_id=$2 AND created_seq=$3 AND thread_root_id IS NULL)`, user.OrgID, chatID, lastReadSeq).Scan(&exists); err != nil {
		return ReadMarker{}, false, fmt.Errorf("validate chat read target: %w", err)
	}
	if !exists {
		return ReadMarker{}, false, fmt.Errorf("%w: last_read_seq is not a main-feed message", ErrInvalid)
	}
	result := ReadMarker{ChatID: chatID, LastReadSeq: lastReadSeq}
	err = tx.QueryRow(ctx, `
		INSERT INTO chat_reads (org_id, chat_id, actor_id, last_read_seq)
		VALUES ($1,$2,$3,$4)
		ON CONFLICT (chat_id, actor_id) DO UPDATE
		SET last_read_seq=EXCLUDED.last_read_seq, last_read_at=now()
		WHERE chat_reads.last_read_seq < EXCLUDED.last_read_seq
		RETURNING last_read_seq,last_read_at`, user.OrgID, chatID, user.ActorID, lastReadSeq).Scan(&result.LastReadSeq, &result.LastReadAt)
	advanced := err == nil
	if errors.Is(err, pgx.ErrNoRows) {
		err = tx.QueryRow(ctx, `SELECT last_read_seq,last_read_at FROM chat_reads WHERE chat_id=$1 AND actor_id=$2`, chatID, user.ActorID).Scan(&result.LastReadSeq, &result.LastReadAt)
	}
	if err != nil {
		return ReadMarker{}, false, fmt.Errorf("upsert chat read: %w", err)
	}
	seq := int64(0)
	if advanced {
		seq, err = nextSequence(ctx, tx, user.OrgID)
		if err != nil {
			return ReadMarker{}, false, err
		}
		if err := insertActorEvent(ctx, tx, user, sessionID, chatID, chatID, seq, "read.marked", result); err != nil {
			return ReadMarker{}, false, err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return ReadMarker{}, false, fmt.Errorf("commit mark chat read: %w", err)
	}
	if advanced {
		s.notify(user.OrgID, seq)
	}
	return result, advanced, nil
}

func (s *Service) MarkThreadRead(ctx context.Context, user identity.User, sessionID, rootID string, lastReadSeq int64) (ReadMarker, bool, error) {
	if err := validateID("thread_root_id", rootID); err != nil || lastReadSeq < 1 {
		if err != nil {
			return ReadMarker{}, false, err
		}
		return ReadMarker{}, false, fmt.Errorf("%w: last_read_seq must be positive", ErrInvalid)
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return ReadMarker{}, false, fmt.Errorf("begin mark thread read: %w", err)
	}
	defer tx.Rollback(ctx)
	if err := lockOrganization(ctx, tx, user.OrgID); err != nil {
		return ReadMarker{}, false, err
	}
	chatID, err := requireThread(ctx, tx, user, rootID)
	if err != nil {
		return ReadMarker{}, false, err
	}
	var exists bool
	if err := tx.QueryRow(ctx, `SELECT EXISTS(
		SELECT 1 FROM messages WHERE org_id=$1 AND created_seq=$2
		AND (id=$3 OR thread_root_id=$3))`, user.OrgID, lastReadSeq, rootID).Scan(&exists); err != nil {
		return ReadMarker{}, false, fmt.Errorf("validate thread read target: %w", err)
	}
	if !exists {
		return ReadMarker{}, false, fmt.Errorf("%w: last_read_seq is not in this thread", ErrInvalid)
	}
	result := ReadMarker{ChatID: chatID, ThreadRootID: &rootID, LastReadSeq: lastReadSeq}
	err = tx.QueryRow(ctx, `
		INSERT INTO thread_reads (org_id, thread_root_id, actor_id, last_read_seq)
		VALUES ($1,$2,$3,$4)
		ON CONFLICT (thread_root_id, actor_id) DO UPDATE
		SET last_read_seq=EXCLUDED.last_read_seq, last_read_at=now()
		WHERE thread_reads.last_read_seq < EXCLUDED.last_read_seq
		RETURNING last_read_seq,last_read_at`, user.OrgID, rootID, user.ActorID, lastReadSeq).Scan(&result.LastReadSeq, &result.LastReadAt)
	advanced := err == nil
	if errors.Is(err, pgx.ErrNoRows) {
		err = tx.QueryRow(ctx, `SELECT last_read_seq,last_read_at FROM thread_reads WHERE thread_root_id=$1 AND actor_id=$2`, rootID, user.ActorID).Scan(&result.LastReadSeq, &result.LastReadAt)
	}
	if err != nil {
		return ReadMarker{}, false, fmt.Errorf("upsert thread read: %w", err)
	}
	seq := int64(0)
	if advanced {
		seq, err = nextSequence(ctx, tx, user.OrgID)
		if err != nil {
			return ReadMarker{}, false, err
		}
		if err := insertActorEvent(ctx, tx, user, sessionID, chatID, rootID, seq, "read.marked", result); err != nil {
			return ReadMarker{}, false, err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return ReadMarker{}, false, fmt.Errorf("commit mark thread read: %w", err)
	}
	if advanced {
		s.notify(user.OrgID, seq)
	}
	return result, advanced, nil
}

func (s *Service) PutDraft(ctx context.Context, user identity.User, sessionID, chatID string, input PutDraftInput) (Draft, bool, error) {
	if err := validateID("chat_id", chatID); err != nil {
		return Draft{}, false, err
	}
	if input.ThreadRootID != nil {
		if err := validateID("thread_root_id", *input.ThreadRootID); err != nil {
			return Draft{}, false, err
		}
	}
	if len([]byte(input.Body)) > s.maxBodyBytes {
		return Draft{}, false, ErrTooLarge
	}
	input.BodyFormat = strings.ToLower(strings.TrimSpace(input.BodyFormat))
	if input.BodyFormat == "" {
		input.BodyFormat = "plain"
	}
	if input.BodyFormat != "plain" && input.BodyFormat != "markdown" {
		return Draft{}, false, fmt.Errorf("%w: body_format must be plain or markdown", ErrInvalid)
	}
	if input.ExpectedVersion < 0 {
		return Draft{}, false, fmt.Errorf("%w: expected_version must not be negative", ErrInvalid)
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Draft{}, false, fmt.Errorf("begin put draft: %w", err)
	}
	defer tx.Rollback(ctx)
	if err := lockOrganization(ctx, tx, user.OrgID); err != nil {
		return Draft{}, false, err
	}
	if err := requireMembership(ctx, tx, user, chatID); err != nil {
		return Draft{}, false, err
	}
	if input.ThreadRootID != nil {
		threadChatID, err := requireThread(ctx, tx, user, *input.ThreadRootID)
		if err != nil {
			return Draft{}, false, err
		}
		if threadChatID != chatID {
			return Draft{}, false, fmt.Errorf("%w: thread root belongs to another chat", ErrInvalid)
		}
	}
	scopeID := chatID
	if input.ThreadRootID != nil {
		scopeID = *input.ThreadRootID
	}
	var current Draft
	err = tx.QueryRow(ctx, `SELECT chat_id,thread_root_id,body,body_format,version,updated_at FROM drafts WHERE actor_id=$1 AND scope_id=$2 FOR UPDATE`, user.ActorID, scopeID).
		Scan(&current.ChatID, &current.ThreadRootID, &current.Body, &current.BodyFormat, &current.Version, &current.UpdatedAt)
	created := false
	changed := false
	var result Draft
	if errors.Is(err, pgx.ErrNoRows) {
		if input.ExpectedVersion != 0 {
			return Draft{}, false, ErrVersionConflict
		}
		err = tx.QueryRow(ctx, `INSERT INTO drafts (org_id,actor_id,chat_id,thread_root_id,body,body_format) VALUES ($1,$2,$3,$4,$5,$6)
			RETURNING chat_id,thread_root_id,body,body_format,version,updated_at`, user.OrgID, user.ActorID, chatID, input.ThreadRootID, input.Body, input.BodyFormat).
			Scan(&result.ChatID, &result.ThreadRootID, &result.Body, &result.BodyFormat, &result.Version, &result.UpdatedAt)
		created, changed = true, true
	} else if err != nil {
		return Draft{}, false, fmt.Errorf("load draft: %w", err)
	} else if current.Body == input.Body && current.BodyFormat == input.BodyFormat {
		result = current
	} else {
		if input.ExpectedVersion != current.Version {
			return Draft{}, false, ErrVersionConflict
		}
		err = tx.QueryRow(ctx, `UPDATE drafts SET body=$3,body_format=$4,version=version+1,updated_at=now() WHERE actor_id=$1 AND scope_id=$2
			RETURNING chat_id,thread_root_id,body,body_format,version,updated_at`, user.ActorID, scopeID, input.Body, input.BodyFormat).
			Scan(&result.ChatID, &result.ThreadRootID, &result.Body, &result.BodyFormat, &result.Version, &result.UpdatedAt)
		changed = true
	}
	if err != nil {
		return Draft{}, false, fmt.Errorf("write draft: %w", err)
	}
	seq := int64(0)
	if changed {
		seq, err = nextSequence(ctx, tx, user.OrgID)
		if err != nil {
			return Draft{}, false, err
		}
		if err := insertActorEvent(ctx, tx, user, sessionID, chatID, scopeID, seq, "draft.updated", result); err != nil {
			return Draft{}, false, err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return Draft{}, false, fmt.Errorf("commit put draft: %w", err)
	}
	if changed {
		s.notify(user.OrgID, seq)
	}
	return result, created, nil
}

func (s *Service) DeleteDraft(ctx context.Context, user identity.User, sessionID, chatID string, threadRootID *string) (bool, error) {
	if err := validateID("chat_id", chatID); err != nil {
		return false, err
	}
	scopeID := chatID
	if threadRootID != nil {
		if err := validateID("thread_root_id", *threadRootID); err != nil {
			return false, err
		}
		scopeID = *threadRootID
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return false, fmt.Errorf("begin delete draft: %w", err)
	}
	defer tx.Rollback(ctx)
	if err := lockOrganization(ctx, tx, user.OrgID); err != nil {
		return false, err
	}
	if err := requireMembership(ctx, tx, user, chatID); err != nil {
		return false, err
	}
	command, err := tx.Exec(ctx, `DELETE FROM drafts WHERE org_id=$1 AND actor_id=$2 AND chat_id=$3 AND scope_id=$4`, user.OrgID, user.ActorID, chatID, scopeID)
	if err != nil {
		return false, fmt.Errorf("delete draft: %w", err)
	}
	removed := command.RowsAffected() == 1
	seq := int64(0)
	if removed {
		seq, err = nextSequence(ctx, tx, user.OrgID)
		if err != nil {
			return false, err
		}
		payload := map[string]any{"chat_id": chatID, "thread_root_id": threadRootID}
		if err := insertActorEvent(ctx, tx, user, sessionID, chatID, scopeID, seq, "draft.deleted", payload); err != nil {
			return false, err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return false, fmt.Errorf("commit delete draft: %w", err)
	}
	if removed {
		s.notify(user.OrgID, seq)
	}
	return removed, nil
}

func (s *Service) ListDrafts(ctx context.Context, user identity.User) ([]Draft, error) {
	rows, err := s.pool.Query(ctx, `SELECT d.chat_id,d.thread_root_id,d.body,d.body_format,d.version,d.updated_at FROM drafts d
		JOIN chats c ON c.org_id=d.org_id AND c.id=d.chat_id AND c.archived_at IS NULL
		JOIN chat_members cm ON cm.org_id=d.org_id AND cm.chat_id=d.chat_id AND cm.actor_id=d.actor_id
		WHERE d.org_id=$1 AND d.actor_id=$2 ORDER BY d.updated_at DESC`, user.OrgID, user.ActorID)
	if err != nil {
		return nil, fmt.Errorf("list drafts: %w", err)
	}
	defer rows.Close()
	result := make([]Draft, 0)
	for rows.Next() {
		var item Draft
		if err := rows.Scan(&item.ChatID, &item.ThreadRootID, &item.Body, &item.BodyFormat, &item.Version, &item.UpdatedAt); err != nil {
			return nil, fmt.Errorf("scan draft: %w", err)
		}
		result = append(result, item)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate drafts: %w", err)
	}
	return result, nil
}

func (s *Service) Unread(ctx context.Context, user identity.User) (UnreadSnapshot, error) {
	chatRows, err := s.pool.Query(ctx, `
		SELECT c.id,COALESCE(cr.last_read_seq,0),
			count(m.id) FILTER (WHERE m.created_seq>COALESCE(cr.last_read_seq,0) AND m.actor_id<>$2 AND m.deleted_at IS NULL),
			count(m.id) FILTER (WHERE m.created_seq>COALESCE(cr.last_read_seq,0) AND m.actor_id<>$2 AND m.deleted_at IS NULL AND $2=ANY(m.mentioned_actor_ids))
		FROM chats c JOIN chat_members cm ON cm.org_id=c.org_id AND cm.chat_id=c.id AND cm.actor_id=$2
		LEFT JOIN chat_reads cr ON cr.org_id=c.org_id AND cr.chat_id=c.id AND cr.actor_id=$2
		LEFT JOIN messages m ON m.org_id=c.org_id AND m.chat_id=c.id AND m.thread_root_id IS NULL
		WHERE c.org_id=$1 AND c.archived_at IS NULL GROUP BY c.id,cr.last_read_seq ORDER BY c.id`, user.OrgID, user.ActorID)
	if err != nil {
		return UnreadSnapshot{}, fmt.Errorf("query chat unread: %w", err)
	}
	chats := make([]ChatUnread, 0)
	for chatRows.Next() {
		var item ChatUnread
		if err := chatRows.Scan(&item.ChatID, &item.LastReadSeq, &item.UnreadCount, &item.MentionCount); err != nil {
			chatRows.Close()
			return UnreadSnapshot{}, fmt.Errorf("scan chat unread: %w", err)
		}
		chats = append(chats, item)
	}
	if err := chatRows.Err(); err != nil {
		chatRows.Close()
		return UnreadSnapshot{}, fmt.Errorf("iterate chat unread: %w", err)
	}
	chatRows.Close()
	threadRows, err := s.pool.Query(ctx, `
		SELECT root.id,root.chat_id,COALESCE(tr.last_read_seq,root.created_seq),
			count(reply.id) FILTER (WHERE reply.created_seq>COALESCE(tr.last_read_seq,root.created_seq) AND reply.actor_id<>$2 AND reply.deleted_at IS NULL),
			count(reply.id) FILTER (WHERE reply.created_seq>COALESCE(tr.last_read_seq,root.created_seq) AND reply.actor_id<>$2 AND reply.deleted_at IS NULL AND $2=ANY(reply.mentioned_actor_ids))
		FROM thread_followers tf JOIN messages root ON root.org_id=tf.org_id AND root.id=tf.thread_root_id
		JOIN chats c ON c.org_id=root.org_id AND c.id=root.chat_id AND c.archived_at IS NULL
		JOIN chat_members cm ON cm.org_id=c.org_id AND cm.chat_id=c.id AND cm.actor_id=$2
		LEFT JOIN thread_reads tr ON tr.org_id=tf.org_id AND tr.thread_root_id=tf.thread_root_id AND tr.actor_id=$2
		LEFT JOIN messages reply ON reply.org_id=root.org_id AND reply.thread_root_id=root.id
		WHERE tf.org_id=$1 AND tf.actor_id=$2 GROUP BY root.id,tr.last_read_seq ORDER BY root.id`, user.OrgID, user.ActorID)
	if err != nil {
		return UnreadSnapshot{}, fmt.Errorf("query thread unread: %w", err)
	}
	defer threadRows.Close()
	threads := make([]ThreadUnread, 0)
	for threadRows.Next() {
		var item ThreadUnread
		if err := threadRows.Scan(&item.ThreadRootID, &item.ChatID, &item.LastReadSeq, &item.UnreadCount, &item.MentionCount); err != nil {
			return UnreadSnapshot{}, fmt.Errorf("scan thread unread: %w", err)
		}
		threads = append(threads, item)
	}
	if err := threadRows.Err(); err != nil {
		return UnreadSnapshot{}, fmt.Errorf("iterate thread unread: %w", err)
	}
	return UnreadSnapshot{Chats: chats, Threads: threads}, nil
}

func validateID(name, value string) error {
	if _, err := uuid.Parse(value); err != nil {
		return fmt.Errorf("%w: %s must be a UUID", ErrInvalid, name)
	}
	return nil
}
func lockOrganization(ctx context.Context, tx pgx.Tx, orgID string) error {
	var seq int64
	err := tx.QueryRow(ctx, `SELECT event_seq FROM organizations WHERE id=$1 FOR UPDATE`, orgID).Scan(&seq)
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrForbidden
	}
	if err != nil {
		return fmt.Errorf("lock organization: %w", err)
	}
	return nil
}
func requireMembership(ctx context.Context, tx pgx.Tx, user identity.User, chatID string) error {
	var ok bool
	err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM chats c JOIN chat_members cm ON cm.org_id=c.org_id AND cm.chat_id=c.id AND cm.actor_id=$3 JOIN actors a ON a.org_id=cm.org_id AND a.id=cm.actor_id WHERE c.org_id=$1 AND c.id=$2 AND c.archived_at IS NULL AND a.status='active' AND a.deleted_at IS NULL)`, user.OrgID, chatID, user.ActorID).Scan(&ok)
	if err != nil {
		return fmt.Errorf("authorize membership: %w", err)
	}
	if !ok {
		return ErrNotFound
	}
	return nil
}
func requireThread(ctx context.Context, tx pgx.Tx, user identity.User, rootID string) (string, error) {
	var chatID string
	err := tx.QueryRow(ctx, `SELECT m.chat_id FROM messages m JOIN chats c ON c.org_id=m.org_id AND c.id=m.chat_id AND c.archived_at IS NULL JOIN chat_members cm ON cm.org_id=c.org_id AND cm.chat_id=c.id AND cm.actor_id=$3 WHERE m.org_id=$1 AND m.id=$2 AND m.thread_root_id IS NULL`, user.OrgID, rootID, user.ActorID).Scan(&chatID)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", ErrNotFound
	}
	if err != nil {
		return "", fmt.Errorf("authorize thread: %w", err)
	}
	return chatID, nil
}
func nextSequence(ctx context.Context, tx pgx.Tx, orgID string) (int64, error) {
	var seq int64
	if err := tx.QueryRow(ctx, `UPDATE organizations SET event_seq=event_seq+1 WHERE id=$1 RETURNING event_seq`, orgID).Scan(&seq); err != nil {
		return 0, fmt.Errorf("allocate event sequence: %w", err)
	}
	return seq, nil
}
func insertActorEvent(ctx context.Context, tx pgx.Tx, user identity.User, sessionID, chatID, subjectID string, seq int64, eventType string, data any) error {
	payload, err := json.Marshal(data)
	if err != nil {
		return fmt.Errorf("marshal user state event: %w", err)
	}
	_, err = tx.Exec(ctx, `INSERT INTO events(org_id,seq,type,actor_id,chat_id,subject_id,audience_actor_id,exclude_session_id,data) VALUES($1,$2,$3,$4,$5,$6,$4,NULLIF($7,'')::uuid,$8::jsonb)`, user.OrgID, seq, eventType, user.ActorID, chatID, subjectID, sessionID, string(payload))
	if err != nil {
		return fmt.Errorf("insert user state event: %w", err)
	}
	return nil
}
func (s *Service) notify(orgID string, seq int64) {
	if s.afterCommit != nil {
		s.afterCommit(orgID, seq)
	}
}
