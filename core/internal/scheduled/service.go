// Package scheduled keeps the messages people schedule for later and sends
// them through the ordinary send path on behalf of their author.
//
// Security model:
//   - A scheduled message is private to its author until it is sent. Every
//     read and write filters by org, author and id, so another person's id,
//     an administrator's included, is indistinguishable from a missing one.
//   - Rights are checked twice: when the message is created or changed, and
//     again inside the send transaction. A refusal at send time marks the
//     record failed with a reason and tells the author's devices.
//   - Only people signed in with a live session may schedule, change or send
//     now. Signing out one device or a session expiring does not touch the
//     messages already scheduled. Security events stop them explicitly: the
//     identity and workspace services fail the author's pending messages
//     through package scheduledreset in the same transaction as a password
//     change or reset, an e-mail change, signing out every device, or right
//     after a deactivation.
//   - Files stay linked only to the scheduled record, so nobody but the
//     uploader can read them until the message is actually sent.
package scheduled

import (
	"context"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"github.com/comamessenger/comamessenger/core/internal/files"
	"github.com/comamessenger/comamessenger/core/internal/id"
	"github.com/comamessenger/comamessenger/core/internal/identity"
	"github.com/comamessenger/comamessenger/core/internal/message"
	"github.com/comamessenger/comamessenger/core/internal/scheduledreset"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

var (
	ErrNotFound            = errors.New("scheduled message not found")
	ErrForbidden           = errors.New("scheduled message forbidden")
	ErrInvalid             = errors.New("invalid scheduled message")
	ErrTooLarge            = errors.New("scheduled message body too large")
	ErrClosed              = errors.New("scheduled message is no longer pending")
	ErrVersionConflict     = errors.New("scheduled message version conflict")
	ErrLimitReached        = errors.New("scheduled message limit reached")
	ErrIdempotencyConflict = errors.New("scheduled message idempotency conflict")
)

const (
	StatusPending = "pending"
	StatusSent    = "sent"
	StatusFailed  = "failed"

	ReasonAuthorInactive        = scheduledreset.ReasonAuthorInactive
	ReasonSecurityReset         = scheduledreset.ReasonSecurityReset
	ReasonChatUnavailable       = "chat_unavailable"
	ReasonNotMember             = "not_member"
	ReasonForbidden             = "forbidden"
	ReasonReferenceUnavailable  = "reference_unavailable"
	ReasonAttachmentUnavailable = "attachment_unavailable"
	ReasonInvalidContent        = "invalid_content"
	ReasonDeliveryError         = "delivery_error"

	// MaxHorizon is how far ahead a message may be scheduled.
	MaxHorizon = 365 * 24 * time.Hour
	// Sent records keep only their link to the message, failed ones keep
	// the text for the author to copy; both are removed after these delays.
	sentRetention   = 7 * 24 * time.Hour
	failedRetention = 30 * 24 * time.Hour
)

// Limits bound pending scheduled messages of one author.
type Limits struct {
	PerAuthor int
	PerChat   int
}

func DefaultLimits() Limits { return Limits{PerAuthor: 100, PerChat: 30} }

// Scheduler places and removes the delivery jobs, inside the caller's
// transaction so a rollback never leaves a stray job behind.
type Scheduler interface {
	ScheduleTx(ctx context.Context, tx pgx.Tx, scheduledMessageID string, at time.Time) (int64, error)
	CancelTx(ctx context.Context, tx pgx.Tx, jobID int64) error
}

type ScheduledMessage struct {
	ID                string       `json:"id"`
	ChatID            string       `json:"chat_id"`
	ThreadRootID      *string      `json:"thread_root_id"`
	ReplyToID         *string      `json:"reply_to_id"`
	ClientMsgID       string       `json:"client_msg_id"`
	Body              string       `json:"body"`
	BodyFormat        string       `json:"body_format"`
	MentionedActorIDs []string     `json:"mentioned_actor_ids"`
	Files             []files.File `json:"files"`
	Silent            bool         `json:"silent"`
	SendAt            time.Time    `json:"send_at"`
	Status            string       `json:"status"`
	FailureReason     *string      `json:"failure_reason"`
	MessageID         *string      `json:"message_id"`
	Version           int          `json:"version"`
	CreatedAt         time.Time    `json:"created_at"`
	UpdatedAt         time.Time    `json:"updated_at"`
	SentAt            *time.Time   `json:"sent_at"`
	FailedAt          *time.Time   `json:"failed_at"`

	orgID, authorID string
	riverJobID      *int64
	fileIDs         []string
}

type CreateInput struct {
	ClientMsgID       string    `json:"client_msg_id"`
	Body              string    `json:"body"`
	BodyFormat        string    `json:"body_format"`
	ReplyToID         *string   `json:"reply_to_id"`
	ThreadRootID      *string   `json:"thread_root_id"`
	MentionedActorIDs []string  `json:"mentioned_actor_ids"`
	FileIDs           []string  `json:"file_ids"`
	SendAt            time.Time `json:"send_at"`
	Silent            bool      `json:"silent"`
}

type UpdateInput struct {
	ExpectedVersion   int        `json:"expected_version"`
	Body              *string    `json:"body"`
	BodyFormat        *string    `json:"body_format"`
	MentionedActorIDs *[]string  `json:"mentioned_actor_ids"`
	SendAt            *time.Time `json:"send_at"`
	Silent            *bool      `json:"silent"`
}

// Author is the signed-in person acting on their scheduled messages.
// SessionID is empty for agent API keys, which may not schedule.
type Author struct {
	User      identity.User
	SessionID string
}

type Service struct {
	pool        *pgxpool.Pool
	messages    *message.Service
	scheduler   Scheduler
	limits      Limits
	afterCommit func(orgID string, highWatermark int64)
	now         func() time.Time
	logger      *slog.Logger
}

func NewService(pool *pgxpool.Pool, messages *message.Service, afterCommit func(string, int64), logger *slog.Logger) *Service {
	if logger == nil {
		logger = slog.Default()
	}
	return &Service{pool: pool, messages: messages, limits: DefaultLimits(), afterCommit: afterCommit, now: time.Now, logger: logger}
}

func (s *Service) SetScheduler(scheduler Scheduler) { s.scheduler = scheduler }
func (s *Service) SetLimits(limits Limits)          { s.limits = limits }

const selectColumns = `sm.id, sm.org_id, sm.author_id, sm.chat_id, sm.thread_root_id, sm.reply_to_id, sm.client_msg_id,
	sm.body, sm.body_format, sm.mentioned_actor_ids, sm.silent, sm.send_at, sm.status,
	sm.failure_reason, sm.message_id, sm.river_job_id, sm.version, sm.created_at, sm.updated_at, sm.sent_at, sm.failed_at`

func scan(row pgx.Row, item *ScheduledMessage) error {
	return row.Scan(&item.ID, &item.orgID, &item.authorID, &item.ChatID, &item.ThreadRootID, &item.ReplyToID, &item.ClientMsgID,
		&item.Body, &item.BodyFormat, &item.MentionedActorIDs, &item.Silent, &item.SendAt, &item.Status,
		&item.FailureReason, &item.MessageID, &item.riverJobID, &item.Version, &item.CreatedAt, &item.UpdatedAt, &item.SentAt, &item.FailedAt)
}

// Create schedules a message after checking everything the ordinary send
// would check right now.
func (s *Service) Create(ctx context.Context, author Author, chatID string, input CreateInput) (ScheduledMessage, bool, error) {
	if author.SessionID == "" {
		return ScheduledMessage{}, false, ErrForbidden
	}
	if err := validID(chatID); err != nil {
		return ScheduledMessage{}, false, err
	}
	draft := message.CreateInput{
		ClientMsgID: input.ClientMsgID, Body: input.Body, BodyFormat: input.BodyFormat,
		ReplyToID: input.ReplyToID, ThreadRootID: input.ThreadRootID,
		MentionedActorIDs: input.MentionedActorIDs, FileIDs: input.FileIDs, Silent: input.Silent,
	}
	if err := s.messages.ValidateCreate(chatID, &draft); err != nil {
		return ScheduledMessage{}, false, fromMessageError(err)
	}
	sendAt := input.SendAt.UTC()
	if err := s.validateSendAt(sendAt); err != nil {
		return ScheduledMessage{}, false, err
	}
	fingerprint := createFingerprint(chatID, draft, sendAt)
	scheduledID, err := id.New()
	if err != nil {
		return ScheduledMessage{}, false, err
	}

	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return ScheduledMessage{}, false, fmt.Errorf("begin create scheduled message: %w", err)
	}
	defer tx.Rollback(ctx)
	if err := lockOrganization(ctx, tx, author.User.OrgID); err != nil {
		return ScheduledMessage{}, false, err
	}
	user, err := activeAuthor(ctx, tx, author.User)
	if err != nil {
		return ScheduledMessage{}, false, err
	}
	if err := requireLiveSession(ctx, tx, user, author.SessionID); err != nil {
		return ScheduledMessage{}, false, err
	}

	var existing ScheduledMessage
	var existingFingerprint []byte
	err = tx.QueryRow(ctx, `SELECT `+selectColumns+`, sm.create_fingerprint FROM scheduled_messages sm
		WHERE sm.org_id=$1 AND sm.author_id=$2 AND sm.client_msg_id=$3`, user.OrgID, user.ActorID, draft.ClientMsgID).
		Scan(&existing.ID, &existing.orgID, &existing.authorID, &existing.ChatID, &existing.ThreadRootID, &existing.ReplyToID, &existing.ClientMsgID,
			&existing.Body, &existing.BodyFormat, &existing.MentionedActorIDs, &existing.Silent, &existing.SendAt, &existing.Status,
			&existing.FailureReason, &existing.MessageID, &existing.riverJobID, &existing.Version, &existing.CreatedAt, &existing.UpdatedAt, &existing.SentAt, &existing.FailedAt,
			&existingFingerprint)
	if err == nil {
		if string(existingFingerprint) != string(fingerprint[:]) {
			return ScheduledMessage{}, false, ErrIdempotencyConflict
		}
		items := []ScheduledMessage{existing}
		if err := hydrateFiles(ctx, tx, user.OrgID, items); err != nil {
			return ScheduledMessage{}, false, err
		}
		return items[0], false, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return ScheduledMessage{}, false, fmt.Errorf("find idempotent scheduled message: %w", err)
	}
	// The id becomes the message's client_msg_id; one already used by an
	// ordinary message would make the send collide with it.
	var used bool
	if err := tx.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM messages WHERE actor_id=$1 AND client_msg_id=$2)`, user.ActorID, draft.ClientMsgID).Scan(&used); err != nil {
		return ScheduledMessage{}, false, fmt.Errorf("check client message id: %w", err)
	}
	if used {
		return ScheduledMessage{}, false, ErrIdempotencyConflict
	}
	if err := s.messages.AuthorizeCreateTx(ctx, tx, user, chatID, draft); err != nil {
		return ScheduledMessage{}, false, fromMessageError(err)
	}
	if err := s.checkLimits(ctx, tx, user, chatID); err != nil {
		return ScheduledMessage{}, false, err
	}

	var result ScheduledMessage
	err = scan(tx.QueryRow(ctx, `
		INSERT INTO scheduled_messages AS sm (id, org_id, author_id, chat_id, thread_root_id, reply_to_id, client_msg_id, create_fingerprint,
			body, body_format, mentioned_actor_ids, silent, send_at)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
		RETURNING `+selectColumns, scheduledID, user.OrgID, user.ActorID, chatID, draft.ThreadRootID, draft.ReplyToID, draft.ClientMsgID,
		fingerprint[:], draft.Body, draft.BodyFormat, draft.MentionedActorIDs, draft.Silent, sendAt), &result)
	if err != nil {
		return ScheduledMessage{}, false, fmt.Errorf("insert scheduled message: %w", err)
	}
	if len(draft.FileIDs) > 0 {
		if _, err := tx.Exec(ctx, `
			INSERT INTO scheduled_message_files (scheduled_message_id, file_id, org_id, ordinal)
			SELECT $1, value, $2, ordinal - 1 FROM unnest($3::uuid[]) WITH ORDINALITY AS selected(value, ordinal)`,
			result.ID, user.OrgID, draft.FileIDs); err != nil {
			return ScheduledMessage{}, false, fmt.Errorf("attach scheduled message files: %w", err)
		}
	}
	if err := s.schedule(ctx, tx, &result); err != nil {
		return ScheduledMessage{}, false, err
	}
	items := []ScheduledMessage{result}
	if err := hydrateFiles(ctx, tx, user.OrgID, items); err != nil {
		return ScheduledMessage{}, false, err
	}
	result = items[0]
	seq, err := insertEvent(ctx, tx, user.OrgID, user.ActorID, result.ID, "scheduled_message.created", result)
	if err != nil {
		return ScheduledMessage{}, false, err
	}
	if err := tx.Commit(ctx); err != nil {
		return ScheduledMessage{}, false, fmt.Errorf("commit scheduled message: %w", err)
	}
	s.notify(user.OrgID, seq)
	return result, true, nil
}

// List returns the author's pending and failed scheduled messages.
func (s *Service) List(ctx context.Context, author Author, chatID *string) ([]ScheduledMessage, error) {
	if author.SessionID == "" {
		return nil, ErrForbidden
	}
	if chatID != nil {
		if err := validID(*chatID); err != nil {
			return nil, err
		}
	}
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{AccessMode: pgx.ReadOnly})
	if err != nil {
		return nil, fmt.Errorf("begin list scheduled messages: %w", err)
	}
	defer tx.Rollback(ctx)
	rows, err := tx.Query(ctx, `SELECT `+selectColumns+` FROM scheduled_messages sm
		WHERE sm.org_id=$1 AND sm.author_id=$2 AND sm.status<>'sent' AND ($3::uuid IS NULL OR sm.chat_id=$3)
		ORDER BY sm.send_at, sm.id LIMIT 1000`, author.User.OrgID, author.User.ActorID, chatID)
	if err != nil {
		return nil, fmt.Errorf("list scheduled messages: %w", err)
	}
	result := make([]ScheduledMessage, 0)
	for rows.Next() {
		var item ScheduledMessage
		if err := scan(rows, &item); err != nil {
			rows.Close()
			return nil, fmt.Errorf("scan scheduled message: %w", err)
		}
		result = append(result, item)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate scheduled messages: %w", err)
	}
	if err := hydrateFiles(ctx, tx, author.User.OrgID, result); err != nil {
		return nil, err
	}
	return result, nil
}

// Get returns one of the author's scheduled messages.
func (s *Service) Get(ctx context.Context, author Author, scheduledID string) (ScheduledMessage, error) {
	if author.SessionID == "" {
		return ScheduledMessage{}, ErrForbidden
	}
	if err := validID(scheduledID); err != nil {
		return ScheduledMessage{}, ErrNotFound
	}
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{AccessMode: pgx.ReadOnly})
	if err != nil {
		return ScheduledMessage{}, fmt.Errorf("begin get scheduled message: %w", err)
	}
	defer tx.Rollback(ctx)
	var item ScheduledMessage
	err = scan(tx.QueryRow(ctx, `SELECT `+selectColumns+` FROM scheduled_messages sm WHERE sm.org_id=$1 AND sm.author_id=$2 AND sm.id=$3`,
		author.User.OrgID, author.User.ActorID, scheduledID), &item)
	if errors.Is(err, pgx.ErrNoRows) {
		return ScheduledMessage{}, ErrNotFound
	}
	if err != nil {
		return ScheduledMessage{}, fmt.Errorf("get scheduled message: %w", err)
	}
	items := []ScheduledMessage{item}
	if err := hydrateFiles(ctx, tx, author.User.OrgID, items); err != nil {
		return ScheduledMessage{}, err
	}
	return items[0], nil
}

// Update changes the text, mentions, silence or send time of a pending
// message, rechecking the author's rights as of now.
func (s *Service) Update(ctx context.Context, author Author, scheduledID string, input UpdateInput) (ScheduledMessage, error) {
	if author.SessionID == "" {
		return ScheduledMessage{}, ErrForbidden
	}
	if err := validID(scheduledID); err != nil {
		return ScheduledMessage{}, ErrNotFound
	}
	if input.ExpectedVersion < 1 {
		return ScheduledMessage{}, fmt.Errorf("%w: expected_version must be positive", ErrInvalid)
	}
	if input.Body == nil && input.BodyFormat == nil && input.MentionedActorIDs == nil && input.SendAt == nil && input.Silent == nil {
		return ScheduledMessage{}, fmt.Errorf("%w: nothing to change", ErrInvalid)
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return ScheduledMessage{}, fmt.Errorf("begin update scheduled message: %w", err)
	}
	defer tx.Rollback(ctx)
	if err := lockOrganization(ctx, tx, author.User.OrgID); err != nil {
		return ScheduledMessage{}, err
	}
	current, err := lockOwn(ctx, tx, author.User, scheduledID)
	if err != nil {
		return ScheduledMessage{}, err
	}
	if current.Status != StatusPending {
		return ScheduledMessage{}, ErrClosed
	}
	if current.Version != input.ExpectedVersion {
		return ScheduledMessage{}, ErrVersionConflict
	}
	user, err := activeAuthor(ctx, tx, author.User)
	if err != nil {
		return ScheduledMessage{}, err
	}
	if err := requireLiveSession(ctx, tx, user, author.SessionID); err != nil {
		return ScheduledMessage{}, err
	}
	if err := loadFileIDs(ctx, tx, []*ScheduledMessage{&current}); err != nil {
		return ScheduledMessage{}, err
	}
	draft := current.messageInput()
	if input.Body != nil {
		draft.Body = *input.Body
	}
	if input.BodyFormat != nil {
		draft.BodyFormat = *input.BodyFormat
	}
	if input.MentionedActorIDs != nil {
		draft.MentionedActorIDs = *input.MentionedActorIDs
	}
	if input.Silent != nil {
		draft.Silent = *input.Silent
	}
	if err := s.messages.ValidateCreate(current.ChatID, &draft); err != nil {
		return ScheduledMessage{}, fromMessageError(err)
	}
	sendAt := current.SendAt
	if input.SendAt != nil {
		sendAt = input.SendAt.UTC()
		if err := s.validateSendAt(sendAt); err != nil {
			return ScheduledMessage{}, err
		}
	}
	if err := s.messages.AuthorizeCreateTx(ctx, tx, user, current.ChatID, draft); err != nil {
		return ScheduledMessage{}, fromMessageError(err)
	}
	var result ScheduledMessage
	err = scan(tx.QueryRow(ctx, `
		UPDATE scheduled_messages sm SET body=$4, body_format=$5, mentioned_actor_ids=$6, silent=$7, send_at=$8,
			version=version+1, updated_at=now()
		WHERE sm.org_id=$1 AND sm.author_id=$2 AND sm.id=$3
		RETURNING `+selectColumns, user.OrgID, user.ActorID, scheduledID, draft.Body, draft.BodyFormat,
		draft.MentionedActorIDs, draft.Silent, sendAt), &result)
	if err != nil {
		return ScheduledMessage{}, fmt.Errorf("update scheduled message: %w", err)
	}
	if !result.SendAt.Equal(current.SendAt) {
		if err := s.cancel(ctx, tx, current.riverJobID); err != nil {
			return ScheduledMessage{}, err
		}
		if err := s.schedule(ctx, tx, &result); err != nil {
			return ScheduledMessage{}, err
		}
	}
	items := []ScheduledMessage{result}
	if err := hydrateFiles(ctx, tx, user.OrgID, items); err != nil {
		return ScheduledMessage{}, err
	}
	result = items[0]
	seq, err := insertEvent(ctx, tx, user.OrgID, user.ActorID, result.ID, "scheduled_message.updated", result)
	if err != nil {
		return ScheduledMessage{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return ScheduledMessage{}, fmt.Errorf("commit scheduled message update: %w", err)
	}
	s.notify(user.OrgID, seq)
	return result, nil
}

// Delete cancels a pending message or removes a finished record. It needs
// no rights in the chat: an author who left can still clean up.
func (s *Service) Delete(ctx context.Context, author Author, scheduledID string) error {
	if author.SessionID == "" {
		return ErrForbidden
	}
	if err := validID(scheduledID); err != nil {
		return ErrNotFound
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("begin delete scheduled message: %w", err)
	}
	defer tx.Rollback(ctx)
	if err := lockOrganization(ctx, tx, author.User.OrgID); err != nil {
		return err
	}
	current, err := lockOwn(ctx, tx, author.User, scheduledID)
	if err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `DELETE FROM scheduled_messages WHERE org_id=$1 AND author_id=$2 AND id=$3`, author.User.OrgID, author.User.ActorID, scheduledID); err != nil {
		return fmt.Errorf("delete scheduled message: %w", err)
	}
	if current.Status == StatusPending {
		if err := s.cancel(ctx, tx, current.riverJobID); err != nil {
			return err
		}
	}
	seq, err := insertEvent(ctx, tx, author.User.OrgID, author.User.ActorID, scheduledID, "scheduled_message.deleted",
		map[string]any{"id": scheduledID, "chat_id": current.ChatID})
	if err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("commit scheduled message deletion: %w", err)
	}
	s.notify(author.User.OrgID, seq)
	return nil
}

// SendNow sends a pending message right away through the same delivery
// path as the scheduled job.
func (s *Service) SendNow(ctx context.Context, author Author, scheduledID string) (ScheduledMessage, error) {
	if author.SessionID == "" {
		return ScheduledMessage{}, ErrForbidden
	}
	if err := validID(scheduledID); err != nil {
		return ScheduledMessage{}, ErrNotFound
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return ScheduledMessage{}, fmt.Errorf("begin send scheduled message: %w", err)
	}
	defer tx.Rollback(ctx)
	if err := lockOrganization(ctx, tx, author.User.OrgID); err != nil {
		return ScheduledMessage{}, err
	}
	current, err := lockOwn(ctx, tx, author.User, scheduledID)
	if err != nil {
		return ScheduledMessage{}, err
	}
	if current.Status != StatusPending {
		return ScheduledMessage{}, ErrClosed
	}
	if err := requireLiveSession(ctx, tx, author.User, author.SessionID); err != nil {
		return ScheduledMessage{}, err
	}
	if err := tx.QueryRow(ctx, `UPDATE scheduled_messages SET send_at=least(send_at, now()) WHERE id=$1 RETURNING send_at`,
		scheduledID).Scan(&current.SendAt); err != nil {
		return ScheduledMessage{}, fmt.Errorf("move scheduled message to now: %w", err)
	}
	// If the immediate attempt below hits a transient error, the job retries
	// it now rather than at the old time.
	if err := s.cancel(ctx, tx, current.riverJobID); err != nil {
		return ScheduledMessage{}, err
	}
	if err := s.schedule(ctx, tx, &current); err != nil {
		return ScheduledMessage{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return ScheduledMessage{}, fmt.Errorf("commit send now: %w", err)
	}
	if err := s.Deliver(ctx, scheduledID, 0); err != nil {
		return ScheduledMessage{}, err
	}
	return s.Get(ctx, author, scheduledID)
}

// Snooze asks the job runner to come back later: the job woke up before the
// message's time, which only happens through clock skew.
type Snooze struct{ Delay time.Duration }

func (s Snooze) Error() string { return fmt.Sprintf("scheduled message not due for %s", s.Delay) }

// Deliver sends a due pending message. jobID is the delivery job running it,
// or 0 for an immediate send. It is idempotent: the record is locked, and
// only a pending, due record is sent, at most once. A refusal marks the
// record failed and returns nil; other errors are transient and retried.
func (s *Service) Deliver(ctx context.Context, scheduledID string, jobID int64) error {
	var orgID string
	if err := s.pool.QueryRow(ctx, `SELECT org_id FROM scheduled_messages WHERE id=$1`, scheduledID).Scan(&orgID); errors.Is(err, pgx.ErrNoRows) {
		return nil
	} else if err != nil {
		return fmt.Errorf("find scheduled message: %w", err)
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("begin deliver scheduled message: %w", err)
	}
	defer tx.Rollback(ctx)
	if err := lockOrganization(ctx, tx, orgID); errors.Is(err, ErrForbidden) {
		return nil
	} else if err != nil {
		return err
	}
	var current ScheduledMessage
	var now time.Time
	err = tx.QueryRow(ctx, `SELECT `+selectColumns+`, now() FROM scheduled_messages sm WHERE sm.id=$1 FOR UPDATE`, scheduledID).Scan(
		&current.ID, &current.orgID, &current.authorID, &current.ChatID, &current.ThreadRootID, &current.ReplyToID, &current.ClientMsgID,
		&current.Body, &current.BodyFormat, &current.MentionedActorIDs, &current.Silent, &current.SendAt, &current.Status,
		&current.FailureReason, &current.MessageID, &current.riverJobID, &current.Version, &current.CreatedAt, &current.UpdatedAt, &current.SentAt, &current.FailedAt, &now)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("lock scheduled message: %w", err)
	}
	if current.Status != StatusPending {
		return nil
	}
	if current.SendAt.After(now) {
		// A job left over from an earlier send time does nothing; the
		// current one only woke up early and comes back on time.
		if jobID != 0 && current.riverJobID != nil && *current.riverJobID == jobID {
			return Snooze{Delay: current.SendAt.Sub(now)}
		}
		return nil
	}
	if err := loadFileIDs(ctx, tx, []*ScheduledMessage{&current}); err != nil {
		return err
	}
	user, reason, err := checkAtSend(ctx, tx, current)
	if err != nil {
		return err
	}
	draft := current.messageInput()
	if reason == "" {
		if err := s.messages.ValidateCreate(current.ChatID, &draft); err != nil {
			reason = ReasonInvalidContent
		}
	}
	if reason == "" {
		if err := s.messages.AuthorizeCreateTx(ctx, tx, user, current.ChatID, draft); err != nil {
			reason = reasonFor(err)
			if reason == "" {
				return err
			}
		}
	}
	if reason != "" {
		return s.failLocked(ctx, tx, current, jobID, reason)
	}
	sent, _, _, err := s.messages.CreateTx(ctx, tx, user, current.ChatID, draft)
	if err != nil {
		reason := reasonFor(err)
		if reason == "" {
			return err
		}
		// The send path may have written before refusing: start over in a
		// clean transaction that only records the failure.
		_ = tx.Rollback(ctx)
		return s.fail(ctx, scheduledID, jobID, reason)
	}
	var result ScheduledMessage
	err = scan(tx.QueryRow(ctx, `
		UPDATE scheduled_messages sm SET status='sent', message_id=$2, sent_at=now(), body='', mentioned_actor_ids='{}',
			version=version+1, updated_at=now()
		WHERE sm.id=$1 RETURNING `+selectColumns, scheduledID, sent.ID), &result)
	if err != nil {
		return fmt.Errorf("mark scheduled message sent: %w", err)
	}
	// The message now carries the files; the scheduled record lets go.
	if _, err := tx.Exec(ctx, `DELETE FROM scheduled_message_files WHERE scheduled_message_id=$1`, scheduledID); err != nil {
		return fmt.Errorf("release scheduled message files: %w", err)
	}
	if current.riverJobID != nil && *current.riverJobID != jobID {
		if err := s.cancel(ctx, tx, current.riverJobID); err != nil {
			return err
		}
	}
	result.Files = []files.File{}
	seq, err := insertEvent(ctx, tx, result.orgID, result.authorID, result.ID, "scheduled_message.sent", result)
	if err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("commit scheduled message delivery: %w", err)
	}
	// seq follows the message's own events, so one wake-up covers both.
	s.notify(result.orgID, seq)
	return nil
}

// MarkDeliveryFailed records that delivery kept failing for internal reasons.
func (s *Service) MarkDeliveryFailed(ctx context.Context, scheduledID string, jobID int64) error {
	return s.fail(ctx, scheduledID, jobID, ReasonDeliveryError)
}

func (s *Service) fail(ctx context.Context, scheduledID string, jobID int64, reason string) error {
	var orgID string
	if err := s.pool.QueryRow(ctx, `SELECT org_id FROM scheduled_messages WHERE id=$1`, scheduledID).Scan(&orgID); errors.Is(err, pgx.ErrNoRows) {
		return nil
	} else if err != nil {
		return fmt.Errorf("find scheduled message: %w", err)
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("begin fail scheduled message: %w", err)
	}
	defer tx.Rollback(ctx)
	if err := lockOrganization(ctx, tx, orgID); errors.Is(err, ErrForbidden) {
		return nil
	} else if err != nil {
		return err
	}
	var current ScheduledMessage
	err = scan(tx.QueryRow(ctx, `SELECT `+selectColumns+` FROM scheduled_messages sm WHERE sm.id=$1 FOR UPDATE`, scheduledID), &current)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("lock scheduled message: %w", err)
	}
	if current.Status != StatusPending {
		return nil
	}
	return s.failLocked(ctx, tx, current, jobID, reason)
}

func (s *Service) failLocked(ctx context.Context, tx pgx.Tx, current ScheduledMessage, jobID int64, reason string) error {
	var result ScheduledMessage
	err := scan(tx.QueryRow(ctx, `
		UPDATE scheduled_messages sm SET status='failed', failure_reason=$2, failed_at=now(), version=version+1, updated_at=now()
		WHERE sm.id=$1 RETURNING `+selectColumns, current.ID, reason), &result)
	if err != nil {
		return fmt.Errorf("mark scheduled message failed: %w", err)
	}
	if current.riverJobID != nil && *current.riverJobID != jobID {
		if err := s.cancel(ctx, tx, current.riverJobID); err != nil {
			return err
		}
	}
	items := []ScheduledMessage{result}
	if err := hydrateFiles(ctx, tx, result.orgID, items); err != nil {
		return err
	}
	seq, err := insertEvent(ctx, tx, result.orgID, result.authorID, result.ID, "scheduled_message.failed", items[0])
	if err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("commit scheduled message failure: %w", err)
	}
	s.logger.Info("scheduled message not sent", "scheduled_message_id", result.ID, "reason", reason)
	s.notify(result.orgID, seq)
	return nil
}

// Cleanup removes sent records after a week and failed ones after a month.
func (s *Service) Cleanup(ctx context.Context) (int64, error) {
	command, err := s.pool.Exec(ctx, `
		DELETE FROM scheduled_messages WHERE id IN (
			SELECT id FROM scheduled_messages
			WHERE (status='sent' AND updated_at < now() - $1::interval) OR (status='failed' AND updated_at < now() - $2::interval)
			LIMIT 1000)`, sentRetention.String(), failedRetention.String())
	if err != nil {
		return 0, fmt.Errorf("clean up scheduled messages: %w", err)
	}
	return command.RowsAffected(), nil
}

// RunCleanup removes expired records until ctx ends.
func (s *Service) RunCleanup(ctx context.Context, interval time.Duration) {
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if removed, err := s.Cleanup(ctx); err != nil && !errors.Is(err, context.Canceled) {
				s.logger.Error("scheduled message cleanup failed", "error", err)
			} else if removed > 0 {
				s.logger.Info("scheduled messages cleaned up", "removed", removed)
			}
		}
	}
}

// checkAtSend repeats, as of the send transaction, the checks that decide
// whether the author may still send. It returns the author's current user
// or the reason the message must not go.
func checkAtSend(ctx context.Context, tx pgx.Tx, current ScheduledMessage) (identity.User, string, error) {
	user := identity.User{ActorID: current.authorID, OrgID: current.orgID}
	var actorType string
	var deleted bool
	err := tx.QueryRow(ctx, `SELECT type, org_role, status, deleted_at IS NOT NULL FROM actors WHERE org_id=$1 AND id=$2 FOR SHARE`,
		current.orgID, current.authorID).Scan(&actorType, &user.OrgRole, &user.Status, &deleted)
	if errors.Is(err, pgx.ErrNoRows) || (err == nil && (actorType != "user" || user.Status != "active" || deleted)) {
		return user, ReasonAuthorInactive, nil
	}
	if err != nil {
		return user, "", fmt.Errorf("load scheduled message author: %w", err)
	}
	var archived bool
	err = tx.QueryRow(ctx, `SELECT archived_at IS NOT NULL FROM chats WHERE org_id=$1 AND id=$2`, current.orgID, current.ChatID).Scan(&archived)
	if errors.Is(err, pgx.ErrNoRows) || (err == nil && archived) {
		return user, ReasonChatUnavailable, nil
	}
	if err != nil {
		return user, "", fmt.Errorf("check scheduled message chat: %w", err)
	}
	var member bool
	if err := tx.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM chat_members WHERE org_id=$1 AND chat_id=$2 AND actor_id=$3)`,
		current.orgID, current.ChatID, current.authorID).Scan(&member); err != nil {
		return user, "", fmt.Errorf("check scheduled message membership: %w", err)
	}
	if !member {
		return user, ReasonNotMember, nil
	}
	if len(current.fileIDs) > 0 {
		var ready int
		if err := tx.QueryRow(ctx, `SELECT count(*) FROM files WHERE org_id=$1 AND uploader_id=$2 AND id=ANY($3::uuid[]) AND status='ready'`,
			current.orgID, current.authorID, current.fileIDs).Scan(&ready); err != nil {
			return user, "", fmt.Errorf("check scheduled message files: %w", err)
		}
		if ready != len(current.fileIDs) {
			return user, ReasonAttachmentUnavailable, nil
		}
	}
	return user, "", nil
}

