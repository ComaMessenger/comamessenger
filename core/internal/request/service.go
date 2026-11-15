package request

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/comamessenger/comamessenger/core/internal/identity"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Jobs schedules and cancels the River jobs of requests inside the caller's
// transaction. A job that runs after its request changed finds nothing to
// do, so a missing cancellation is never harmful.
type Jobs interface {
	ScheduleTx(ctx context.Context, tx pgx.Tx, kind, messageID string, at time.Time) (int64, error)
	CancelTx(ctx context.Context, tx pgx.Tx, jobID int64) error
}

// Job kinds.
const (
	KindAutoRemind = "message_request.auto_remind"
	KindExpire     = "message_request.expire"
)

type Service struct {
	pool        *pgxpool.Pool
	afterCommit func(orgID string, highWatermark int64)
	jobs        Jobs
	limits      Limits
	now         func() time.Time
}

func NewService(pool *pgxpool.Pool, afterCommit func(string, int64)) *Service {
	return &Service{pool: pool, afterCommit: afterCommit, limits: DefaultLimits(), now: time.Now}
}

func (s *Service) SetJobs(jobs Jobs)              { s.jobs = jobs }
func (s *Service) SetLimits(limits Limits)        { s.limits = limits }
func (s *Service) SetClock(now func() time.Time)  { s.now = now }
func (s *Service) Limits() Limits                 { return s.limits }
func (s *Service) Now() time.Time                 { return s.now().UTC().Truncate(time.Microsecond) }
func (s *Service) notify(orgID string, seq int64) { s.afterCommitOrNil(orgID, seq) }
func (s *Service) afterCommitOrNil(o string, q int64) {
	if s.afterCommit != nil && q > 0 {
		s.afterCommit(o, q)
	}
}

// Recipients is the audience turned into people inside the send
// transaction.
type Recipients struct {
	ActorIDs []string
	Label    string
}

// ResolveTx turns the audience into the list of people asked: active people
// (not agents) who are members of the chat now, the author left out. The
// caller holds the organization lock, so membership cannot change before the
// rows are written. It also checks the open-request limits.
func (s *Service) ResolveTx(ctx context.Context, tx pgx.Tx, user identity.User, chatID string, plan Plan) (Recipients, error) {
	var openByAuthor, openInChat int
	if err := tx.QueryRow(ctx, `
		SELECT
			(SELECT count(*) FROM message_requests WHERE org_id=$1 AND author_id=$2 AND status='open'),
			(SELECT count(*) FROM message_requests WHERE org_id=$1 AND chat_id=$3 AND status='open')`,
		user.OrgID, user.ActorID, chatID).Scan(&openByAuthor, &openInChat); err != nil {
		return Recipients{}, fmt.Errorf("count open requests: %w", err)
	}
	if openByAuthor >= s.limits.OpenPerAuthor || openInChat >= s.limits.OpenPerChat {
		return Recipients{}, ErrLimitReached
	}
	var filter []string
	var groupLabel string
	switch plan.AudienceKind {
	case "people":
		filter = plan.ActorIDs
	case "department", "position":
		group, label, err := resolveGroupTx(ctx, tx, user, chatID, plan)
		if err != nil {
			return Recipients{}, err
		}
		// The rows below check membership and status once more.
		filter, groupLabel = group, label
	}
	rows, err := tx.Query(ctx, `
		SELECT a.id, a.display_name
		FROM chat_members cm
		JOIN actors a ON a.org_id = cm.org_id AND a.id = cm.actor_id
		WHERE cm.org_id = $1 AND cm.chat_id = $2 AND cm.actor_id <> $3
		  AND a.type = 'user' AND a.status = 'active' AND a.deleted_at IS NULL
		  AND ($4::uuid[] IS NULL OR cm.actor_id = ANY($4::uuid[]))
		ORDER BY a.id
		LIMIT $5`, user.OrgID, chatID, user.ActorID, filter, s.limits.MaxRecipients+1)
	if err != nil {
		return Recipients{}, fmt.Errorf("resolve request audience: %w", err)
	}
	defer rows.Close()
	result := Recipients{}
	var onlyName string
	for rows.Next() {
		var actorID, name string
		if err := rows.Scan(&actorID, &name); err != nil {
			return Recipients{}, fmt.Errorf("scan request recipient: %w", err)
		}
		result.ActorIDs = append(result.ActorIDs, actorID)
		onlyName = name
	}
	if err := rows.Err(); err != nil {
		return Recipients{}, fmt.Errorf("iterate request recipients: %w", err)
	}
	switch {
	case len(result.ActorIDs) == 0:
		return Recipients{}, ErrAudienceEmpty
	case len(result.ActorIDs) > s.limits.MaxRecipients:
		return Recipients{}, ErrTooManyRecipients
	}
	if plan.AudienceKind == "people" && len(result.ActorIDs) == 1 {
		result.Label = truncateRunes(onlyName, MaxLabelRunes)
	}
	if groupLabel != "" {
		result.Label = groupLabel
	}
	return result, nil
}

