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
//   - Only people with a live session may schedule, change or send now. The
//     record keeps who authorized it: the session family of that device and
//     the author's security epoch. Signing out on the device itself or a
//     session expiring changes neither, so the message still goes out. Every
//     account-wide security event bumps the epoch and revoking one device
//     records its family (see package scheduledreset), in the event's own
//     transaction; delivery refuses both.
//   - Realtime events carry no text: the event log is long-lived and is
//     replayed to new devices. Clients read the record itself.
//   - The sent message's client_msg_id is derived from the record id, which
//     the server generates. The derivation is no secret; the value is
//     protected by being reserved: ordinary sends check the reservation
//     under the organization lock and refuse it.
//   - Files stay linked only to the scheduled record, so nobody but the
//     uploader can read them until the message is actually sent.
package scheduled

import (
	"context"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
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
	ErrNotRetryable        = errors.New("failed scheduled message cannot be sent again")
)

// NotRetryableError refuses to send a failed message again, or to change it
// for that, because the cause still holds. Reason is a failure reason, so the
// author reads the same words as on the record. The record stays failed.
type NotRetryableError struct{ Reason string }

func (e *NotRetryableError) Error() string {
	return ErrNotRetryable.Error() + ": " + e.Reason
}

func (e *NotRetryableError) Is(target error) bool { return target == ErrNotRetryable }

const (
	StatusPending = "pending"
	StatusSent    = "sent"
	StatusFailed  = "failed"

	ReasonAuthorInactive        = scheduledreset.ReasonAuthorInactive
	ReasonSecurityReset         = scheduledreset.ReasonSecurityReset
	ReasonSessionRevoked        = scheduledreset.ReasonSessionRevoked
	ReasonMissedSendTime        = "missed_send_time"
	ReasonChatUnavailable       = "chat_unavailable"
	ReasonNotMember             = "not_member"
	ReasonForbidden             = "forbidden"
	ReasonReferenceUnavailable  = "reference_unavailable"
	ReasonAttachmentUnavailable = "attachment_unavailable"
	ReasonInvalidContent        = "invalid_content"
	ReasonDeliveryError         = "delivery_error"

	// MaxHorizon is how far ahead a message may be scheduled.
	MaxHorizon = 365 * 24 * time.Hour
	// MaxLateness: a message that could not go out within this time after
	// its send time (the service was down, retries ran long) fails instead
	// of arriving out of context.
	MaxLateness = 15 * time.Minute
	// Sent records keep only their link to the message, failed ones keep
	// the text for the author to copy; both are removed after these delays.
	sentRetention   = 7 * 24 * time.Hour
	failedRetention = 30 * 24 * time.Hour
	// A revoked session family mark outlives the scheduling horizon by a
	// month before it may go.
	familyMarkRetention = MaxHorizon + 30*24*time.Hour
)

// reconcileStopped is scheduledreset.Reconcile; tests replace it to prove a
// failing person does not stop the cleanup pass.
var reconcileStopped = scheduledreset.Reconcile

// messageNamespace only makes the derived ids distinct from other UUIDv5
// values; it is public and protects nothing by itself.
var messageNamespace = uuid.MustParse("6f1c2b9e-3d4a-5e7f-8a1b-2c3d4e5f6a7b")

