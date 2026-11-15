// Package reminder keeps personal reminders about messages («Напомнить
// мне», phase 6.4 wave 1).
//
// Security model:
//   - A reminder is private to its owner. Every read and write filters by
//     organization and owner, so another person's id, an administrator's
//     included, is indistinguishable from a missing one. There is no
//     endpoint, event or audit record that shows someone else's reminders.
//   - Access to the message is never stored: it is checked on every read
//     and again when the reminder fires and when its push is built. Leaving
//     the chat, removal or archive hide the message (the note stays), and a
//     deleted message is gone from the reminder for good.
//   - Realtime events and River jobs carry only identifiers and times, never
//     the note or the message text: the event log is long-lived and replayed
//     to new devices. Events go only to the owner (audience_actor_id) and
//     carry no chat_id, so chat feeds and agent triggers never see them.
//   - This package does not import package message: message.Service.Delete
//     calls OnMessageDeletedTx inside its own transaction. The message shown
//     next to a reminder is read through message.Service by the HTTP layer,
//     with the same access rule.
package reminder

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/comamessenger/comamessenger/core/internal/id"
	"github.com/comamessenger/comamessenger/core/internal/identity"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

var (
	ErrNotFound     = errors.New("reminder not found")
	ErrInvalid      = errors.New("invalid reminder")
	ErrLimitReached = errors.New("reminder limit reached")
)

const (
	StatePending = "pending"
	StateFired   = "fired"

	EventCreated = "reminder.created"
	EventUpdated = "reminder.updated"
	EventDeleted = "reminder.deleted"
	EventFired   = "reminder.fired"

	ReasonRemoved        = "removed"
	ReasonMessageDeleted = "message_deleted"

	// MinLead and MaxHorizon bound remind_at, as for scheduled messages.
	MinLead    = time.Minute
	MaxHorizon = 365 * 24 * time.Hour
	// leadTolerance forgives a client clock or a slow request that picked
	// exactly «in one minute».
	leadTolerance = 10 * time.Second
	// MaxNote is the note length in characters.
	MaxNote = 200
	// LateAfter: a reminder that fires later than this after remind_at (the
	// server was down) is marked late, «пропущено».
	LateAfter = 15 * time.Minute
	// PushLateLimit: a reminder later than this fires without a push: an old
	// alarm at night is worse than none. The push package applies it.
	PushLateLimit = 6 * time.Hour
	// FiredRetention: a fired reminder the owner never closed is removed.
	FiredRetention = 90 * 24 * time.Hour
	// DefaultPendingLimit bounds pending reminders of one person.
	DefaultPendingLimit = 500
	// MaxFired bounds fired reminders a person keeps without closing them:
	// beyond it the oldest fired ones go, as retention would.
	MaxFired = 1000
)

// Scheduler places and removes fire jobs inside the caller's transaction, so
// a rollback never leaves a stray job behind.
type Scheduler interface {
	ScheduleTx(ctx context.Context, tx pgx.Tx, reminderID string, at time.Time) (int64, error)
	CancelTx(ctx context.Context, tx pgx.Tx, jobID int64) error
}

// Reminder is one person's reminder. The message itself is added by the
// HTTP layer while the owner can read it.
type Reminder struct {
	ID        string     `json:"id"`
	MessageID *string    `json:"message_id"`
	ChatID    string     `json:"chat_id"`
	Note      string     `json:"note"`
	RemindAt  time.Time  `json:"remind_at"`
	State     string     `json:"state"`
	FiredAt   *time.Time `json:"fired_at"`
	Late      bool       `json:"late"`
	Version   int        `json:"version"`

	orgID, actorID string
	riverJobID     *int64
}

// SetInput is the body of setMessageReminder and updateReminder. A nil Note
// keeps the current note (empty for a new reminder); "" removes it.
type SetInput struct {
	RemindAt time.Time `json:"remind_at"`
	Note     *string   `json:"note"`
}

type ListOptions struct {
	State  string
	Cursor *string
	Limit  int
}

type Page struct {
	Items      []Reminder `json:"items"`
	NextCursor *string    `json:"next_cursor"`
}

// IDEntry is the bell of one message in the feed.
type IDEntry struct {
	MessageID string    `json:"message_id"`
	RemindAt  time.Time `json:"remind_at"`
	State     string    `json:"state"`
}