// AssignTx writes request.assigned to every recipient. It runs before the
// message itself is written, so each client learns «this is for me» before
// the card arrives with message.created.
func AssignTx(ctx context.Context, tx pgx.Tx, user identity.User, chatID, messageID string, plan Plan, recipients Recipients) error {
	_, err := insertAudienceEvents(ctx, tx, user.OrgID, "request.assigned", user.ActorID, chatID, messageID, recipients.ActorIDs,
		assignedEvent{MessageID: messageID, ChatID: chatID, DueAt: plan.DueAt})
	return err
}

// InsertTx stores the request of a just inserted message and schedules its
// jobs. createdAt is the message's creation time.
func (s *Service) InsertTx(ctx context.Context, tx pgx.Tx, user identity.User, chatID, messageID string, plan Plan, recipients Recipients) error {
	now := s.Now()
	expireAt := now.Add(s.limits.ExpireIdle)
	if plan.DueAt != nil {
		expireAt = plan.DueAt.Add(s.limits.ExpireAfterDue)
	}
	options := plan.Answer.Options
	if options == nil {
		options = []string{}
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO message_requests (org_id, message_id, chat_id, author_id, audience_kind, audience_label,
			answer_preset, custom_options, allow_comment, due_at, auto_remind, auto_remind_at,
			recipient_count, expire_at, created_at, audience_department_id, audience_position_id)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,NULLIF($16, '')::uuid,NULLIF($17, '')::uuid)`,
		user.OrgID, messageID, chatID, user.ActorID, plan.AudienceKind, recipients.Label,
		plan.Answer.Preset, options, plan.AllowComment, plan.DueAt, plan.AutoRemindAt != nil, plan.AutoRemindAt,
		len(recipients.ActorIDs), expireAt, now, plan.DepartmentID, plan.PositionID); err != nil {
		return fmt.Errorf("insert request: %w", err)
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO message_request_recipients (org_id, message_id, actor_id, chat_id)
		SELECT $1, $2, recipient, $3 FROM unnest($4::uuid[]) AS recipient`,
		user.OrgID, messageID, chatID, recipients.ActorIDs); err != nil {
		return fmt.Errorf("insert request recipients: %w", err)
	}
	if s.jobs == nil {
		return nil
	}
	var remindJob *int64
	if plan.AutoRemindAt != nil {
		jobID, err := s.jobs.ScheduleTx(ctx, tx, KindAutoRemind, messageID, *plan.AutoRemindAt)
		if err != nil {
			return fmt.Errorf("schedule request auto reminder: %w", err)
		}
		remindJob = &jobID
	}
	expireJob, err := s.jobs.ScheduleTx(ctx, tx, KindExpire, messageID, expireAt)
	if err != nil {
		return fmt.Errorf("schedule request expiry: %w", err)
	}
	if _, err := tx.Exec(ctx, `UPDATE message_requests SET auto_remind_job_id=$2, expire_job_id=$3 WHERE message_id=$1`,
		messageID, remindJob, expireJob); err != nil {
		return fmt.Errorf("record request jobs: %w", err)
	}
	return nil
}