// reasonFor maps a refusal of the send path to a failure reason. An empty
// reason means the error is not a refusal and must be retried.
func reasonFor(err error) string {
	switch {
	case errors.Is(err, message.ErrForbidden):
		return ReasonForbidden
	case errors.Is(err, message.ErrNotFound):
		return ReasonNotMember
	case errors.Is(err, message.ErrInvalid):
		return ReasonReferenceUnavailable
	case errors.Is(err, message.ErrTooLarge), errors.Is(err, message.ErrIdempotencyConflict):
		return ReasonInvalidContent
	default:
		return ""
	}
}

func fromMessageError(err error) error {
	switch {
	case errors.Is(err, message.ErrTooLarge):
		return ErrTooLarge
	case errors.Is(err, message.ErrInvalid):
		return fmt.Errorf("%w: %s", ErrInvalid, err.Error())
	case errors.Is(err, message.ErrForbidden):
		return ErrForbidden
	case errors.Is(err, message.ErrNotFound):
		return ErrNotFound
	default:
		return err
	}
}

func (s *Service) validateSendAt(sendAt time.Time) error {
	now := s.now().UTC()
	if sendAt.IsZero() || !sendAt.After(now) {
		return fmt.Errorf("%w: send_at must be in the future", ErrInvalid)
	}
	if sendAt.After(now.Add(MaxHorizon)) {
		return fmt.Errorf("%w: send_at must be at most 365 days ahead", ErrInvalid)
	}
	return nil
}