// MessageClientID is the client_msg_id the sent message will carry.
func MessageClientID(scheduledID string) string {
	return uuid.NewSHA1(messageNamespace, []byte("coma/scheduled-message/"+scheduledID)).String()
}

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
	ID           string  `json:"id"`
	ChatID       string  `json:"chat_id"`
	ThreadRootID *string `json:"thread_root_id"`
	ReplyToID    *string `json:"reply_to_id"`
	// ClientMsgID is the client's idempotency key for the scheduling request.
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

	orgID, authorID    string
	messageClientMsgID string
	sessionFamilyID    string
	securityEpoch      int64
	riverJobID         *int64
	fileIDs            []string
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
	ExpectedVersion   int       `json:"expected_version"`
	Body              *string   `json:"body"`
	BodyFormat        *string   `json:"body_format"`
	MentionedActorIDs *[]string `json:"mentioned_actor_ids"`
	// FileIDs replaces the attachments. Files no longer listed become
	// unattached again and fall under the ordinary cleanup.
	FileIDs *[]string  `json:"file_ids"`
	SendAt  *time.Time `json:"send_at"`
	Silent  *bool      `json:"silent"`
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
	sm.message_client_msg_id, sm.session_family_id, sm.security_epoch,
	sm.body, sm.body_format, sm.mentioned_actor_ids, sm.silent, sm.send_at, sm.status,
	sm.failure_reason, sm.message_id, sm.river_job_id, sm.version, sm.created_at, sm.updated_at, sm.sent_at, sm.failed_at`

func scan(row pgx.Row, item *ScheduledMessage, extra ...any) error {
	return row.Scan(append([]any{&item.ID, &item.orgID, &item.authorID, &item.ChatID, &item.ThreadRootID, &item.ReplyToID, &item.ClientMsgID,
		&item.messageClientMsgID, &item.sessionFamilyID, &item.securityEpoch,
		&item.Body, &item.BodyFormat, &item.MentionedActorIDs, &item.Silent, &item.SendAt, &item.Status,
		&item.FailureReason, &item.MessageID, &item.riverJobID, &item.Version, &item.CreatedAt, &item.UpdatedAt, &item.SentAt, &item.FailedAt}, extra...)...)
}

// grant is what an authorized request stamps on the record.
type grant struct {
	user     identity.User
	familyID string
	epoch    int64
}

// authorize checks, inside tx, that the caller is an active person whose
// password is in order and whose own session is live and not revoked for
// security reasons, and reads the security epoch. The rows are share-locked
// in the global order (actors, users, sessions): a security event that
// commits first is seen here, and one that commits later waits for this
// transaction and then moves the epoch past the value stored.
func authorize(ctx context.Context, tx pgx.Tx, author Author) (grant, error) {
	if author.SessionID == "" {
		return grant{}, ErrForbidden
	}
	if _, err := uuid.Parse(author.SessionID); err != nil {
		return grant{}, ErrForbidden
	}
	result := grant{user: author.User}
	err := tx.QueryRow(ctx, `SELECT org_role, status FROM actors
		WHERE org_id=$1 AND id=$2 AND type='user' AND status='active' AND deleted_at IS NULL FOR SHARE`,
		author.User.OrgID, author.User.ActorID).Scan(&result.user.OrgRole, &result.user.Status)
	if errors.Is(err, pgx.ErrNoRows) {
		return grant{}, ErrForbidden
	}
	if err != nil {
		return grant{}, fmt.Errorf("load scheduled message author: %w", err)
	}
	err = tx.QueryRow(ctx, `SELECT security_epoch FROM users
		WHERE org_id=$1 AND actor_id=$2 AND must_change_password_at IS NULL FOR SHARE`,
		author.User.OrgID, author.User.ActorID).Scan(&result.epoch)
	if errors.Is(err, pgx.ErrNoRows) {
		return grant{}, ErrForbidden
	}
	if err != nil {
		return grant{}, fmt.Errorf("load security epoch: %w", err)
	}
	err = tx.QueryRow(ctx, `SELECT s.family_id FROM sessions s
		WHERE s.org_id=$1 AND s.actor_id=$2 AND s.id=$3 AND s.revoked_at IS NULL
		  AND NOT EXISTS (SELECT 1 FROM revoked_session_families r WHERE r.family_id=s.family_id)
		FOR SHARE OF s`, author.User.OrgID, author.User.ActorID, author.SessionID).Scan(&result.familyID)
	if errors.Is(err, pgx.ErrNoRows) {
		return grant{}, ErrForbidden
	}
	if err != nil {
		return grant{}, fmt.Errorf("check session: %w", err)
	}
	return result, nil
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
	granted, err := authorize(ctx, tx, author)
	if err != nil {
		return ScheduledMessage{}, false, err
	}
	user := granted.user

	var existing ScheduledMessage
	var existingFingerprint []byte
	err = scan(tx.QueryRow(ctx, `SELECT `+selectColumns+`, sm.create_fingerprint FROM scheduled_messages sm
		WHERE sm.org_id=$1 AND sm.author_id=$2 AND sm.client_msg_id=$3`, user.OrgID, user.ActorID, draft.ClientMsgID), &existing, &existingFingerprint)
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
	if err := s.messages.AuthorizeCreateTx(ctx, tx, user, chatID, draft); err != nil {
		return ScheduledMessage{}, false, fromMessageError(err)
	}
	if err := checkFilesFree(ctx, tx, user.OrgID, scheduledID, draft.FileIDs); err != nil {
		return ScheduledMessage{}, false, err
	}
	if err := s.checkLimits(ctx, tx, user, chatID); err != nil {
		return ScheduledMessage{}, false, err
	}

	var result ScheduledMessage
	err = scan(tx.QueryRow(ctx, `
		INSERT INTO scheduled_messages AS sm (id, org_id, author_id, chat_id, thread_root_id, reply_to_id, client_msg_id,
			message_client_msg_id, create_fingerprint, session_family_id, security_epoch,
			body, body_format, mentioned_actor_ids, silent, send_at)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
		RETURNING `+selectColumns, scheduledID, user.OrgID, user.ActorID, chatID, draft.ThreadRootID, draft.ReplyToID, draft.ClientMsgID,
		MessageClientID(scheduledID), fingerprint[:], granted.familyID, granted.epoch,
		draft.Body, draft.BodyFormat, draft.MentionedActorIDs, draft.Silent, sendAt), &result)
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
	seq, err := insertEvent(ctx, tx, result, "scheduled_message.created")
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

// Update changes the text, mentions, files, silence or send time of a
// pending message, rechecking the author's rights as of now and re-stamping
// who authorized it.
//
// A failed message may be changed too: it is how the author sends it again.
// Every check of creation runs again and a cause that still holds is
// refused with NotRetryableError, leaving the record as it was. With a new
// send_at the record becomes pending again; without one it stays failed
// with the new content, ready for SendNow.
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
	if input.Body == nil && input.BodyFormat == nil && input.MentionedActorIDs == nil && input.FileIDs == nil && input.SendAt == nil && input.Silent == nil {
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
	// Every change of status bumps the version, so an edit based on an
	// older read reports the conflict, whatever happened in between.
	if current.Version != input.ExpectedVersion {
		return ScheduledMessage{}, ErrVersionConflict
	}
	if current.Status != StatusPending && current.Status != StatusFailed {
		return ScheduledMessage{}, ErrClosed
	}
	granted, err := authorize(ctx, tx, author)
	if err != nil {
		return ScheduledMessage{}, err
	}
	user := granted.user
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
	if input.FileIDs != nil {
		draft.FileIDs = append([]string{}, (*input.FileIDs)...)
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
	status := current.Status
	if current.Status == StatusFailed {
		if err := s.recheckFailed(ctx, tx, current, granted, draft); err != nil {
			return ScheduledMessage{}, err
		}
		if input.SendAt != nil {
			status = StatusPending
		}
	} else if err := s.messages.AuthorizeCreateTx(ctx, tx, user, current.ChatID, draft); err != nil {
		return ScheduledMessage{}, fromMessageError(err)
	}
	if err := checkFilesFree(ctx, tx, user.OrgID, current.ID, draft.FileIDs); err != nil {
		return ScheduledMessage{}, err
	}
	if status == StatusPending && current.Status == StatusFailed {
		// The record is not pending yet, so it is not among those counted.
		if err := s.checkLimits(ctx, tx, user, current.ChatID); err != nil {
			return ScheduledMessage{}, err
		}
	}
	var result ScheduledMessage
	err = scan(tx.QueryRow(ctx, `
		UPDATE scheduled_messages sm SET body=$4, body_format=$5, mentioned_actor_ids=$6, silent=$7, send_at=$8,
			session_family_id=$9, security_epoch=$10, status=$11,
			failure_reason=CASE WHEN $11='failed' THEN failure_reason END,
			failed_at=CASE WHEN $11='failed' THEN failed_at END,
			version=version+1, updated_at=now()
		WHERE sm.org_id=$1 AND sm.author_id=$2 AND sm.id=$3
		RETURNING `+selectColumns, user.OrgID, user.ActorID, scheduledID, draft.Body, draft.BodyFormat,
		draft.MentionedActorIDs, draft.Silent, sendAt, granted.familyID, granted.epoch, status), &result)
	if err != nil {
		return ScheduledMessage{}, fmt.Errorf("update scheduled message: %w", err)
	}
	if input.FileIDs != nil {
		if err := replaceFiles(ctx, tx, user.OrgID, scheduledID, draft.FileIDs); err != nil {
			return ScheduledMessage{}, err
		}
	}
	if status == StatusPending && (current.Status != StatusPending || !result.SendAt.Equal(current.SendAt)) {
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
	seq, err := insertEvent(ctx, tx, result, "scheduled_message.updated")
	if err != nil {
		return ScheduledMessage{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return ScheduledMessage{}, fmt.Errorf("commit scheduled message update: %w", err)
	}
	s.notify(user.OrgID, seq)
	return result, nil
}

// recheckFailed repeats, for a failed message the author wants to send
// again, everything creation and delivery check, as if it were stamped by
// the current request. A cause that still holds is a NotRetryableError.
func (s *Service) recheckFailed(ctx context.Context, tx pgx.Tx, current ScheduledMessage, granted grant, draft message.CreateInput) error {
	current.securityEpoch = granted.epoch
	current.sessionFamilyID = granted.familyID
	current.fileIDs = draft.FileIDs
	user, reason, err := checkAtSend(ctx, tx, current)
	if err != nil {
		return err
	}
	if reason == "" {
		if err := s.messages.AuthorizeCreateTx(ctx, tx, user, current.ChatID, draft); err != nil {
			if reason = reasonFor(err); reason == "" {
				return err
			}
		}
	}
	if reason != "" {
		return &NotRetryableError{Reason: reason}
	}
	return nil
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
	current.Status = "deleted"
	seq, err := insertEvent(ctx, tx, current, "scheduled_message.deleted")
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
// path as the scheduled job, re-stamping who authorized it. A failed
// message is sent again the same way once every check passes anew.
func (s *Service) SendNow(ctx context.Context, author Author, scheduledID string) (ScheduledMessage, error) {
	if author.SessionID == "" {
		return ScheduledMessage{}, ErrForbidden
	}
	if err := validID(scheduledID); err != nil {
		return ScheduledMessage{}, ErrNotFound
	}
	if err := s.prepareSendNow(ctx, author, scheduledID); err != nil {
		return ScheduledMessage{}, err
	}
	if err := s.Deliver(ctx, scheduledID, 0); err != nil {
		return ScheduledMessage{}, err
	}
	return s.Get(ctx, author, scheduledID)
}

// prepareSendNow moves the message to now and bumps its version in its own
// transaction. Bumping the version makes an edit based on the text the
// author saw before pressing "send now" a version conflict, so the edit
// cannot slip in between this commit and the delivery and change what goes
// out.
func (s *Service) prepareSendNow(ctx context.Context, author Author, scheduledID string) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("begin send scheduled message: %w", err)
	}
	defer tx.Rollback(ctx)
	if err := lockOrganization(ctx, tx, author.User.OrgID); err != nil {
		return err
	}
	current, err := lockOwn(ctx, tx, author.User, scheduledID)
	if err != nil {
		return err
	}
	if current.Status != StatusPending && current.Status != StatusFailed {
		return ErrClosed
	}
	granted, err := authorize(ctx, tx, author)
	if err != nil {
		return err
	}
	if current.Status == StatusFailed {
		// Sending a failed message again: everything is checked anew and a
		// cause that still holds leaves the record failed. The message keeps
		// its derived client_msg_id, so it can never be sent twice.
		if err := loadFileIDs(ctx, tx, []*ScheduledMessage{&current}); err != nil {
			return err
		}
		draft := current.messageInput()
		if err := s.messages.ValidateCreate(current.ChatID, &draft); err != nil {
			return &NotRetryableError{Reason: ReasonInvalidContent}
		}
		if err := s.recheckFailed(ctx, tx, current, granted, draft); err != nil {
			return err
		}
		if err := checkFilesFree(ctx, tx, current.orgID, current.ID, draft.FileIDs); errors.Is(err, ErrInvalid) {
			return &NotRetryableError{Reason: ReasonAttachmentUnavailable}
		} else if err != nil {
			return err
		}
		if err := s.checkLimits(ctx, tx, granted.user, current.ChatID); err != nil {
			return err
		}
	}
	if err := scan(tx.QueryRow(ctx, `
		UPDATE scheduled_messages sm SET send_at=now(), session_family_id=$2, security_epoch=$3,
			status='pending', failure_reason=NULL, failed_at=NULL, version=version+1, updated_at=now()
		WHERE sm.id=$1 RETURNING `+selectColumns, scheduledID, granted.familyID, granted.epoch), &current); err != nil {
		return fmt.Errorf("move scheduled message to now: %w", err)
	}
	// If the immediate attempt hits a transient error, the job retries it
	// now rather than at the old time.
	if err := s.cancel(ctx, tx, current.riverJobID); err != nil {
		return err
	}
	if err := s.schedule(ctx, tx, &current); err != nil {
		return err
	}
	seq, err := insertEvent(ctx, tx, current, "scheduled_message.updated")
	if err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("commit send now: %w", err)
	}
	s.notify(author.User.OrgID, seq)
	return nil
}

// Snooze asks the job runner to come back later: the job woke up before the
// message's time, which only happens through clock skew.
type Snooze struct{ Delay time.Duration }

func (s Snooze) Error() string { return fmt.Sprintf("scheduled message not due for %s", s.Delay) }

// Deliver sends a due pending message. jobID is the delivery job running it,
// or 0 for an immediate send. It is idempotent: the organization and the
// record are locked, and only a pending, due record is sent, at most once.
// A refusal marks the record failed and returns nil; other errors are
// transient and retried.
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
	err = scan(tx.QueryRow(ctx, `SELECT `+selectColumns+`, clock_timestamp() FROM scheduled_messages sm WHERE sm.id=$1 FOR UPDATE`, scheduledID), &current, &now)
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
	if reason == "" && now.Sub(current.SendAt) > MaxLateness {
		reason = ReasonMissedSendTime
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
	seq, err := insertEvent(ctx, tx, result, "scheduled_message.sent")
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
	seq, err := insertEvent(ctx, tx, result, "scheduled_message.failed")
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

// Cleanup marks messages stopped by security events failed, in case the
// step right after the event did not run, and removes sent records after a
// week and failed ones after a month.
func (s *Service) Cleanup(ctx context.Context) (int64, error) {
	// One person's failure must not keep the rest of the pass from running.
	var problems []error
	stopped, err := scheduledreset.Stopped(ctx, s.pool, 100)
	if err != nil {
		problems = append(problems, err)
	}
	for _, author := range stopped {
		seq, err := reconcileStopped(ctx, s.pool, author.OrgID, author.ActorID)
		if err != nil {
			problems = append(problems, fmt.Errorf("reconcile %s: %w", author.ActorID, err))
			continue
		}
		s.notify(author.OrgID, seq)
	}
	// A revoked family mark is useless once no pending message refers to
	// it and every message it could have stamped is past its send time:
	// a revoked family never authorizes again, so nothing new refers to it.
	if _, err := s.pool.Exec(ctx, `
		DELETE FROM revoked_session_families r
		WHERE r.revoked_at < now() - $1::interval
		  AND NOT EXISTS (SELECT 1 FROM scheduled_messages sm WHERE sm.session_family_id = r.family_id AND sm.status = 'pending')`,
		familyMarkRetention.String()); err != nil {
		problems = append(problems, fmt.Errorf("clean up revoked session families: %w", err))
	}
	command, err := s.pool.Exec(ctx, `
		DELETE FROM scheduled_messages sm WHERE sm.id IN (
			SELECT id FROM scheduled_messages
			WHERE (status='sent' AND updated_at < now() - $1::interval) OR (status='failed' AND updated_at < now() - $2::interval)
			LIMIT 1000)
		  -- Repeated here: a row that a concurrent retry locked and made
		  -- pending again is rechecked on its new version and kept.
		  AND ((sm.status='sent' AND sm.updated_at < now() - $1::interval) OR (sm.status='failed' AND sm.updated_at < now() - $2::interval))`, sentRetention.String(), failedRetention.String())
	if err != nil {
		problems = append(problems, fmt.Errorf("clean up scheduled messages: %w", err))
		return 0, errors.Join(problems...)
	}
	return command.RowsAffected(), errors.Join(problems...)
}

// RunCleanup repeats Cleanup until ctx ends.
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
// or the reason the message must not go. Rows are share-locked in the
// global order after the organization and the record, so a concurrent
// security event either committed before (and is seen) or waits for this
// transaction to finish.
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
	var epoch int64
	var passwordOK bool
	err = tx.QueryRow(ctx, `SELECT security_epoch, must_change_password_at IS NULL FROM users WHERE org_id=$1 AND actor_id=$2 FOR SHARE`,
		current.orgID, current.authorID).Scan(&epoch, &passwordOK)
	if errors.Is(err, pgx.ErrNoRows) {
		return user, ReasonAuthorInactive, nil
	}
	if err != nil {
		return user, "", fmt.Errorf("load security epoch: %w", err)
	}
	if !passwordOK || epoch != current.securityEpoch {
		return user, ReasonSecurityReset, nil
	}
	var revoked bool
	if err := tx.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM revoked_session_families WHERE family_id=$1)`, current.sessionFamilyID).Scan(&revoked); err != nil {
		return user, "", fmt.Errorf("check revoked session family: %w", err)
	}
	if revoked {
		return user, ReasonSessionRevoked, nil
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
		ClientMsgID: item.messageClientMsgID, Body: item.Body, BodyFormat: item.BodyFormat,
		ReplyToID: item.ReplyToID, ThreadRootID: item.ThreadRootID,
		MentionedActorIDs: mentions, FileIDs: fileIDs, Silent: item.Silent,
	}
}