// OnMessageDeletedTx closes the request of a message deleted in tx and
// cancels its jobs. The caller holds the organization lock and the message
// row (message.Service.Delete), which is the order every request write
// follows: organization, message, request, recipient. A message that is not
// a request, or a request already closed, is left alone. service may be nil
// (tests, tools without jobs): stale jobs then find a closed request.
func OnMessageDeletedTx(ctx context.Context, tx pgx.Tx, service *Service, user identity.User, messageID string) error {
	current, err := lockRequest(ctx, tx, user.OrgID, messageID)
	if errors.Is(err, ErrNotFound) {
		return nil
	}
	if err != nil {
		return err
	}
	if current.Status != "open" {
		return nil
	}
	if err := tx.QueryRow(ctx, `
		UPDATE message_requests SET status='closed', closed_reason='message_deleted', closed_by=$2,
			closed_at=now(), version=version+1, auto_remind_job_id=NULL, expire_job_id=NULL
		WHERE message_id=$1 RETURNING version`, messageID, user.ActorID).Scan(&current.Version); err != nil {
		return fmt.Errorf("close request of deleted message: %w", err)
	}
	if err := closeRecipientsTx(ctx, tx, messageID); err != nil {
		return err
	}
	if service != nil {
		if err := service.cancelJobs(ctx, tx, current); err != nil {
			return err
		}
	}
	current.Status, current.ClosedReason = "closed", strPtr("message_deleted")
	_, err = emitUpdated(ctx, tx, current)
	return err
}

func (s *Service) cancelJobs(ctx context.Context, tx pgx.Tx, r lockedRequest) error {
	if s.jobs == nil {
		return nil
	}
	for _, jobID := range []*int64{r.AutoRemindJobID, r.ExpireJobID} {
		if jobID != nil {
			if err := s.jobs.CancelTx(ctx, tx, *jobID); err != nil {
				return fmt.Errorf("cancel request job: %w", err)
			}
		}
	}
	return nil
}

// lockedRequest is a request row under FOR UPDATE with its message and chat.
type lockedRequest struct {
	OrgID, MessageID, ChatID, AuthorID string
	Status                             string
	ClosedReason                       *string
	Preset                             string
	OptionCount                        int
	AllowComment                       bool
	DueAt                              *time.Time
	AutoRemindAt                       *time.Time
	AutoRemindJobID                    *int64
	AutoRemindedAt                     *time.Time
	AnsweredCount                      int
	LastManualRemindAt                 *time.Time
	ManualRemindCount                  int
	ExpireAt                           time.Time
	ExpireJobID                        *int64
	Version                            int
	MessageDeleted                     bool
	ChatArchived                       bool
	CreatedAt                          time.Time
}

func lockRequest(ctx context.Context, tx pgx.Tx, orgID, messageID string) (lockedRequest, error) {
	var r lockedRequest
	err := tx.QueryRow(ctx, `
		SELECT r.org_id, r.message_id, r.chat_id, r.author_id, r.status, r.closed_reason, r.answer_preset,
			cardinality(r.custom_options), r.allow_comment, r.due_at, r.auto_remind_at, r.auto_remind_job_id,
			r.auto_reminded_at, r.answered_count, r.last_manual_remind_at, r.manual_remind_count, r.expire_at,
			r.expire_job_id, r.version, m.deleted_at IS NOT NULL, c.archived_at IS NOT NULL, r.created_at
		FROM message_requests r
		JOIN messages m ON m.org_id = r.org_id AND m.id = r.message_id
		JOIN chats c ON c.org_id = r.org_id AND c.id = r.chat_id
		WHERE r.org_id = $1 AND r.message_id = $2
		FOR UPDATE OF r`, orgID, messageID).Scan(&r.OrgID, &r.MessageID, &r.ChatID, &r.AuthorID, &r.Status,
		&r.ClosedReason, &r.Preset, &r.OptionCount, &r.AllowComment, &r.DueAt, &r.AutoRemindAt, &r.AutoRemindJobID,
		&r.AutoRemindedAt, &r.AnsweredCount, &r.LastManualRemindAt, &r.ManualRemindCount, &r.ExpireAt,
		&r.ExpireJobID, &r.Version, &r.MessageDeleted, &r.ChatArchived, &r.CreatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return lockedRequest{}, ErrNotFound
	}
	if err != nil {
		return lockedRequest{}, fmt.Errorf("lock request: %w", err)
	}
	r.OptionCount = OptionCount(r.Preset, r.OptionCount)
	return r, nil
}