func (s *Service) checkLimits(ctx context.Context, tx pgx.Tx, user identity.User, chatID string) error {
	var total, inChat int
	if err := tx.QueryRow(ctx, `
		SELECT count(*), count(*) FILTER (WHERE chat_id=$3) FROM scheduled_messages
		WHERE org_id=$1 AND author_id=$2 AND status='pending'`, user.OrgID, user.ActorID, chatID).Scan(&total, &inChat); err != nil {
		return fmt.Errorf("count scheduled messages: %w", err)
	}
	if total >= s.limits.PerAuthor || inChat >= s.limits.PerChat {
		return ErrLimitReached
	}
	return nil
}

func (s *Service) schedule(ctx context.Context, tx pgx.Tx, item *ScheduledMessage) error {
	if s.scheduler == nil {
		return nil
	}
	jobID, err := s.scheduler.ScheduleTx(ctx, tx, item.ID, item.SendAt)
	if err != nil {
		return fmt.Errorf("schedule delivery: %w", err)
	}
	if _, err := tx.Exec(ctx, `UPDATE scheduled_messages SET river_job_id=$2 WHERE id=$1`, item.ID, jobID); err != nil {
		return fmt.Errorf("store delivery job: %w", err)
	}
	item.riverJobID = &jobID
	return nil
}