type Service struct {
	pool         *pgxpool.Pool
	scheduler    Scheduler
	afterCommit  func(orgID string, highWatermark int64)
	now          func() time.Time
	pendingLimit int
	logger       *slog.Logger
}

func NewService(pool *pgxpool.Pool, afterCommit func(string, int64), logger *slog.Logger) *Service {
	if logger == nil {
		logger = slog.Default()
	}
	return &Service{pool: pool, afterCommit: afterCommit, now: time.Now, pendingLimit: DefaultPendingLimit, logger: logger}
}

func (s *Service) SetScheduler(scheduler Scheduler) { s.scheduler = scheduler }

// SetClock replaces the clock used to validate remind_at (tests only: firing
// itself always follows the database clock).
func (s *Service) SetClock(now func() time.Time) { s.now = now }

// SetPendingLimit replaces the pending limit (tests only).
func (s *Service) SetPendingLimit(limit int) { s.pendingLimit = limit }

const selectColumns = `r.id, r.org_id, r.actor_id, r.message_id, r.chat_id, r.note, r.remind_at, r.state,
	r.fired_at, r.fired_late, r.river_job_id, r.version`

func scan(row pgx.Row, item *Reminder, extra ...any) error {
	return row.Scan(append([]any{&item.ID, &item.orgID, &item.actorID, &item.MessageID, &item.ChatID, &item.Note,
		&item.RemindAt, &item.State, &item.FiredAt, &item.Late, &item.riverJobID, &item.Version}, extra...)...)
}

// readableMessage is the access rule for the owner `$3` of a message `$2`:
// the message is not deleted, the chat is live, the owner is an active
// member of it, and not an agent that only writes there. The same rule as
// «Important» (message.visibleSave). It yields the chat id.
const readableMessage = `
	SELECT m.chat_id FROM messages m
	JOIN chats c ON c.org_id = m.org_id AND c.id = m.chat_id AND c.archived_at IS NULL
	JOIN chat_members cm ON cm.org_id = m.org_id AND cm.chat_id = m.chat_id AND cm.actor_id = $3
	JOIN actors owner ON owner.org_id = cm.org_id AND owner.id = cm.actor_id
		AND owner.status = 'active' AND owner.deleted_at IS NULL
	WHERE m.org_id = $1 AND m.id = $2 AND m.deleted_at IS NULL
	  AND NOT EXISTS (
		SELECT 1 FROM agents agent WHERE agent.org_id = m.org_id AND agent.actor_id = $3
		  AND m.chat_id = ANY(agent.write_only_chat_ids))`

func findTarget(ctx context.Context, tx pgx.Tx, user identity.User, messageID string) (string, error) {
	var chatID string
	err := tx.QueryRow(ctx, readableMessage, user.OrgID, messageID, user.ActorID).Scan(&chatID)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", ErrNotFound
	}
	if err != nil {
		return "", fmt.Errorf("find message to remind about: %w", err)
	}
	return chatID, nil
}

// Lock order. Every write here first takes a transaction advisory lock of
// the owner (nobody holding the organization row ever waits for it), then
// the organization row, then the reminder row. Message deletion takes the
// organization, then the message, then the reminders of it
// (OnMessageDeletedTx), and firing takes the organization, then the
// reminder: the organization row serializes them all. The owner's `actors`
// row is never locked: writing a message share-locks it after the
// organization (see message.SaveMessage for the deadlock this avoids).