// closeRecipientsTx takes the recipients of a closed request out of the
// «Ждут вас» indexes.
func closeRecipientsTx(ctx context.Context, tx pgx.Tx, messageID string) error {
	if _, err := tx.Exec(ctx, `UPDATE message_request_recipients SET request_open = false WHERE message_id = $1 AND request_open`, messageID); err != nil {
		return fmt.Errorf("close request recipients: %w", err)
	}
	return nil
}

// waitingCount counts recipients without an answer who are still active
// members of the chat: the waiting part of «N из M».
func waitingCount(ctx context.Context, q querier, orgID, messageID string) (int, error) {
	var count int
	if err := q.QueryRow(ctx, `SELECT count(*) FROM message_request_recipients rr `+recipientInChat+`
		WHERE rr.org_id=$1 AND rr.message_id=$2 AND rr.answered_at IS NULL`, orgID, messageID).Scan(&count); err != nil {
		return 0, fmt.Errorf("count waiting recipients: %w", err)
	}
	return count, nil
}

// recipientInChat keeps recipients `rr` who are active members of the
// request's chat now.
const recipientInChat = `
	JOIN chat_members rcm ON rcm.org_id = rr.org_id AND rcm.chat_id = rr.chat_id AND rcm.actor_id = rr.actor_id
	JOIN actors ra ON ra.org_id = rr.org_id AND ra.id = rr.actor_id AND ra.status = 'active' AND ra.deleted_at IS NULL`

// Events. Their data never carries text, comments or who answered what;
// chat-wide events name the request's author as their actor, never the
// person who answered.

type assignedEvent struct {
	MessageID string     `json:"message_id"`
	ChatID    string     `json:"chat_id"`
	DueAt     *time.Time `json:"due_at"`
}

type updatedEvent struct {
	MessageID     string  `json:"message_id"`
	ChatID        string  `json:"chat_id"`
	Status        string  `json:"status"`
	ClosedReason  *string `json:"closed_reason"`
	AnsweredCount int     `json:"answered_count"`
	WaitingCount  int     `json:"waiting_count"`
	Version       int     `json:"version"`
}

type tallyEvent struct {
	MessageID    string `json:"message_id"`
	ChatID       string `json:"chat_id"`
	Tally        []int  `json:"tally"`
	WaitingCount int    `json:"waiting_count"`
	Version      int    `json:"version"`
}

type answerEvent struct {
	MessageID  string `json:"message_id"`
	ChatID     string `json:"chat_id"`
	Option     int    `json:"option"`
	HasComment bool   `json:"has_comment"`
	Late       bool   `json:"late"`
	Version    int    `json:"version"`
}

type remindedEvent struct {
	MessageID string `json:"message_id"`
	ChatID    string `json:"chat_id"`
	Kind      string `json:"kind"`
}

type autoRemindedEvent struct {
	MessageID     string `json:"message_id"`
	ChatID        string `json:"chat_id"`
	Reminded      int    `json:"reminded"`
	AnsweredCount int    `json:"answered_count"`
	WaitingCount  int    `json:"waiting_count"`
}

// emitUpdated writes request.updated to the whole chat.
func emitUpdated(ctx context.Context, tx pgx.Tx, r lockedRequest) (int64, error) {
	waiting, err := waitingCount(ctx, tx, r.OrgID, r.MessageID)
	if err != nil {
		return 0, err
	}
	seq, err := nextSequence(ctx, tx, r.OrgID)
	if err != nil {
		return 0, err
	}
	return seq, insertEvent(ctx, tx, r.OrgID, seq, "request.updated", r.AuthorID, r.ChatID, r.MessageID, nil, updatedEvent{
		MessageID: r.MessageID, ChatID: r.ChatID, Status: r.Status, ClosedReason: r.ClosedReason,
		AnsweredCount: r.AnsweredCount, WaitingCount: waiting, Version: r.Version,
	})
}