func (s *Service) cancel(ctx context.Context, tx pgx.Tx, jobID *int64) error {
	if s.scheduler == nil || jobID == nil {
		return nil
	}
	if err := s.scheduler.CancelTx(ctx, tx, *jobID); err != nil {
		return fmt.Errorf("cancel delivery job: %w", err)
	}
	return nil
}

func (s *Service) notify(orgID string, seq int64) {
	if s.afterCommit != nil && seq > 0 {
		s.afterCommit(orgID, seq)
	}
}

func (item ScheduledMessage) messageInput() message.CreateInput {
	mentions := append([]string{}, item.MentionedActorIDs...)
	fileIDs := append([]string{}, item.fileIDs...)
	return message.CreateInput{
		ClientMsgID: item.ClientMsgID, Body: item.Body, BodyFormat: item.BodyFormat,
		ReplyToID: item.ReplyToID, ThreadRootID: item.ThreadRootID,
		MentionedActorIDs: mentions, FileIDs: fileIDs, Silent: item.Silent,
	}
}

func lockOrganization(ctx context.Context, tx pgx.Tx, orgID string) error {
	var seq int64
	if err := tx.QueryRow(ctx, `SELECT event_seq FROM organizations WHERE id=$1 FOR UPDATE`, orgID).Scan(&seq); errors.Is(err, pgx.ErrNoRows) {
		return ErrForbidden
	} else if err != nil {
		return fmt.Errorf("lock organization: %w", err)
	}
	return nil
}

