package message

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/comamessenger/comamessenger/core/internal/authz"
	"github.com/comamessenger/comamessenger/core/internal/id"
	"github.com/comamessenger/comamessenger/core/internal/identity"
	"github.com/comamessenger/comamessenger/core/internal/permission"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

var (
	ErrForbidden           = errors.New("message action forbidden")
	ErrNotFound            = errors.New("message not found")
	ErrInvalid             = errors.New("invalid message input")
	ErrTooLarge            = errors.New("message body too large")
	ErrIdempotencyConflict = errors.New("message idempotency conflict")
	ErrVersionConflict     = errors.New("message version conflict")
	ErrRateLimited         = errors.New("message action rate limited")
)

type Message struct {
	ID                string              `json:"id"`
	ChatID            string              `json:"chat_id"`
	ActorID           string              `json:"actor_id"`
	ClientMsgID       string              `json:"client_msg_id"`
	Type              string              `json:"type"`
	Body              string              `json:"body"`
	BodyFormat        string              `json:"body_format"`
	ReplyToID         *string             `json:"reply_to_id"`
	ThreadRootID      *string             `json:"thread_root_id"`
	Version           int                 `json:"version"`
	CreatedSeq        int64               `json:"created_seq"`
	CreatedAt         time.Time           `json:"created_at"`
	EditedAt          *time.Time          `json:"edited_at"`
	DeletedAt         *time.Time          `json:"deleted_at"`
	ForwardedFrom     *ForwardAttribution `json:"forwarded_from,omitempty"`
	MentionedActorIDs []string            `json:"mentioned_actor_ids"`
	ThreadReplyCount  int64               `json:"thread_reply_count"`
}

type ForwardAttribution struct {
	AuthorName   string    `json:"author_name"`
	AuthorHandle string    `json:"author_handle"`
	CreatedAt    time.Time `json:"created_at"`
}

type CreateInput struct {
	ClientMsgID       string   `json:"client_msg_id"`
	Body              string   `json:"body"`
	BodyFormat        string   `json:"body_format"`
	ReplyToID         *string  `json:"reply_to_id"`
	ThreadRootID      *string  `json:"thread_root_id"`
	MentionedActorIDs []string `json:"mentioned_actor_ids"`
}

type UpdateInput struct {
	Body              string    `json:"body"`
	BodyFormat        string    `json:"body_format"`
	ExpectedVersion   int       `json:"expected_version"`
	MentionedActorIDs *[]string `json:"mentioned_actor_ids"`
}

type ListOptions struct {
	BeforeSeq    *int64
	Limit        int
	ThreadRootID *string
}

type Page struct {
	Messages      []Message `json:"messages"`
	NextBeforeSeq *int64    `json:"next_before_seq"`
}

type Window struct {
	Messages   []Message `json:"messages"`
	TargetID   string    `json:"target_id"`
	HasEarlier bool      `json:"has_earlier"`
	HasLater   bool      `json:"has_later"`
}

type Service struct {
	pool         *pgxpool.Pool
	maxBodyBytes int
	maxPageSize  int
	afterCommit  func(orgID string, highWatermark int64)
}

func NewService(pool *pgxpool.Pool, maxBodyBytes, maxPageSize int, afterCommit func(orgID string, highWatermark int64)) *Service {
	return &Service{pool: pool, maxBodyBytes: maxBodyBytes, maxPageSize: maxPageSize, afterCommit: afterCommit}
}