func serializeOwner(ctx context.Context, tx pgx.Tx, user identity.User) error {
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended('message_reminders:' || $1::text, 0))`, user.ActorID); err != nil {
		return fmt.Errorf("serialize reminders: %w", err)
	}
	return nil
}

// Set creates the person's reminder about a message they can read, or moves
// the existing one. The reply says whether it was created. Setting the same
// time and note on a pending reminder changes nothing and emits nothing.
func (s *Service) Set(ctx context.Context, user identity.User, messageID string, input SetInput) (Reminder, bool, error) {
	if err := validID("message_id", messageID); err != nil {
		return Reminder{}, false, err
	}
	if err := s.validate(input); err != nil {
		return Reminder{}, false, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Reminder{}, false, fmt.Errorf("begin set reminder: %w", err)
	}
	defer tx.Rollback(ctx)
	if err := serializeOwner(ctx, tx, user); err != nil {
		return Reminder{}, false, err
	}
	// Checks without row locks; repeated under the organization lock.
	if _, err := findTarget(ctx, tx, user, messageID); err != nil {
		return Reminder{}, false, err
	}
	current, exists, err := s.findByMessage(ctx, tx, user, messageID, false)
	if err != nil {
		return Reminder{}, false, err
	}
	if !exists || current.State != StatePending {
		if err := s.checkLimit(ctx, tx, user); err != nil {
			return Reminder{}, false, err
		}
	}
	if err := lockOrganization(ctx, tx, user.OrgID); err != nil {
		return Reminder{}, false, err
	}
	// The message may have been deleted or access lost meanwhile: both take
	// the organization row, so they are visible now.
	chatID, err := findTarget(ctx, tx, user, messageID)
	if err != nil {
		return Reminder{}, false, err
	}
	current, exists, err = s.findByMessage(ctx, tx, user, messageID, true)
	if err != nil {
		return Reminder{}, false, err
	}
	if exists {
		result, seq, err := s.move(ctx, tx, current, input)
		if err != nil {
			return Reminder{}, false, err
		}
		if err := tx.Commit(ctx); err != nil {
			return Reminder{}, false, fmt.Errorf("commit set reminder: %w", err)
		}
		s.notify(user.OrgID, seq)
		return result, false, nil
	}
	reminderID, err := id.New()
	if err != nil {
		return Reminder{}, false, fmt.Errorf("generate reminder id: %w", err)
	}
	note := ""
	if input.Note != nil {
		note = *input.Note
	}
	var result Reminder
	err = scan(tx.QueryRow(ctx, `
		INSERT INTO message_reminders AS r (id, org_id, actor_id, message_id, chat_id, note, remind_at)
		VALUES ($1, $2, $3, $4, $5, $6, $7)
		RETURNING `+selectColumns, reminderID, user.OrgID, user.ActorID, messageID, chatID, note, input.RemindAt.UTC()), &result)
	if err != nil {
		return Reminder{}, false, fmt.Errorf("insert reminder: %w", err)
	}
	if err := s.schedule(ctx, tx, &result); err != nil {
		return Reminder{}, false, err
	}
	seq, err := insertEvent(ctx, tx, result, EventCreated, "")
	if err != nil {
		return Reminder{}, false, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Reminder{}, false, fmt.Errorf("commit set reminder: %w", err)
	}
	s.notify(user.OrgID, seq)
	return result, true, nil
}

// Update moves the person's reminder or changes its note by id: the way to
// reach a reminder whose message was deleted. Someone else's id is not found.
func (s *Service) Update(ctx context.Context, user identity.User, reminderID string, input SetInput) (Reminder, error) {
	if err := validID("reminder_id", reminderID); err != nil {
		return Reminder{}, err
	}
	if err := s.validate(input); err != nil {
		return Reminder{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Reminder{}, fmt.Errorf("begin update reminder: %w", err)
	}
	defer tx.Rollback(ctx)
	if err := serializeOwner(ctx, tx, user); err != nil {
		return Reminder{}, err
	}
	current, err := s.findOwn(ctx, tx, user, reminderID, false)
	if err != nil {
		return Reminder{}, err
	}
	if current.State != StatePending {
		if err := s.checkLimit(ctx, tx, user); err != nil {
			return Reminder{}, err
		}
	}
	if err := lockOrganization(ctx, tx, user.OrgID); err != nil {
		return Reminder{}, err
	}
	current, err = s.findOwn(ctx, tx, user, reminderID, true)
	if err != nil {
		return Reminder{}, err
	}
	// A reminder without a message lives only for its note.
	if current.MessageID == nil && input.Note != nil && *input.Note == "" {
		return Reminder{}, fmt.Errorf("%w: a reminder of a deleted message needs a note", ErrInvalid)
	}
	result, seq, err := s.move(ctx, tx, current, input)
	if err != nil {
		return Reminder{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Reminder{}, fmt.Errorf("commit update reminder: %w", err)
	}
	s.notify(user.OrgID, seq)
	return result, nil
}

// move changes a locked reminder: a new time makes it pending again, with a
// new fire job; the previous job is cancelled (and would do nothing anyway,
// its id no longer matches). Nothing changes when time and note are the same
// on a pending reminder.
func (s *Service) move(ctx context.Context, tx pgx.Tx, current Reminder, input SetInput) (Reminder, int64, error) {
	note := current.Note
	if input.Note != nil {
		note = *input.Note
	}
	remindAt := input.RemindAt.UTC()
	if current.State == StatePending && current.RemindAt.Equal(remindAt) && current.Note == note {
		return current, 0, nil
	}
	var result Reminder
	err := scan(tx.QueryRow(ctx, `
		UPDATE message_reminders r SET note = $2, remind_at = $3, state = 'pending', fired_at = NULL, fired_late = false,
			river_job_id = NULL, version = version + 1, updated_at = now()
		WHERE r.id = $1
		RETURNING `+selectColumns, current.ID, note, remindAt), &result)
	if err != nil {
		return Reminder{}, 0, fmt.Errorf("move reminder: %w", err)
	}
	if err := s.cancel(ctx, tx, current.riverJobID); err != nil {
		return Reminder{}, 0, err
	}
	if err := s.schedule(ctx, tx, &result); err != nil {
		return Reminder{}, 0, err
	}
	seq, err := insertEvent(ctx, tx, result, EventUpdated, "")
	if err != nil {
		return Reminder{}, 0, err
	}
	return result, seq, nil
}

// DeleteByMessage removes the person's reminder about a message: «Готово» or
// «Убрать». It needs no access to the chat, and the reply is the same
// whether a reminder existed or not.
func (s *Service) DeleteByMessage(ctx context.Context, user identity.User, messageID string) error {
	if err := validID("message_id", messageID); err != nil {
		return err
	}
	return s.remove(ctx, user, `message_id = $3`, messageID)
}

// Delete removes the person's reminder by id. Someone else's id, an unknown
// one and a repeat all succeed without touching anything.
func (s *Service) Delete(ctx context.Context, user identity.User, reminderID string) error {
	if _, err := uuid.Parse(reminderID); err != nil {
		// Not a reminder of the person, whatever it is.
		return nil
	}
	return s.remove(ctx, user, `id = $3`, reminderID)
}

func (s *Service) remove(ctx context.Context, user identity.User, where string, value string) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("begin delete reminder: %w", err)
	}
	defer tx.Rollback(ctx)
	// Look first without locking: a repeat or an unknown id touches nothing
	// shared — no organization lock, no event number.
	var exists bool
	if err := tx.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM message_reminders WHERE org_id = $1 AND actor_id = $2 AND `+where+`)`,
		user.OrgID, user.ActorID, value).Scan(&exists); err != nil {
		return fmt.Errorf("find reminder: %w", err)
	}
	if !exists {
		return nil
	}
	if err := serializeOwner(ctx, tx, user); err != nil {
		return err
	}
	if err := lockOrganization(ctx, tx, user.OrgID); err != nil {
		return err
	}
	var removed Reminder
	err = scan(tx.QueryRow(ctx, `
		DELETE FROM message_reminders r WHERE r.org_id = $1 AND r.actor_id = $2 AND r.`+where+`
		RETURNING `+selectColumns, user.OrgID, user.ActorID, value), &removed)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("delete reminder: %w", err)
	}
	if err := s.cancel(ctx, tx, removed.riverJobID); err != nil {
		return err
	}
	seq, err := insertEvent(ctx, tx, removed, EventDeleted, ReasonRemoved)
	if err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("commit delete reminder: %w", err)
	}
	s.notify(user.OrgID, seq)
	return nil
}