// lockOwn finds a record only among the caller's own: anyone else's id
// reads as missing.
func lockOwn(ctx context.Context, tx pgx.Tx, user identity.User, scheduledID string) (ScheduledMessage, error) {
	var item ScheduledMessage
	err := scan(tx.QueryRow(ctx, `SELECT `+selectColumns+` FROM scheduled_messages sm WHERE sm.org_id=$1 AND sm.author_id=$2 AND sm.id=$3 FOR UPDATE`,
		user.OrgID, user.ActorID, scheduledID), &item)
	if errors.Is(err, pgx.ErrNoRows) {
		return ScheduledMessage{}, ErrNotFound
	}
	if err != nil {
		return ScheduledMessage{}, fmt.Errorf("lock scheduled message: %w", err)
	}
	return item, nil
}

// activeAuthor reloads the caller from the database instead of trusting
// the role carried by the access token.
func activeAuthor(ctx context.Context, tx pgx.Tx, user identity.User) (identity.User, error) {
	result := user
	err := tx.QueryRow(ctx, `SELECT org_role, status FROM actors WHERE org_id=$1 AND id=$2 AND type='user' AND status='active' AND deleted_at IS NULL FOR SHARE`,
		user.OrgID, user.ActorID).Scan(&result.OrgRole, &result.Status)
	if errors.Is(err, pgx.ErrNoRows) {
		return identity.User{}, ErrForbidden
	}
	if err != nil {
		return identity.User{}, fmt.Errorf("load scheduled message author: %w", err)
	}
	return result, nil
}