func lockOrganization(ctx context.Context, tx pgx.Tx, orgID string) error {
	var seq int64
	if err := tx.QueryRow(ctx, `SELECT event_seq FROM organizations WHERE id=$1 FOR NO KEY UPDATE`, orgID).Scan(&seq); errors.Is(err, pgx.ErrNoRows) {
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

// checkFilesFree refuses files already attached to a message or to another
// scheduled message.
func checkFilesFree(ctx context.Context, tx pgx.Tx, orgID, scheduledID string, fileIDs []string) error {
	if len(fileIDs) == 0 {
		return nil
	}
	var taken bool
	if err := tx.QueryRow(ctx, `SELECT
		EXISTS (SELECT 1 FROM message_files WHERE org_id=$1 AND file_id=ANY($3::uuid[]))
		OR EXISTS (SELECT 1 FROM scheduled_message_files WHERE org_id=$1 AND file_id=ANY($3::uuid[]) AND scheduled_message_id<>$2)`,
		orgID, scheduledID, fileIDs).Scan(&taken); err != nil {
		return fmt.Errorf("check scheduled message files: %w", err)
	}
	if taken {
		return fmt.Errorf("%w: a file is already attached to another message", ErrInvalid)
	}
	return nil
}

// replaceFiles sets the record's attachments. Files dropped from the list
// lose their only link and become unattached again.
func replaceFiles(ctx context.Context, tx pgx.Tx, orgID, scheduledID string, fileIDs []string) error {
	if _, err := tx.Exec(ctx, `DELETE FROM scheduled_message_files WHERE scheduled_message_id=$1`, scheduledID); err != nil {
		return fmt.Errorf("detach scheduled message files: %w", err)
	}
	if len(fileIDs) == 0 {
		return nil
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO scheduled_message_files (scheduled_message_id, file_id, org_id, ordinal)
		SELECT $1, value, $2, ordinal - 1 FROM unnest($3::uuid[]) WITH ORDINALITY AS selected(value, ordinal)`,
		scheduledID, orgID, fileIDs); err != nil {
		return fmt.Errorf("attach scheduled message files: %w", err)
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

// insertEvent tells the author's devices that the record changed; they read
// the record itself for its content.
func insertEvent(ctx context.Context, tx pgx.Tx, item ScheduledMessage, eventType string) (int64, error) {
	return scheduledreset.InsertEventTx(ctx, tx, item.orgID, item.authorID, eventType, scheduledreset.Event{
		ID: item.ID, ChatID: item.ChatID, Status: item.Status, Version: item.Version, SendAt: item.SendAt, FailureReason: item.FailureReason,
	})
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