// List returns one page of the person's reminders: pending by remind_at,
// soonest first; fired by fired_at, latest first. Reminders whose message
// the person cannot read are listed too: the HTTP layer shows only the note.
func (s *Service) List(ctx context.Context, user identity.User, options ListOptions) (Page, error) {
	state := options.State
	if state == "" {
		state = StatePending
	}
	if state != StatePending && state != StateFired {
		return Page{}, fmt.Errorf("%w: state must be pending or fired", ErrInvalid)
	}
	limit := options.Limit
	if limit == 0 {
		limit = 50
	}
	if limit < 1 || limit > 100 {
		return Page{}, fmt.Errorf("%w: limit must be between 1 and 100", ErrInvalid)
	}
	var cursorAt *time.Time
	var cursorID *string
	if options.Cursor != nil {
		at, reminderID, err := decodeCursor(*options.Cursor)
		if err != nil {
			return Page{}, err
		}
		cursorAt, cursorID = &at, &reminderID
	}
	query := `SELECT ` + selectColumns + ` FROM message_reminders r
		WHERE r.org_id = $1 AND r.actor_id = $2 AND r.state = 'pending'
		  AND ($3::timestamptz IS NULL OR (r.remind_at, r.id) > ($3, $4::uuid))
		ORDER BY r.remind_at, r.id LIMIT $5`
	if state == StateFired {
		query = `SELECT ` + selectColumns + ` FROM message_reminders r
		WHERE r.org_id = $1 AND r.actor_id = $2 AND r.state = 'fired'
		  AND ($3::timestamptz IS NULL OR (r.fired_at, r.id) < ($3, $4::uuid))
		ORDER BY r.fired_at DESC, r.id DESC LIMIT $5`
	}
	rows, err := s.pool.Query(ctx, query, user.OrgID, user.ActorID, cursorAt, cursorID, limit+1)
	if err != nil {
		return Page{}, fmt.Errorf("list reminders: %w", err)
	}
	defer rows.Close()
	items := make([]Reminder, 0, limit)
	for rows.Next() {
		var item Reminder
		if err := scan(rows, &item); err != nil {
			return Page{}, fmt.Errorf("scan reminder: %w", err)
		}
		items = append(items, item)
	}
	if err := rows.Err(); err != nil {
		return Page{}, fmt.Errorf("iterate reminders: %w", err)
	}
	var next *string
	if len(items) > limit {
		items = items[:limit]
		last := items[len(items)-1]
		at := last.RemindAt
		if state == StateFired {
			at = *last.FiredAt
		}
		value := encodeCursor(at, last.ID)
		next = &value
	}
	return Page{Items: items, NextCursor: next}, nil
}