// requireLiveSession checks that the caller's own session is still signed
// in. Nothing about the session is stored with the message.
func requireLiveSession(ctx context.Context, tx pgx.Tx, user identity.User, sessionID string) error {
	if _, err := uuid.Parse(sessionID); err != nil {
		return ErrForbidden
	}
	var live bool
	if err := tx.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM sessions WHERE org_id=$1 AND actor_id=$2 AND id=$3 AND revoked_at IS NULL)`,
		user.OrgID, user.ActorID, sessionID).Scan(&live); err != nil {
		return fmt.Errorf("check session: %w", err)
	}
	if !live {
		return ErrForbidden
	}
	return nil
}

func loadFileIDs(ctx context.Context, tx pgx.Tx, items []*ScheduledMessage) error {
	for _, item := range items {
		item.fileIDs = []string{}
		if err := tx.QueryRow(ctx, `SELECT COALESCE(array_agg(file_id ORDER BY ordinal), '{}') FROM scheduled_message_files WHERE scheduled_message_id=$1`, item.ID).Scan(&item.fileIDs); err != nil {
			return fmt.Errorf("load scheduled message files: %w", err)
		}
	}
	return nil
}

func hydrateFiles(ctx context.Context, tx pgx.Tx, orgID string, items []ScheduledMessage) error {
	if len(items) == 0 {
		return nil
	}
	ids := make([]string, len(items))
	index := make(map[string]int, len(items))
	for i := range items {
		ids[i] = items[i].ID
		index[items[i].ID] = i
		items[i].Files = []files.File{}
		if items[i].MentionedActorIDs == nil {
			items[i].MentionedActorIDs = []string{}
		}
	}
	rows, err := tx.Query(ctx, `
		SELECT smf.scheduled_message_id, f.id, f.name, f.mime, f.size, f.sha256, f.status, f.processing_status,
		       f.preview_file_id, f.created_at, f.ready_at, f.uploader_id
		FROM scheduled_message_files smf JOIN files f ON f.org_id = smf.org_id AND f.id = smf.file_id
		WHERE smf.org_id = $1 AND smf.scheduled_message_id = ANY($2::uuid[]) AND f.status <> 'deleted'
		ORDER BY smf.scheduled_message_id, smf.ordinal`, orgID, ids)
	if err != nil {
		return fmt.Errorf("load scheduled message files: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var scheduledID string
		var item files.File
		var checksum []byte
		if err := rows.Scan(&scheduledID, &item.ID, &item.Name, &item.MIME, &item.Size, &checksum, &item.Status, &item.ProcessingStatus,
			&item.PreviewFileID, &item.CreatedAt, &item.ReadyAt, &item.UploaderID); err != nil {
			return fmt.Errorf("scan scheduled message file: %w", err)
		}
		if len(checksum) == sha256.Size {
			value := hex.EncodeToString(checksum)
			item.SHA256 = &value
		}
		items[index[scheduledID]].Files = append(items[index[scheduledID]].Files, item)
	}
	return rows.Err()
}

// insertEvent records an event for the author's devices only. chat_id stays
// empty on purpose: delivery must not depend on chat membership, so an
// author who left still learns that the message failed.
func insertEvent(ctx context.Context, tx pgx.Tx, orgID, authorID, subjectID, eventType string, data any) (int64, error) {
	payload, err := json.Marshal(data)
	if err != nil {
		return 0, fmt.Errorf("marshal scheduled message event: %w", err)
	}
	var seq int64
	if err := tx.QueryRow(ctx, `UPDATE organizations SET event_seq = event_seq + 1 WHERE id = $1 RETURNING event_seq`, orgID).Scan(&seq); err != nil {
		return 0, fmt.Errorf("allocate event sequence: %w", err)
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO events (org_id, seq, type, actor_id, chat_id, subject_id, audience_actor_id, data)
		VALUES ($1, $2, $3, $4, NULL, $5, $4, $6::jsonb)`, orgID, seq, eventType, authorID, subjectID, string(payload)); err != nil {
		return 0, fmt.Errorf("insert scheduled message event: %w", err)
	}
	return seq, nil
}

func createFingerprint(chatID string, input message.CreateInput, sendAt time.Time) [32]byte {
	content := message.CommandFingerprint(chatID, input)
	var at [8]byte
	binary.BigEndian.PutUint64(at[:], uint64(sendAt.UnixMicro()))
	return sha256.Sum256(append(content[:], at[:]...))
}

func validID(value string) error {
	if _, err := uuid.Parse(value); err != nil {
		return fmt.Errorf("%w: identifier must be a UUID", ErrInvalid)
	}
	return nil
}