func (s *Service) Create(ctx context.Context, user identity.User, chatID string, input CreateInput) (Message, bool, error) {
	if err := s.validateCreate(chatID, &input); err != nil {
		return Message{}, false, err
	}
	messageID, err := id.New()
	if err != nil {
		return Message{}, false, fmt.Errorf("generate message id: %w", err)
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Message{}, false, fmt.Errorf("begin create message: %w", err)
	}
	defer tx.Rollback(ctx)

	if err := lockOrganization(ctx, tx, user.OrgID); err != nil {
		return Message{}, false, err
	}
	kind, role, err := requireMembership(ctx, tx, user, chatID)
	if err != nil {
		return Message{}, false, err
	}
	action := authz.MessagePublish
	if input.ThreadRootID != nil {
		action = authz.ThreadReply
	}
	if !can(user, kind, role, action) {
		return Message{}, false, ErrForbidden
	}

	fingerprint := commandFingerprint(chatID, input)
	existing, existingFingerprint, err := findByClientID(ctx, tx, user.ActorID, input.ClientMsgID)
	if err == nil {
		if existingFingerprint == fingerprint {
			return existing, false, nil
		}
		return Message{}, false, ErrIdempotencyConflict
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return Message{}, false, fmt.Errorf("find idempotent message: %w", err)
	}
	if err := validateReferences(ctx, tx, user.OrgID, chatID, input.ReplyToID, input.ThreadRootID); err != nil {
		return Message{}, false, err
	}
	if err := validateMentions(ctx, tx, user.OrgID, chatID, input.MentionedActorIDs); err != nil {
		return Message{}, false, err
	}

	seq, err := nextSequence(ctx, tx, user.OrgID)
	if err != nil {
		return Message{}, false, err
	}
	var result Message
	err = scanMessage(tx.QueryRow(ctx, `
		INSERT INTO messages
			(id, org_id, chat_id, actor_id, client_msg_id, create_fingerprint, body, body_format, reply_to_id, thread_root_id, created_seq, mentioned_actor_ids)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
		RETURNING id, chat_id, actor_id, client_msg_id, type, body, body_format, reply_to_id,
			thread_root_id, version, created_seq, created_at, edited_at, deleted_at, forwarded_from, mentioned_actor_ids`,
		messageID, user.OrgID, chatID, user.ActorID, input.ClientMsgID, fingerprint[:], input.Body, input.BodyFormat,
		input.ReplyToID, input.ThreadRootID, seq, input.MentionedActorIDs), &result)
	if err != nil {
		return Message{}, false, fmt.Errorf("insert message: %w", err)
	}
	if err := insertEvent(ctx, tx, user, chatID, result.ID, seq, "message.created"); err != nil {
		return Message{}, false, err
	}
	highWatermark := seq
	if input.ThreadRootID != nil {
		highWatermark, err = autoFollowThread(ctx, tx, user, *input.ThreadRootID, input.MentionedActorIDs, highWatermark)
		if err != nil {
			return Message{}, false, err
		}
	}
	if _, err := tx.Exec(ctx, `UPDATE chats SET last_message_at = $3 WHERE org_id = $1 AND id = $2`, user.OrgID, chatID, result.CreatedAt); err != nil {
		return Message{}, false, fmt.Errorf("update chat activity: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return Message{}, false, fmt.Errorf("commit create message: %w", err)
	}
	s.notifyAfterCommit(user.OrgID, highWatermark)
	return result, true, nil
}

func (s *Service) List(ctx context.Context, user identity.User, chatID string, options ListOptions) (Page, error) {
	if _, err := uuid.Parse(chatID); err != nil {
		return Page{}, fmt.Errorf("%w: chat_id must be a UUID", ErrInvalid)
	}
	if options.BeforeSeq != nil && *options.BeforeSeq < 1 {
		return Page{}, fmt.Errorf("%w: before_seq must be positive", ErrInvalid)
	}
	if options.ThreadRootID != nil {
		if _, err := uuid.Parse(*options.ThreadRootID); err != nil {
			return Page{}, fmt.Errorf("%w: thread_root_id must be a UUID", ErrInvalid)
		}
	}
	limit := options.Limit
	if limit == 0 {
		limit = 50
	}
	if limit < 1 || limit > s.maxPageSize {
		return Page{}, fmt.Errorf("%w: limit must be between 1 and %d", ErrInvalid, s.maxPageSize)
	}

	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Page{}, fmt.Errorf("begin list messages: %w", err)
	}
	defer tx.Rollback(ctx)
	if _, _, err := requireMembership(ctx, tx, user, chatID); err != nil {
		return Page{}, err
	}
	rows, err := tx.Query(ctx, `
		SELECT id, chat_id, actor_id, client_msg_id, type, body, body_format, reply_to_id,
			thread_root_id, version, created_seq, created_at, edited_at, deleted_at, forwarded_from, mentioned_actor_ids
		FROM messages
		WHERE org_id = $1 AND chat_id = $2
		  AND ($3::bigint IS NULL OR created_seq < $3)
		  AND (($4::uuid IS NULL AND thread_root_id IS NULL) OR thread_root_id = $4)
		ORDER BY created_seq DESC
		LIMIT $5`, user.OrgID, chatID, options.BeforeSeq, options.ThreadRootID, limit+1)
	if err != nil {
		return Page{}, fmt.Errorf("list messages: %w", err)
	}
	defer rows.Close()
	messages := make([]Message, 0, limit)
	for rows.Next() {
		var item Message
		if err := scanMessage(rows, &item); err != nil {
			return Page{}, fmt.Errorf("scan message: %w", err)
		}
		messages = append(messages, item)
	}
	if err := rows.Err(); err != nil {
		return Page{}, fmt.Errorf("iterate messages: %w", err)
	}
	var next *int64
	if len(messages) > limit {
		messages = messages[:limit]
		cursor := messages[len(messages)-1].CreatedSeq
		next = &cursor
	}
	if err := hydrateThreadReplyCounts(ctx, tx, user.OrgID, messages); err != nil {
		return Page{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Page{}, fmt.Errorf("commit list messages: %w", err)
	}
	return Page{Messages: messages, NextBeforeSeq: next}, nil
}

func (s *Service) Context(ctx context.Context, user identity.User, messageID string, limit int) (Window, error) {
	if _, err := uuid.Parse(messageID); err != nil {
		return Window{}, fmt.Errorf("%w: message_id must be a UUID", ErrInvalid)
	}
	if limit == 0 {
		limit = 51
	}
	if limit < 3 || limit > s.maxPageSize {
		return Window{}, fmt.Errorf("%w: limit must be between 3 and %d", ErrInvalid, s.maxPageSize)
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Window{}, err
	}
	defer tx.Rollback(ctx)
	var chatID string
	var targetSeq int64
	var threadRootID *string
	err = tx.QueryRow(ctx, `SELECT chat_id,created_seq,thread_root_id FROM messages WHERE org_id=$1 AND id=$2`, user.OrgID, messageID).Scan(&chatID, &targetSeq, &threadRootID)
	if errors.Is(err, pgx.ErrNoRows) {
		return Window{}, ErrNotFound
	}
	if err != nil {
		return Window{}, fmt.Errorf("find target message: %w", err)
	}
	if _, _, err = requireMembership(ctx, tx, user, chatID); err != nil {
		return Window{}, err
	}
	rows, err := tx.Query(ctx, `SELECT id,chat_id,actor_id,client_msg_id,type,body,body_format,reply_to_id,thread_root_id,version,created_seq,created_at,edited_at,deleted_at,forwarded_from,mentioned_actor_ids FROM messages WHERE org_id=$1 AND chat_id=$2 AND ((thread_root_id IS NULL AND $3::uuid IS NULL) OR thread_root_id=$3 OR id=$4) ORDER BY abs(created_seq-$5) LIMIT $6`, user.OrgID, chatID, threadRootID, messageID, targetSeq, limit)
	if err != nil {
		return Window{}, fmt.Errorf("load message context: %w", err)
	}
	defer rows.Close()
	result := Window{Messages: make([]Message, 0, limit), TargetID: messageID}
	for rows.Next() {
		var item Message
		if err := scanMessage(rows, &item); err != nil {
			return Window{}, err
		}
		result.Messages = append(result.Messages, item)
	}
	if err := rows.Err(); err != nil {
		return Window{}, err
	}
	sort.Slice(result.Messages, func(i, j int) bool { return result.Messages[i].CreatedSeq < result.Messages[j].CreatedSeq })
	if err := hydrateThreadReplyCounts(ctx, tx, user.OrgID, result.Messages); err != nil {
		return Window{}, err
	}
	if len(result.Messages) > 0 {
		firstSeq := result.Messages[0].CreatedSeq
		lastSeq := result.Messages[len(result.Messages)-1].CreatedSeq
		if err := tx.QueryRow(ctx, `SELECT
			EXISTS(SELECT 1 FROM messages WHERE org_id=$1 AND chat_id=$2 AND created_seq<$5 AND ((thread_root_id IS NULL AND $3::uuid IS NULL) OR thread_root_id=$3 OR id=$4)),
			EXISTS(SELECT 1 FROM messages WHERE org_id=$1 AND chat_id=$2 AND created_seq>$6 AND ((thread_root_id IS NULL AND $3::uuid IS NULL) OR thread_root_id=$3 OR id=$4))`,
			user.OrgID, chatID, threadRootID, messageID, firstSeq, lastSeq).Scan(&result.HasEarlier, &result.HasLater); err != nil {
			return Window{}, fmt.Errorf("read message context bounds: %w", err)
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return Window{}, err
	}
	return result, nil
}

func (s *Service) Update(ctx context.Context, user identity.User, messageID string, input UpdateInput) (Message, error) {
	if _, err := uuid.Parse(messageID); err != nil {
		return Message{}, fmt.Errorf("%w: message_id must be a UUID", ErrInvalid)
	}
	if err := s.validateBody(&input.Body, &input.BodyFormat); err != nil {
		return Message{}, err
	}
	if input.ExpectedVersion < 1 {
		return Message{}, fmt.Errorf("%w: expected_version must be positive", ErrInvalid)
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Message{}, fmt.Errorf("begin update message: %w", err)
	}
	defer tx.Rollback(ctx)
	if err := lockOrganization(ctx, tx, user.OrgID); err != nil {
		return Message{}, err
	}
	current, kind, role, err := lockMessage(ctx, tx, user, messageID)
	if err != nil {
		return Message{}, err
	}
	if !can(user, kind, role, authz.MessagePublish) || current.ActorID != user.ActorID {
		return Message{}, ErrForbidden
	}
	if current.DeletedAt != nil {
		return Message{}, ErrNotFound
	}
	if current.Version != input.ExpectedVersion {
		return Message{}, ErrVersionConflict
	}
	mentions := current.MentionedActorIDs
	if input.MentionedActorIDs != nil {
		normalized, err := normalizeActorIDs(*input.MentionedActorIDs)
		if err != nil {
			return Message{}, err
		}
		if err := validateMentions(ctx, tx, user.OrgID, current.ChatID, normalized); err != nil {
			return Message{}, err
		}
		mentions = normalized
	}
	revisionID, err := id.New()
	if err != nil {
		return Message{}, fmt.Errorf("generate revision id: %w", err)
	}
	seq, err := nextSequence(ctx, tx, user.OrgID)
	if err != nil {
		return Message{}, err
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO message_revisions (id, org_id, message_id, version, body, body_format, edited_by, mentioned_actor_ids)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`, revisionID, user.OrgID, messageID, current.Version,
		current.Body, current.BodyFormat, user.ActorID, current.MentionedActorIDs); err != nil {
		return Message{}, fmt.Errorf("insert message revision: %w", err)
	}
	var result Message
	err = scanMessage(tx.QueryRow(ctx, `
		UPDATE messages SET body = $4, body_format = $5, mentioned_actor_ids = $6, version = version + 1, edited_at = now()
		WHERE org_id = $1 AND id = $2 AND version = $3
		RETURNING id, chat_id, actor_id, client_msg_id, type, body, body_format, reply_to_id,
			thread_root_id, version, created_seq, created_at, edited_at, deleted_at, forwarded_from, mentioned_actor_ids`,
		user.OrgID, messageID, input.ExpectedVersion, input.Body, input.BodyFormat, mentions), &result)
	if errors.Is(err, pgx.ErrNoRows) {
		return Message{}, ErrVersionConflict
	}
	if err != nil {
		return Message{}, fmt.Errorf("update message: %w", err)
	}
	if err := insertEvent(ctx, tx, user, result.ChatID, result.ID, seq, "message.updated"); err != nil {
		return Message{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Message{}, fmt.Errorf("commit update message: %w", err)
	}
	s.notifyAfterCommit(user.OrgID, seq)
	return result, nil
}

func (s *Service) Delete(ctx context.Context, user identity.User, messageID string) (Message, error) {
	if _, err := uuid.Parse(messageID); err != nil {
		return Message{}, fmt.Errorf("%w: message_id must be a UUID", ErrInvalid)
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Message{}, fmt.Errorf("begin delete message: %w", err)
	}
	defer tx.Rollback(ctx)
	if err := lockOrganization(ctx, tx, user.OrgID); err != nil {
		return Message{}, err
	}
	current, kind, role, member, err := lockMessageForDelete(ctx, tx, user, messageID)
	if err != nil {
		return Message{}, err
	}
	globalModerator := permission.Allows(user.OrgRole, user.Permissions, permission.ChatsModerate)
	if !member && !globalModerator {
		return Message{}, ErrNotFound
	}
	canDelete := member && current.ActorID == user.ActorID && can(user, kind, role, authz.MessagePublish)
	canModerate := member && can(user, kind, role, authz.ChatManage)
	if !canDelete && !canModerate && !globalModerator {
		return Message{}, ErrForbidden
	}
	if current.DeletedAt != nil {
		return current, nil
	}
	seq, err := nextSequence(ctx, tx, user.OrgID)
	if err != nil {
		return Message{}, err
	}
	var result Message
	err = scanMessage(tx.QueryRow(ctx, `
		UPDATE messages SET body = '', version = version + 1, deleted_at = now()
		WHERE org_id = $1 AND id = $2
		RETURNING id, chat_id, actor_id, client_msg_id, type, body, body_format, reply_to_id,
			thread_root_id, version, created_seq, created_at, edited_at, deleted_at, forwarded_from, mentioned_actor_ids`, user.OrgID, messageID), &result)
	if err != nil {
		return Message{}, fmt.Errorf("delete message: %w", err)
	}
	if err := insertEvent(ctx, tx, user, result.ChatID, result.ID, seq, "message.deleted"); err != nil {
		return Message{}, err
	}
	if current.ActorID != user.ActorID {
		auditID, err := id.New()
		if err != nil {
			return Message{}, fmt.Errorf("generate message moderation audit id: %w", err)
		}
		if _, err := tx.Exec(ctx, `
			INSERT INTO audit_log(id,org_id,actor_id,action,target_type,target_id,metadata)
			VALUES($1,$2,$3,'message.moderate.delete','message',$4,
			       jsonb_build_object('chat_id',$5::uuid,'author_id',$6::uuid))`,
			auditID, user.OrgID, user.ActorID, result.ID, result.ChatID, current.ActorID); err != nil {
			return Message{}, fmt.Errorf("audit moderated message deletion: %w", err)
		}
	}
	if _, err := tx.Exec(ctx, `
		UPDATE chats
		SET last_message_at = (
			SELECT max(created_at) FROM messages
			WHERE org_id = $1 AND chat_id = $2 AND deleted_at IS NULL
		)
		WHERE org_id = $1 AND id = $2`, user.OrgID, result.ChatID); err != nil {
		return Message{}, fmt.Errorf("update chat activity after message deletion: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return Message{}, fmt.Errorf("commit delete message: %w", err)
	}
	s.notifyAfterCommit(user.OrgID, seq)
	return result, nil
}

func (s *Service) notifyAfterCommit(orgID string, highWatermark int64) {
	if s.afterCommit != nil {
		s.afterCommit(orgID, highWatermark)
	}
}

func (s *Service) validateCreate(chatID string, input *CreateInput) error {
	if _, err := uuid.Parse(chatID); err != nil {
		return fmt.Errorf("%w: chat_id must be a UUID", ErrInvalid)
	}
	if _, err := uuid.Parse(input.ClientMsgID); err != nil {
		return fmt.Errorf("%w: client_msg_id must be a UUID", ErrInvalid)
	}
	for name, value := range map[string]*string{"reply_to_id": input.ReplyToID, "thread_root_id": input.ThreadRootID} {
		if value != nil {
			if _, err := uuid.Parse(*value); err != nil {
				return fmt.Errorf("%w: %s must be a UUID", ErrInvalid, name)
			}
		}
	}
	normalized, err := normalizeActorIDs(input.MentionedActorIDs)
	if err != nil {
		return err
	}
	input.MentionedActorIDs = normalized
	return s.validateBody(&input.Body, &input.BodyFormat)
}

func normalizeActorIDs(actorIDs []string) ([]string, error) {
	seen := make(map[string]struct{}, len(actorIDs))
	normalized := make([]string, 0, len(actorIDs))
	for _, actorID := range actorIDs {
		if _, err := uuid.Parse(actorID); err != nil {
			return nil, fmt.Errorf("%w: mentioned_actor_ids must contain UUIDs", ErrInvalid)
		}
		if _, exists := seen[actorID]; !exists {
			seen[actorID] = struct{}{}
			normalized = append(normalized, actorID)
		}
	}
	sort.Strings(normalized)
	return normalized, nil
}

func (s *Service) validateBody(body, format *string) error {
	if strings.TrimSpace(*body) == "" {
		return fmt.Errorf("%w: body must not be blank", ErrInvalid)
	}
	if len([]byte(*body)) > s.maxBodyBytes {
		return ErrTooLarge
	}
	*format = strings.ToLower(strings.TrimSpace(*format))
	if *format == "" {
		*format = "plain"
	}
	if *format != "plain" && *format != "markdown" {
		return fmt.Errorf("%w: body_format must be plain or markdown", ErrInvalid)
	}
	return nil
}

func lockOrganization(ctx context.Context, tx pgx.Tx, orgID string) error {
	var seq int64
	if err := tx.QueryRow(ctx, `SELECT event_seq FROM organizations WHERE id = $1 FOR UPDATE`, orgID).Scan(&seq); errors.Is(err, pgx.ErrNoRows) {
		return ErrForbidden
	} else if err != nil {
		return fmt.Errorf("lock organization: %w", err)
	}
	return nil
}

func requireMembership(ctx context.Context, tx pgx.Tx, user identity.User, chatID string) (string, string, error) {
	var kind, role string
	err := tx.QueryRow(ctx, `
		SELECT c.kind, cm.role
		FROM chats c
		JOIN chat_members cm ON cm.org_id = c.org_id AND cm.chat_id = c.id AND cm.actor_id = $3
		JOIN actors a ON a.org_id = c.org_id AND a.id = cm.actor_id
		WHERE c.org_id = $1 AND c.id = $2 AND c.archived_at IS NULL
		  AND a.status = 'active' AND a.deleted_at IS NULL
		FOR SHARE OF c, cm, a`, user.OrgID, chatID, user.ActorID).Scan(&kind, &role)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", "", ErrNotFound
	}
	if err != nil {
		return "", "", fmt.Errorf("authorize chat membership: %w", err)
	}
	return kind, role, nil
}

func lockMessage(ctx context.Context, tx pgx.Tx, user identity.User, messageID string) (Message, string, string, error) {
	var result Message
	var kind, role string
	err := tx.QueryRow(ctx, `
		SELECT m.id, m.chat_id, m.actor_id, m.client_msg_id, m.type, m.body, m.body_format, m.reply_to_id,
			m.thread_root_id, m.version, m.created_seq, m.created_at, m.edited_at, m.deleted_at, m.forwarded_from, m.mentioned_actor_ids, c.kind, cm.role
		FROM messages m
		JOIN chats c ON c.org_id = m.org_id AND c.id = m.chat_id AND c.archived_at IS NULL
		JOIN chat_members cm ON cm.org_id = c.org_id AND cm.chat_id = c.id AND cm.actor_id = $3
		JOIN actors a ON a.org_id = c.org_id AND a.id = cm.actor_id
		WHERE m.org_id = $1 AND m.id = $2 AND a.status = 'active' AND a.deleted_at IS NULL
		FOR UPDATE OF m FOR SHARE OF c, cm, a`, user.OrgID, messageID, user.ActorID).Scan(
		&result.ID, &result.ChatID, &result.ActorID, &result.ClientMsgID, &result.Type, &result.Body,
		&result.BodyFormat, &result.ReplyToID, &result.ThreadRootID, &result.Version, &result.CreatedSeq,
		&result.CreatedAt, &result.EditedAt, &result.DeletedAt, newJSONScanner(&result.ForwardedFrom), &result.MentionedActorIDs, &kind, &role)
	if errors.Is(err, pgx.ErrNoRows) {
		return Message{}, "", "", ErrNotFound
	}
	if err != nil {
		return Message{}, "", "", fmt.Errorf("lock message: %w", err)
	}
	return result, kind, role, nil
}

func lockMessageForDelete(ctx context.Context, tx pgx.Tx, user identity.User, messageID string) (Message, string, string, bool, error) {
	var result Message
	var kind, role string
	var member bool
	err := tx.QueryRow(ctx, `
		SELECT m.id, m.chat_id, m.actor_id, m.client_msg_id, m.type, m.body, m.body_format, m.reply_to_id,
			m.thread_root_id, m.version, m.created_seq, m.created_at, m.edited_at, m.deleted_at, m.forwarded_from,
			m.mentioned_actor_ids, c.kind, COALESCE(cm.role, ''), cm.actor_id IS NOT NULL
		FROM messages m
		JOIN chats c ON c.org_id = m.org_id AND c.id = m.chat_id AND c.archived_at IS NULL
		LEFT JOIN chat_members cm
		  ON cm.org_id = c.org_id AND cm.chat_id = c.id AND cm.actor_id = $3
		WHERE m.org_id = $1 AND m.id = $2
		FOR UPDATE OF m FOR SHARE OF c`, user.OrgID, messageID, user.ActorID).Scan(
		&result.ID, &result.ChatID, &result.ActorID, &result.ClientMsgID, &result.Type, &result.Body,
		&result.BodyFormat, &result.ReplyToID, &result.ThreadRootID, &result.Version, &result.CreatedSeq,
		&result.CreatedAt, &result.EditedAt, &result.DeletedAt, newJSONScanner(&result.ForwardedFrom),
		&result.MentionedActorIDs, &kind, &role, &member)
	if errors.Is(err, pgx.ErrNoRows) {
		return Message{}, "", "", false, ErrNotFound
	}
	if err != nil {
		return Message{}, "", "", false, fmt.Errorf("lock message for deletion: %w", err)
	}
	return result, kind, role, member, nil
}

func findByClientID(ctx context.Context, tx pgx.Tx, actorID, clientMsgID string) (Message, [32]byte, error) {
	var result Message
	var fingerprint [32]byte
	var fingerprintBytes []byte
	err := tx.QueryRow(ctx, `
		SELECT id, chat_id, actor_id, client_msg_id, type, body, body_format, reply_to_id,
			thread_root_id, version, created_seq, created_at, edited_at, deleted_at, forwarded_from, mentioned_actor_ids
			, create_fingerprint
		FROM messages WHERE actor_id = $1 AND client_msg_id = $2`, actorID, clientMsgID).Scan(
		&result.ID, &result.ChatID, &result.ActorID, &result.ClientMsgID, &result.Type, &result.Body,
		&result.BodyFormat, &result.ReplyToID, &result.ThreadRootID, &result.Version, &result.CreatedSeq,
		&result.CreatedAt, &result.EditedAt, &result.DeletedAt, newJSONScanner(&result.ForwardedFrom), &result.MentionedActorIDs, &fingerprintBytes)
	copy(fingerprint[:], fingerprintBytes)
	return result, fingerprint, err
}

func validateReferences(ctx context.Context, tx pgx.Tx, orgID, chatID string, replyToID, threadRootID *string) error {
	if threadRootID != nil {
		var deletedAt *time.Time
		err := tx.QueryRow(ctx, `
			SELECT deleted_at FROM messages
			WHERE org_id = $1 AND chat_id = $2 AND id = $3 AND thread_root_id IS NULL`,
			orgID, chatID, *threadRootID).Scan(&deletedAt)
		if errors.Is(err, pgx.ErrNoRows) || deletedAt != nil {
			return fmt.Errorf("%w: thread root does not exist", ErrInvalid)
		}
		if err != nil {
			return fmt.Errorf("validate thread root: %w", err)
		}
	}
	if replyToID == nil {
		return nil
	}
	var actualRoot *string
	var deletedAt *time.Time
	err := tx.QueryRow(ctx, `SELECT thread_root_id, deleted_at FROM messages WHERE org_id = $1 AND chat_id = $2 AND id = $3`,
		orgID, chatID, *replyToID).Scan(&actualRoot, &deletedAt)
	if errors.Is(err, pgx.ErrNoRows) || deletedAt != nil {
		return fmt.Errorf("%w: reply target does not exist", ErrInvalid)
	}
	if err != nil {
		return fmt.Errorf("validate reply target: %w", err)
	}
	if threadRootID == nil && actualRoot != nil {
		return fmt.Errorf("%w: reply target belongs to a thread", ErrInvalid)
	}
	if threadRootID != nil && *replyToID != *threadRootID && (actualRoot == nil || *actualRoot != *threadRootID) {
		return fmt.Errorf("%w: reply target belongs to another thread", ErrInvalid)
	}
	return nil
}

func nextSequence(ctx context.Context, tx pgx.Tx, orgID string) (int64, error) {
	var seq int64
	if err := tx.QueryRow(ctx, `UPDATE organizations SET event_seq = event_seq + 1 WHERE id = $1 RETURNING event_seq`, orgID).Scan(&seq); err != nil {
		return 0, fmt.Errorf("allocate event sequence: %w", err)
	}
	return seq, nil
}

func insertEvent(ctx context.Context, tx pgx.Tx, user identity.User, chatID, subjectID string, seq int64, eventType string) error {
	return insertEventData(ctx, tx, user, chatID, subjectID, seq, eventType, nil, nil)
}

func insertEventData(ctx context.Context, tx pgx.Tx, user identity.User, chatID, subjectID string, seq int64, eventType string, audienceActorID *string, data any) error {
	if data == nil {
		data = map[string]any{}
	}
	payload, err := json.Marshal(data)
	if err != nil {
		return fmt.Errorf("marshal durable event data: %w", err)
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO events (org_id, seq, type, actor_id, chat_id, subject_id, audience_actor_id, data)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)`, user.OrgID, seq, eventType, user.ActorID, chatID, subjectID, audienceActorID, string(payload)); err != nil {
		return fmt.Errorf("insert durable event: %w", err)
	}
	if eventType == "message.created" {
		if _, err := tx.Exec(ctx, `INSERT INTO notification_jobs (org_id, event_seq) VALUES ($1, $2) ON CONFLICT DO NOTHING`, user.OrgID, seq); err != nil {
			return fmt.Errorf("enqueue notification job: %w", err)
		}
	}
	return nil
}

func can(user identity.User, kind, role string, action authz.Action) bool {
	return authz.Can(authz.Context{
		Active: true, OrgRole: authz.Role(user.OrgRole), ChatKind: authz.ChatKind(kind),
		ChatMember: true, ChatRole: authz.Role(role),
	}, action)
}

func commandFingerprint(chatID string, input CreateInput) [32]byte {
	replyTo := "-"
	if input.ReplyToID != nil {
		replyTo = "+" + *input.ReplyToID
	}
	threadRoot := "-"
	if input.ThreadRootID != nil {
		threadRoot = "+" + *input.ThreadRootID
	}
	return sha256.Sum256([]byte(chatID + "\x00" + input.Body + "\x00" + input.BodyFormat + "\x00" + replyTo + "\x00" + threadRoot + "\x00" + strings.Join(input.MentionedActorIDs, ",")))
}

type rowScanner interface {
	Scan(dest ...any) error
}

func scanMessage(row rowScanner, result *Message) error {
	return row.Scan(&result.ID, &result.ChatID, &result.ActorID, &result.ClientMsgID, &result.Type,
		&result.Body, &result.BodyFormat, &result.ReplyToID, &result.ThreadRootID, &result.Version,
		&result.CreatedSeq, &result.CreatedAt, &result.EditedAt, &result.DeletedAt, newJSONScanner(&result.ForwardedFrom), &result.MentionedActorIDs)
}

func hydrateThreadReplyCounts(ctx context.Context, tx pgx.Tx, orgID string, messages []Message) error {
	rootIDs := make([]string, 0, len(messages))
	for i := range messages {
		if messages[i].ThreadRootID == nil && messages[i].DeletedAt == nil {
			rootIDs = append(rootIDs, messages[i].ID)
		}
	}
	if len(rootIDs) == 0 {
		return nil
	}
	rows, err := tx.Query(ctx, `
		SELECT thread_root_id, count(*)
		FROM messages
		WHERE org_id = $1 AND thread_root_id = ANY($2::uuid[]) AND deleted_at IS NULL
		GROUP BY thread_root_id`, orgID, rootIDs)
	if err != nil {
		return fmt.Errorf("load thread reply counts: %w", err)
	}
	defer rows.Close()
	counts := make(map[string]int64, len(rootIDs))
	for rows.Next() {
		var rootID string
		var count int64
		if err := rows.Scan(&rootID, &count); err != nil {
			return fmt.Errorf("scan thread reply count: %w", err)
		}
		counts[rootID] = count
	}
	if err := rows.Err(); err != nil {
		return fmt.Errorf("iterate thread reply counts: %w", err)
	}
	for i := range messages {
		messages[i].ThreadReplyCount = counts[messages[i].ID]
	}
	return nil
}

func validateMentions(ctx context.Context, tx pgx.Tx, orgID, chatID string, actorIDs []string) error {
	if len(actorIDs) == 0 {
		return nil
	}
	var count int
	if err := tx.QueryRow(ctx, `
		SELECT count(*) FROM chat_members cm
		JOIN actors a ON a.org_id = cm.org_id AND a.id = cm.actor_id
		WHERE cm.org_id = $1 AND cm.chat_id = $2 AND cm.actor_id = ANY($3::uuid[])
		  AND a.status = 'active' AND a.deleted_at IS NULL`, orgID, chatID, actorIDs).Scan(&count); err != nil {
		return fmt.Errorf("validate message mentions: %w", err)
	}
	if count != len(actorIDs) {
		return fmt.Errorf("%w: mentioned actors must be active chat members", ErrInvalid)
	}
	return nil
}

type jsonScanner[T any] struct{ target **T }

func newJSONScanner[T any](target **T) *jsonScanner[T] { return &jsonScanner[T]{target: target} }

func (s *jsonScanner[T]) Scan(src any) error {
	if src == nil {
		*s.target = nil
		return nil
	}
	var raw []byte
	switch value := src.(type) {
	case []byte:
		raw = value
	case string:
		raw = []byte(value)
	default:
		return fmt.Errorf("scan json: unsupported source %T", src)
	}
	var result T
	if err := json.Unmarshal(raw, &result); err != nil {
		return err
	}
	*s.target = &result
	return nil
}