// IDs returns the person's reminders about messages of one chat: the bell in
// the feed. The chat must be readable, as for the feed itself.
func (s *Service) IDs(ctx context.Context, user identity.User, chatID string) ([]IDEntry, error) {
	if err := validID("chat_id", chatID); err != nil {
		return nil, err
	}
	var member bool
	if err := s.pool.QueryRow(ctx, `
		SELECT EXISTS (
			SELECT 1 FROM chats c
			JOIN chat_members cm ON cm.org_id = c.org_id AND cm.chat_id = c.id AND cm.actor_id = $3
			JOIN actors a ON a.org_id = cm.org_id AND a.id = cm.actor_id AND a.status = 'active' AND a.deleted_at IS NULL
			WHERE c.org_id = $1 AND c.id = $2 AND c.archived_at IS NULL
			  AND NOT EXISTS (SELECT 1 FROM agents agent WHERE agent.org_id = c.org_id AND agent.actor_id = $3
				AND c.id = ANY(agent.write_only_chat_ids)))`, user.OrgID, chatID, user.ActorID).Scan(&member); err != nil {
		return nil, fmt.Errorf("authorize reminder ids: %w", err)
	}
	if !member {
		return nil, ErrNotFound
	}
	rows, err := s.pool.Query(ctx, `
		SELECT r.message_id, r.remind_at, r.state FROM message_reminders r
		JOIN messages m ON m.org_id = r.org_id AND m.id = r.message_id AND m.deleted_at IS NULL
		WHERE r.org_id = $1 AND r.actor_id = $2 AND r.chat_id = $3 AND r.message_id IS NOT NULL
		ORDER BY r.remind_at, r.id`, user.OrgID, user.ActorID, chatID)
	if err != nil {
		return nil, fmt.Errorf("list reminder ids: %w", err)
	}
	defer rows.Close()
	result := make([]IDEntry, 0)
	for rows.Next() {
		var item IDEntry
		if err := rows.Scan(&item.MessageID, &item.RemindAt, &item.State); err != nil {
			return nil, fmt.Errorf("scan reminder id: %w", err)
		}
		result = append(result, item)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate reminder ids: %w", err)
	}
	return result, nil
}