func nextSequence(ctx context.Context, tx pgx.Tx, orgID string) (int64, error) {
	var seq int64
	if err := tx.QueryRow(ctx, `UPDATE organizations SET event_seq = event_seq + 1 WHERE id = $1 RETURNING event_seq`, orgID).Scan(&seq); err != nil {
		return 0, fmt.Errorf("allocate event sequence: %w", err)
	}
	return seq, nil
}

func insertEvent(ctx context.Context, tx pgx.Tx, orgID string, seq int64, eventType, actorID, chatID, subjectID string, audience *string, data any) error {
	payload, err := json.Marshal(data)
	if err != nil {
		return fmt.Errorf("marshal request event: %w", err)
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO events (org_id, seq, type, actor_id, chat_id, subject_id, audience_actor_id, data)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)`, orgID, seq, eventType, actorID, chatID, subjectID, audience, string(payload)); err != nil {
		return fmt.Errorf("insert request event: %w", err)
	}
	// Reminders are pushed; the push worker picks the recipients.
	if eventType == "request.reminded" || eventType == "request.auto_reminded" {
		if _, err := tx.Exec(ctx, `INSERT INTO notification_jobs (org_id, event_seq) VALUES ($1, $2) ON CONFLICT DO NOTHING`, orgID, seq); err != nil {
			return fmt.Errorf("enqueue request notification: %w", err)
		}
	}
	return nil
}

// insertAudienceEvents writes one event with the same data to each person
// in audiences, in one statement: a request to 500 people costs two
// queries, not a thousand. It returns the last sequence number (0 for none).
func insertAudienceEvents(ctx context.Context, tx pgx.Tx, orgID, eventType, actorID, chatID, subjectID string, audiences []string, data any) (int64, error) {
	if len(audiences) == 0 {
		return 0, nil
	}
	payload, err := json.Marshal(data)
	if err != nil {
		return 0, fmt.Errorf("marshal request event: %w", err)
	}
	var last int64
	if err := tx.QueryRow(ctx, `UPDATE organizations SET event_seq = event_seq + $2 WHERE id = $1 RETURNING event_seq`, orgID, len(audiences)).Scan(&last); err != nil {
		return 0, fmt.Errorf("allocate event sequences: %w", err)
	}
	first := last - int64(len(audiences)) + 1
	if _, err := tx.Exec(ctx, `
		INSERT INTO events (org_id, seq, type, actor_id, chat_id, subject_id, audience_actor_id, data)
		SELECT $1, $2 + ordinality - 1, $3, $4, $5, $6, audience, $8::jsonb
		FROM unnest($7::uuid[]) WITH ORDINALITY AS target(audience, ordinality)`,
		orgID, first, eventType, actorID, chatID, subjectID, audiences, string(payload)); err != nil {
		return 0, fmt.Errorf("insert request events: %w", err)
	}
	if eventType == "request.reminded" {
		if _, err := tx.Exec(ctx, `INSERT INTO notification_jobs (org_id, event_seq) SELECT $1, generate_series($2::bigint, $3::bigint) ON CONFLICT DO NOTHING`, orgID, first, last); err != nil {
			return 0, fmt.Errorf("enqueue request notifications: %w", err)
		}
	}
	return last, nil
}

// lockOrganization serializes the organization's event sequence and comes
// first in every transaction that writes events (message.lockOrganization).
func lockOrganization(ctx context.Context, tx pgx.Tx, orgID string) error {
	var seq int64
	if err := tx.QueryRow(ctx, `SELECT event_seq FROM organizations WHERE id = $1 FOR NO KEY UPDATE`, orgID).Scan(&seq); errors.Is(err, pgx.ErrNoRows) {
		return ErrNotFound
	} else if err != nil {
		return fmt.Errorf("lock organization: %w", err)
	}
	return nil
}

type querier interface {
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
	Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error)
}

func strPtr(value string) *string { return &value }
