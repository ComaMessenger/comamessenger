package message

import (
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/comamessenger/comamessenger/core/internal/authz"
	"github.com/comamessenger/comamessenger/core/internal/id"
	"github.com/comamessenger/comamessenger/core/internal/identity"
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
)

type Message struct {
	ID           string     `json:"id"`
	ChatID       string     `json:"chat_id"`
	ActorID      string     `json:"actor_id"`
	ClientMsgID  string     `json:"client_msg_id"`
	Type         string     `json:"type"`
	Body         string     `json:"body"`
	BodyFormat   string     `json:"body_format"`
	ReplyToID    *string    `json:"reply_to_id"`
	ThreadRootID *string    `json:"thread_root_id"`
	Version      int        `json:"version"`
	CreatedSeq   int64      `json:"created_seq"`
	CreatedAt    time.Time  `json:"created_at"`
	EditedAt     *time.Time `json:"edited_at"`
	DeletedAt    *time.Time `json:"deleted_at"`
}

type CreateInput struct {
	ClientMsgID  string  `json:"client_msg_id"`
	Body         string  `json:"body"`
	BodyFormat   string  `json:"body_format"`
	ReplyToID    *string `json:"reply_to_id"`
	ThreadRootID *string `json:"thread_root_id"`
}

type UpdateInput struct {
	Body            string `json:"body"`
	BodyFormat      string `json:"body_format"`
	ExpectedVersion int    `json:"expected_version"`
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

type Service struct {
	pool         *pgxpool.Pool
	maxBodyBytes int
	maxPageSize  int
	afterCommit  func()
}

func NewService(pool *pgxpool.Pool, maxBodyBytes, maxPageSize int, afterCommit func()) *Service {
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

	seq, err := nextSequence(ctx, tx, user.OrgID)
	if err != nil {
		return Message{}, false, err
	}
	var result Message
	err = scanMessage(tx.QueryRow(ctx, `
		INSERT INTO messages
			(id, org_id, chat_id, actor_id, client_msg_id, create_fingerprint, body, body_format, reply_to_id, thread_root_id, created_seq)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
		RETURNING id, chat_id, actor_id, client_msg_id, type, body, body_format, reply_to_id,
			thread_root_id, version, created_seq, created_at, edited_at, deleted_at`,
		messageID, user.OrgID, chatID, user.ActorID, input.ClientMsgID, fingerprint[:], input.Body, input.BodyFormat,
		input.ReplyToID, input.ThreadRootID, seq), &result)
	if err != nil {
		return Message{}, false, fmt.Errorf("insert message: %w", err)
	}
	if err := insertEvent(ctx, tx, user, chatID, result.ID, seq, "message.created"); err != nil {
		return Message{}, false, err
	}
	if _, err := tx.Exec(ctx, `UPDATE chats SET last_message_at = $3 WHERE org_id = $1 AND id = $2`, user.OrgID, chatID, result.CreatedAt); err != nil {
		return Message{}, false, fmt.Errorf("update chat activity: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return Message{}, false, fmt.Errorf("commit create message: %w", err)
	}
	s.notifyAfterCommit()
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
			thread_root_id, version, created_seq, created_at, edited_at, deleted_at
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
	if err := tx.Commit(ctx); err != nil {
		return Page{}, fmt.Errorf("commit list messages: %w", err)
	}
	return Page{Messages: messages, NextBeforeSeq: next}, nil
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
	revisionID, err := id.New()
	if err != nil {
		return Message{}, fmt.Errorf("generate revision id: %w", err)
	}
	seq, err := nextSequence(ctx, tx, user.OrgID)
	if err != nil {
		return Message{}, err
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO message_revisions (id, org_id, message_id, version, body, body_format, edited_by)
		VALUES ($1, $2, $3, $4, $5, $6, $7)`, revisionID, user.OrgID, messageID, current.Version,
		current.Body, current.BodyFormat, user.ActorID); err != nil {
		return Message{}, fmt.Errorf("insert message revision: %w", err)
	}
	var result Message
	err = scanMessage(tx.QueryRow(ctx, `
		UPDATE messages SET body = $4, body_format = $5, version = version + 1, edited_at = now()
		WHERE org_id = $1 AND id = $2 AND version = $3
		RETURNING id, chat_id, actor_id, client_msg_id, type, body, body_format, reply_to_id,
			thread_root_id, version, created_seq, created_at, edited_at, deleted_at`,
		user.OrgID, messageID, input.ExpectedVersion, input.Body, input.BodyFormat), &result)
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
	s.notifyAfterCommit()
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
	current, kind, role, err := lockMessage(ctx, tx, user, messageID)
	if err != nil {
		return Message{}, err
	}
	canDelete := current.ActorID == user.ActorID && can(user, kind, role, authz.MessagePublish)
	canModerate := can(user, kind, role, authz.ChatManage)
	if !canDelete && !canModerate {
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
			thread_root_id, version, created_seq, created_at, edited_at, deleted_at`, user.OrgID, messageID), &result)
	if err != nil {
		return Message{}, fmt.Errorf("delete message: %w", err)
	}
	if err := insertEvent(ctx, tx, user, result.ChatID, result.ID, seq, "message.deleted"); err != nil {
		return Message{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Message{}, fmt.Errorf("commit delete message: %w", err)
	}
	s.notifyAfterCommit()
	return result, nil
}

func (s *Service) notifyAfterCommit() {
	if s.afterCommit != nil {
		s.afterCommit()
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
	return s.validateBody(&input.Body, &input.BodyFormat)
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
			m.thread_root_id, m.version, m.created_seq, m.created_at, m.edited_at, m.deleted_at, c.kind, cm.role
		FROM messages m
		JOIN chats c ON c.org_id = m.org_id AND c.id = m.chat_id AND c.archived_at IS NULL
		JOIN chat_members cm ON cm.org_id = c.org_id AND cm.chat_id = c.id AND cm.actor_id = $3
		JOIN actors a ON a.org_id = c.org_id AND a.id = cm.actor_id
		WHERE m.org_id = $1 AND m.id = $2 AND a.status = 'active' AND a.deleted_at IS NULL
		FOR UPDATE OF m FOR SHARE OF c, cm, a`, user.OrgID, messageID, user.ActorID).Scan(
		&result.ID, &result.ChatID, &result.ActorID, &result.ClientMsgID, &result.Type, &result.Body,
		&result.BodyFormat, &result.ReplyToID, &result.ThreadRootID, &result.Version, &result.CreatedSeq,
		&result.CreatedAt, &result.EditedAt, &result.DeletedAt, &kind, &role)
	if errors.Is(err, pgx.ErrNoRows) {
		return Message{}, "", "", ErrNotFound
	}
	if err != nil {
		return Message{}, "", "", fmt.Errorf("lock message: %w", err)
	}
	return result, kind, role, nil
}

func findByClientID(ctx context.Context, tx pgx.Tx, actorID, clientMsgID string) (Message, [32]byte, error) {
	var result Message
	var fingerprint [32]byte
	var fingerprintBytes []byte
	err := tx.QueryRow(ctx, `
		SELECT id, chat_id, actor_id, client_msg_id, type, body, body_format, reply_to_id,
			thread_root_id, version, created_seq, created_at, edited_at, deleted_at
			, create_fingerprint
		FROM messages WHERE actor_id = $1 AND client_msg_id = $2`, actorID, clientMsgID).Scan(
		&result.ID, &result.ChatID, &result.ActorID, &result.ClientMsgID, &result.Type, &result.Body,
		&result.BodyFormat, &result.ReplyToID, &result.ThreadRootID, &result.Version, &result.CreatedSeq,
		&result.CreatedAt, &result.EditedAt, &result.DeletedAt, &fingerprintBytes)
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
	if _, err := tx.Exec(ctx, `
		INSERT INTO events (org_id, seq, type, actor_id, chat_id, subject_id)
		VALUES ($1, $2, $3, $4, $5, $6)`, user.OrgID, seq, eventType, user.ActorID, chatID, subjectID); err != nil {
		return fmt.Errorf("insert durable event: %w", err)
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
	return sha256.Sum256([]byte(chatID + "\x00" + input.Body + "\x00" + input.BodyFormat + "\x00" + replyTo + "\x00" + threadRoot))
}

type rowScanner interface {
	Scan(dest ...any) error
}

func scanMessage(row rowScanner, result *Message) error {
	return row.Scan(&result.ID, &result.ChatID, &result.ActorID, &result.ClientMsgID, &result.Type,
		&result.Body, &result.BodyFormat, &result.ReplyToID, &result.ThreadRootID, &result.Version,
		&result.CreatedSeq, &result.CreatedAt, &result.EditedAt, &result.DeletedAt)
}