func (s *Service) validate(input SetInput) error {
	now := s.now().UTC()
	if input.RemindAt.IsZero() || input.RemindAt.Before(now.Add(MinLead-leadTolerance)) {
		return fmt.Errorf("%w: remind_at must be at least 1 minute ahead", ErrInvalid)
	}
	if input.RemindAt.After(now.Add(MaxHorizon)) {
		return fmt.Errorf("%w: remind_at must be at most 365 days ahead", ErrInvalid)
	}
	if input.Note != nil {
		if !utf8.ValidString(*input.Note) || strings.ContainsRune(*input.Note, 0) {
			return fmt.Errorf("%w: note must be valid text", ErrInvalid)
		}
		if utf8.RuneCountInString(*input.Note) > MaxNote {
			return fmt.Errorf("%w: note must be at most 200 characters", ErrInvalid)
		}
	}
	return nil
}

// checkLimit counts all pending reminders of the person, hidden ones
// included: they still fire, with their note.
func (s *Service) checkLimit(ctx context.Context, tx pgx.Tx, user identity.User) error {
	var pending int
	if err := tx.QueryRow(ctx, `SELECT count(*) FROM message_reminders WHERE org_id = $1 AND actor_id = $2 AND state = 'pending'`,
		user.OrgID, user.ActorID).Scan(&pending); err != nil {
		return fmt.Errorf("count pending reminders: %w", err)
	}
	if pending >= s.pendingLimit {
		return ErrLimitReached
	}
	return nil
}

func (s *Service) findByMessage(ctx context.Context, tx pgx.Tx, user identity.User, messageID string, lock bool) (Reminder, bool, error) {
	query := `SELECT ` + selectColumns + ` FROM message_reminders r WHERE r.org_id = $1 AND r.actor_id = $2 AND r.message_id = $3`
	if lock {
		query += ` FOR UPDATE`
	}
	var item Reminder
	err := scan(tx.QueryRow(ctx, query, user.OrgID, user.ActorID, messageID), &item)
	if errors.Is(err, pgx.ErrNoRows) {
		return Reminder{}, false, nil
	}
	if err != nil {
		return Reminder{}, false, fmt.Errorf("find reminder: %w", err)
	}
	return item, true, nil
}

// findOwn finds a reminder only among the caller's own: anyone else's id
// reads as missing.
func (s *Service) findOwn(ctx context.Context, tx pgx.Tx, user identity.User, reminderID string, lock bool) (Reminder, error) {
	query := `SELECT ` + selectColumns + ` FROM message_reminders r WHERE r.org_id = $1 AND r.actor_id = $2 AND r.id = $3`
	if lock {
		query += ` FOR UPDATE`
	}
	var item Reminder
	err := scan(tx.QueryRow(ctx, query, user.OrgID, user.ActorID, reminderID), &item)
	if errors.Is(err, pgx.ErrNoRows) {
		return Reminder{}, ErrNotFound
	}
	if err != nil {
		return Reminder{}, fmt.Errorf("find reminder: %w", err)
	}
	return item, nil
}

func (s *Service) schedule(ctx context.Context, tx pgx.Tx, item *Reminder) error {
	if s.scheduler == nil {
		return nil
	}
	jobID, err := s.scheduler.ScheduleTx(ctx, tx, item.ID, item.RemindAt)
	if err != nil {
		return fmt.Errorf("schedule reminder: %w", err)
	}
	if _, err := tx.Exec(ctx, `UPDATE message_reminders SET river_job_id = $2 WHERE id = $1`, item.ID, jobID); err != nil {
		return fmt.Errorf("store reminder job: %w", err)
	}
	item.riverJobID = &jobID
	return nil
}

func (s *Service) cancel(ctx context.Context, tx pgx.Tx, jobID *int64) error {
	if s.scheduler == nil || jobID == nil {
		return nil
	}
	if err := s.scheduler.CancelTx(ctx, tx, *jobID); err != nil {
		return fmt.Errorf("cancel reminder job: %w", err)
	}
	return nil
}

func (s *Service) notify(orgID string, seq int64) {
	if s.afterCommit != nil && seq > 0 {
		s.afterCommit(orgID, seq)
	}
}

func lockOrganization(ctx context.Context, tx pgx.Tx, orgID string) error {
	var seq int64
	err := tx.QueryRow(ctx, `SELECT event_seq FROM organizations WHERE id = $1 FOR NO KEY UPDATE`, orgID).Scan(&seq)
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrNotFound
	}
	if err != nil {
		return fmt.Errorf("lock organization: %w", err)
	}
	return nil
}

// event is the data of reminder.created, .updated and .deleted. It carries
// no note and no text (packages/protocol ReminderEvent).
type event struct {
	ID        string    `json:"id"`
	MessageID *string   `json:"message_id"`
	ChatID    string    `json:"chat_id"`
	RemindAt  time.Time `json:"remind_at"`
	State     string    `json:"state"`
	Version   int       `json:"version"`
	Reason    string    `json:"reason,omitempty"`
}

// firedEvent is the data of reminder.fired (packages/protocol ReminderFiredEvent).
type firedEvent struct {
	ID        string    `json:"id"`
	MessageID *string   `json:"message_id"`
	ChatID    string    `json:"chat_id"`
	FiredAt   time.Time `json:"fired_at"`
	Late      bool      `json:"late"`
	Version   int       `json:"version"`
}

// insertEvent writes an event only the owner receives: no chat_id, so
// neither chat feeds nor agent triggers see it. The organization row must be
// locked by the caller. reminder.fired also queues its push in the same
// transaction.
func insertEvent(ctx context.Context, tx pgx.Tx, item Reminder, eventType, reason string) (int64, error) {
	var data any = event{
		ID: item.ID, MessageID: item.MessageID, ChatID: item.ChatID, RemindAt: item.RemindAt.UTC(),
		State: item.State, Version: item.Version, Reason: reason,
	}
	if eventType == EventFired {
		data = firedEvent{ID: item.ID, MessageID: item.MessageID, ChatID: item.ChatID, FiredAt: item.FiredAt.UTC(), Late: item.Late, Version: item.Version}
	}
	payload, err := json.Marshal(data)
	if err != nil {
		return 0, fmt.Errorf("marshal reminder event: %w", err)
	}
	var seq int64
	if err := tx.QueryRow(ctx, `UPDATE organizations SET event_seq = event_seq + 1 WHERE id = $1 RETURNING event_seq`, item.orgID).Scan(&seq); err != nil {
		return 0, fmt.Errorf("allocate event sequence: %w", err)
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO events (org_id, seq, type, actor_id, chat_id, subject_id, audience_actor_id, data)
		VALUES ($1, $2, $3, $4, NULL, $5, $4, $6::jsonb)`, item.orgID, seq, eventType, item.actorID, item.ID, string(payload)); err != nil {
		return 0, fmt.Errorf("insert reminder event: %w", err)
	}
	if eventType == EventFired {
		if _, err := tx.Exec(ctx, `INSERT INTO notification_jobs (org_id, event_seq) VALUES ($1, $2) ON CONFLICT DO NOTHING`, item.orgID, seq); err != nil {
			return 0, fmt.Errorf("queue reminder push: %w", err)
		}
	}
	return seq, nil
}

// The cursor holds only the person's own time and reminder id.
func encodeCursor(at time.Time, reminderID string) string {
	raw := strconv.FormatInt(at.UnixMicro(), 10) + "." + reminderID
	return base64.RawURLEncoding.EncodeToString([]byte(raw))
}

func decodeCursor(value string) (time.Time, string, error) {
	raw, err := base64.RawURLEncoding.DecodeString(value)
	if err != nil {
		return time.Time{}, "", fmt.Errorf("%w: cursor is malformed", ErrInvalid)
	}
	micros, reminderID, ok := strings.Cut(string(raw), ".")
	value64, parseErr := strconv.ParseInt(micros, 10, 64)
	if !ok || parseErr != nil || validID("cursor", reminderID) != nil {
		return time.Time{}, "", fmt.Errorf("%w: cursor is malformed", ErrInvalid)
	}
	at := time.UnixMicro(value64).UTC()
	if at.Year() < 2000 || at.Year() > 3000 {
		return time.Time{}, "", fmt.Errorf("%w: cursor is malformed", ErrInvalid)
	}
	return at, reminderID, nil
}

func validID(name, value string) error {
	if _, err := uuid.Parse(value); err != nil {
		return fmt.Errorf("%w: %s must be a UUID", ErrInvalid, name)
	}
	return nil
}
