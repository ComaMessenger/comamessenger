// Package away keeps «Отсутствую» (phase 6.7 wave 4, package A): a person's
// away status — vacation, appointment, trip, do not disturb or their own
// label — with an end date, an optional auto-reply in direct chats, an
// optional substitute and an optional «no notifications».
//
// Security model:
//   - Only the person sets, changes or removes their own status. Every write
//     filters by the caller's organization and actor id; there is no way to
//     address someone else's record, an administrator's call included.
//     Agents are refused (ErrForbidden).
//   - The auto-reply text, mute_push and the substitute as saved are read
//     only by the owner (Get). Everyone else reads AwayPublic through
//     package awayview (actor_away_public), and every event of this package
//     carries only AwayPublic or ids and dates: the event log is long-lived
//     and replayed to every device of the workspace.
//   - The auto-reply is the owner's own message in a direct chat, created by
//     the River job away.autoreply after every condition is checked again
//     under the locks: a person who writes to the owner sees the text only
//     as that message, once per period.
//
// Lock order. Set and Clear take a transaction advisory lock of the owner,
// then the organization row, then the actor_away row. The minute sweep and
// the auto-reply job take the organization row, then the actor_away row.
// Message writes take the organization row first as well, so they all
// serialize on it and never wait in the opposite order.
package away

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/comamessenger/comamessenger/core/internal/awayview"
	"github.com/comamessenger/comamessenger/core/internal/id"
	"github.com/comamessenger/comamessenger/core/internal/identity"
	"github.com/comamessenger/comamessenger/core/internal/message"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

var (
	ErrForbidden         = errors.New("away status is for people only")
	ErrVersionConflict   = errors.New("away status version conflict")
	ErrSubstituteInvalid = errors.New("invalid substitute")
)

// InvalidError is 422 away_invalid with details.field.
type InvalidError struct {
	Field  string
	Reason string
}

func (e *InvalidError) Error() string { return e.Field + ": " + e.Reason }

func invalid(field, reason string) error { return &InvalidError{Field: field, Reason: reason} }

const (
	KindVacation    = "vacation"
	KindAppointment = "appointment"
	KindTrip        = "trip"
	KindDND         = "dnd"
	KindOther       = "other"

	EventUpdated            = "actor.away.updated"
	EventSubstituteAssigned = "away.substitute.assigned"
	EventSubstituteRemoved  = "away.substitute.removed"

	// MaxLabel and MaxAutoreply are lengths in characters.
	MaxLabel     = 40
	MaxAutoreply = 500
	// MaxLead bounds how far ahead a status may start, MaxLength how long
	// it may last.
	MaxLead   = 365 * 24 * time.Hour
	MaxLength = 180 * 24 * time.Hour
	// DailyAutoreplyLimit bounds the auto-replies of one person in 24 hours.
	DailyAutoreplyLimit = 200
)

// Autoreply is AwayAutoreply.
type Autoreply struct {
	Enabled bool   `json:"enabled"`
	Text    string `json:"text"`
}

// Status is AwayStatus: the record as its owner sees it.
type Status struct {
	Kind             string    `json:"kind"`
	Label            string    `json:"label"`
	StartsAt         time.Time `json:"starts_at"`
	EndsAt           time.Time `json:"ends_at"`
	Active           bool      `json:"active"`
	SubstituteID     *string   `json:"substitute_id"`
	NotificationsOff bool      `json:"notifications_off"`
	Autoreply        Autoreply `json:"autoreply"`
	MutePush         bool      `json:"mute_push"`
	Version          int       `json:"version"`

	id string
}

// AutoreplyInput is AwayAutoreply in a request; both fields are required.
type AutoreplyInput struct {
	Enabled *bool   `json:"enabled"`
	Text    *string `json:"text"`
}

// SetInput is SetAwayRequest.
type SetInput struct {
	Kind            string          `json:"kind"`
	Label           *string         `json:"label"`
	StartsAt        *time.Time      `json:"starts_at"`
	EndsAt          *time.Time      `json:"ends_at"`
	Autoreply       *AutoreplyInput `json:"autoreply"`
	SubstituteID    *string         `json:"substitute_id"`
	MutePush        *bool           `json:"mute_push"`
	ExpectedVersion *int            `json:"expected_version"`
}

// SubstitutingEntry is one person the caller substitutes.
type SubstitutingEntry struct {
	ActorID string          `json:"actor_id"`
	Away    awayview.Public `json:"away"`
}

// SubstitutingList is the reply of listSubstituting.
type SubstitutingList struct {
	Items []SubstitutingEntry `json:"items"`
}

// Scheduler places the auto-reply job inside the transaction of the
// incoming message, so a rollback never leaves a stray job behind.
type Scheduler interface {
	ScheduleAutoreplyTx(ctx context.Context, tx pgx.Tx, args AutoreplyArgs) error
}

type Service struct {
	pool        *pgxpool.Pool
	messages    *message.Service
	scheduler   Scheduler
	afterCommit func(orgID string, highWatermark int64)
	logger      *slog.Logger
}

func NewService(pool *pgxpool.Pool, messages *message.Service, afterCommit func(string, int64), logger *slog.Logger) *Service {
	if logger == nil {
		logger = slog.Default()
	}
	return &Service{pool: pool, messages: messages, afterCommit: afterCommit, logger: logger}
}

func (s *Service) SetScheduler(scheduler Scheduler) { s.scheduler = scheduler }

const selectColumns = `aw.id, aw.kind, aw.label, aw.starts_at, aw.ends_at, aw.substitute_id, aw.mute_push,
	aw.autoreply_enabled, aw.autoreply_text, aw.version`

func scan(row pgx.Row, item *Status) error {
	return row.Scan(&item.id, &item.Kind, &item.Label, &item.StartsAt, &item.EndsAt, &item.SubstituteID, &item.MutePush,
		&item.Autoreply.Enabled, &item.Autoreply.Text, &item.Version)
}

func (item *Status) finish(now time.Time) {
	item.Active = !item.StartsAt.After(now) && item.EndsAt.After(now)
	item.NotificationsOff = item.MutePush
	item.StartsAt, item.EndsAt = item.StartsAt.UTC(), item.EndsAt.UTC()
}

// Get returns the person's own status, current or planned, with the private
// settings; ok is false without one (an ended record the sweep has not
// removed yet counts as none).
func (s *Service) Get(ctx context.Context, user identity.User) (Status, bool, error) {
	var item Status
	var now time.Time
	err := s.pool.QueryRow(ctx, `
		SELECT `+selectColumns+`, now() FROM actor_away aw
		WHERE aw.org_id = $1 AND aw.actor_id = $2 AND aw.ends_at > now()`, user.OrgID, user.ActorID).
		Scan(&item.id, &item.Kind, &item.Label, &item.StartsAt, &item.EndsAt, &item.SubstituteID, &item.MutePush,
			&item.Autoreply.Enabled, &item.Autoreply.Text, &item.Version, &now)
	if errors.Is(err, pgx.ErrNoRows) {
		return Status{}, false, nil
	}
	if err != nil {
		return Status{}, false, fmt.Errorf("get away status: %w", err)
	}
	item.finish(now)
	return item, true, nil
}

// plan is a validated SetInput.
type plan struct {
	kind, label      string
	startsAt, endsAt *time.Time
	autoreply        Autoreply
	substituteID     *string
	mutePush         bool
	expectedVersion  *int
}

func validate(input SetInput) (plan, error) {
	result := plan{kind: input.Kind, expectedVersion: input.ExpectedVersion}
	switch input.Kind {
	case KindVacation, KindAppointment, KindTrip, KindDND, KindOther:
	default:
		return plan{}, invalid("kind", "must be vacation, appointment, trip, dnd or other")
	}
	if input.Label != nil {
		result.label = strings.TrimSpace(*input.Label)
	}
	if input.Kind == KindOther {
		if length := utf8.RuneCountInString(result.label); length < 1 || length > MaxLabel {
			return plan{}, invalid("label", "other needs a label of 1–40 characters")
		}
	} else if result.label != "" {
		return plan{}, invalid("label", "only other has a label")
	}
	if input.EndsAt == nil {
		return plan{}, invalid("ends_at", "is required")
	}
	endsAt := input.EndsAt.UTC().Truncate(time.Microsecond)
	result.endsAt = &endsAt
	if input.StartsAt != nil {
		startsAt := input.StartsAt.UTC().Truncate(time.Microsecond)
		result.startsAt = &startsAt
	}
	if input.Autoreply == nil || input.Autoreply.Enabled == nil || input.Autoreply.Text == nil {
		return plan{}, invalid("autoreply", "enabled and text are required")
	}
	result.autoreply = Autoreply{Enabled: *input.Autoreply.Enabled, Text: strings.TrimSpace(*input.Autoreply.Text)}
	if utf8.RuneCountInString(result.autoreply.Text) > MaxAutoreply {
		return plan{}, invalid("autoreply.text", "must contain at most 500 characters")
	}
	if result.autoreply.Enabled && result.autoreply.Text == "" {
		return plan{}, invalid("autoreply.text", "an enabled auto-reply needs a text")
	}
	if input.MutePush == nil {
		return plan{}, invalid("mute_push", "is required")
	}
	result.mutePush = *input.MutePush
	if input.SubstituteID != nil {
		if _, err := uuid.Parse(*input.SubstituteID); err != nil {
			return plan{}, ErrSubstituteInvalid
		}
		substitute := strings.ToLower(*input.SubstituteID)
		result.substituteID = &substitute
	}
	if input.ExpectedVersion != nil && *input.ExpectedVersion < 1 {
		return plan{}, invalid("expected_version", "must be positive")
	}
	return result, nil
}

func serializeOwner(ctx context.Context, tx pgx.Tx, user identity.User) error {
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended('actor_away:' || $1::text, 0))`, user.ActorID); err != nil {
		return fmt.Errorf("serialize away status: %w", err)
	}
	return nil
}

// requirePerson refuses agents and anyone not active: the status speaks
// for a person (decision 11).
func requirePerson(ctx context.Context, tx pgx.Tx, user identity.User) error {
	var person bool
	err := tx.QueryRow(ctx, `SELECT type = 'user' AND status = 'active' AND deleted_at IS NULL FROM actors WHERE org_id = $1 AND id = $2`,
		user.OrgID, user.ActorID).Scan(&person)
	if errors.Is(err, pgx.ErrNoRows) || (err == nil && !person) {
		return ErrForbidden
	}
	if err != nil {
		return fmt.Errorf("check away owner: %w", err)
	}
	return nil
}

func lockOrganization(ctx context.Context, tx pgx.Tx, orgID string) error {
	var seq int64
	err := tx.QueryRow(ctx, `SELECT event_seq FROM organizations WHERE id = $1 FOR NO KEY UPDATE`, orgID).Scan(&seq)
	if err != nil {
		return fmt.Errorf("lock organization: %w", err)
	}
	return nil
}

func loadOwn(ctx context.Context, tx pgx.Tx, user identity.User) (Status, bool, error) {
	var item Status
	err := scan(tx.QueryRow(ctx, `SELECT `+selectColumns+` FROM actor_away aw WHERE aw.org_id = $1 AND aw.actor_id = $2 FOR UPDATE`,
		user.OrgID, user.ActorID), &item)
	if errors.Is(err, pgx.ErrNoRows) {
		return Status{}, false, nil
	}
	if err != nil {
		return Status{}, false, fmt.Errorf("load away status: %w", err)
	}
	return item, true, nil
}

// Set replaces the person's status. starts_at absent or in the past means
// now; a status that is already running keeps its start then, so editing
// the text of a running vacation does not restart its auto-replies. When
// the dates change the period gets a new id and the auto-reply marks start
// over; editing anything else keeps who already got one.
func (s *Service) Set(ctx context.Context, user identity.User, input SetInput) (Status, error) {
	planned, err := validate(input)
	if err != nil {
		return Status{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Status{}, fmt.Errorf("begin set away: %w", err)
	}
	defer tx.Rollback(ctx)
	if err := serializeOwner(ctx, tx, user); err != nil {
		return Status{}, err
	}
	if err := requirePerson(ctx, tx, user); err != nil {
		return Status{}, err
	}
	if err := lockOrganization(ctx, tx, user.OrgID); err != nil {
		return Status{}, err
	}
	current, exists, err := loadOwn(ctx, tx, user)
	if err != nil {
		return Status{}, err
	}
	if planned.expectedVersion != nil && (!exists || current.Version != *planned.expectedVersion) {
		return Status{}, ErrVersionConflict
	}
	// The database clock, the one every read compares with: a status set
	// to start now is active for the very next read.
	var now time.Time
	if err := tx.QueryRow(ctx, `SELECT now()`).Scan(&now); err != nil {
		return Status{}, fmt.Errorf("read the clock: %w", err)
	}
	now = now.UTC()
	running := exists && !current.StartsAt.After(now) && current.EndsAt.After(now)
	startsAt := now
	switch {
	case planned.startsAt != nil && planned.startsAt.After(now):
		startsAt = *planned.startsAt
	case running:
		startsAt = current.StartsAt.UTC()
	}
	endsAt := *planned.endsAt
	if startsAt.After(now.Add(MaxLead)) {
		return Status{}, invalid("starts_at", "must be at most 365 days ahead")
	}
	if !endsAt.After(startsAt) || !endsAt.After(now) {
		return Status{}, invalid("ends_at", "must be later than starts_at and now")
	}
	if endsAt.Sub(startsAt) > MaxLength {
		return Status{}, invalid("ends_at", "must be at most 180 days after starts_at")
	}
	if planned.substituteID != nil {
		if err := checkSubstitute(ctx, tx, user, *planned.substituteID); err != nil {
			return Status{}, err
		}
	}
	sameDates := exists && current.StartsAt.Equal(startsAt) && current.EndsAt.Equal(endsAt)
	var result Status
	if sameDates {
		err = scan(tx.QueryRow(ctx, `
			UPDATE actor_away aw SET kind = $2, label = $3, autoreply_enabled = $4, autoreply_text = $5, substitute_id = $6,
				mute_push = $7, version = version + 1, updated_at = now()
			WHERE aw.id = $1 RETURNING `+selectColumns,
			current.id, planned.kind, planned.label, planned.autoreply.Enabled, planned.autoreply.Text, planned.substituteID, planned.mutePush), &result)
		if err != nil {
			return Status{}, fmt.Errorf("update away status: %w", err)
		}
	} else {
		version := 1
		if exists {
			version = current.Version + 1
			// The old period goes with its auto-reply marks (cascade).
			if _, err := tx.Exec(ctx, `DELETE FROM actor_away WHERE id = $1`, current.id); err != nil {
				return Status{}, fmt.Errorf("replace away status: %w", err)
			}
		}
		awayID, err := id.New()
		if err != nil {
			return Status{}, fmt.Errorf("generate away id: %w", err)
		}
		var startedEventAt *time.Time
		if !startsAt.After(now) {
			startedEventAt = &now
		}
		err = scan(tx.QueryRow(ctx, `
			INSERT INTO actor_away AS aw (id, org_id, actor_id, kind, label, starts_at, ends_at, autoreply_enabled, autoreply_text,
				substitute_id, mute_push, started_event_at, version)
			VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
			RETURNING `+selectColumns,
			awayID, user.OrgID, user.ActorID, planned.kind, planned.label, startsAt, endsAt, planned.autoreply.Enabled, planned.autoreply.Text,
			planned.substituteID, planned.mutePush, startedEventAt, version), &result)
		if err != nil {
			return Status{}, fmt.Errorf("insert away status: %w", err)
		}
	}
	high, err := writeUpdated(ctx, tx, user.OrgID, user.ActorID, now)
	if err != nil {
		return Status{}, err
	}
	var previous *string
	if exists {
		previous = current.SubstituteID
	}
	if previous != nil && (result.SubstituteID == nil || *previous != *result.SubstituteID) {
		if high, err = writeSubstituteRemoved(ctx, tx, user.OrgID, user.ActorID, *previous); err != nil {
			return Status{}, err
		}
	}
	if result.SubstituteID != nil && (previous == nil || *previous != *result.SubstituteID || !sameDates) {
		if high, err = writeSubstituteAssigned(ctx, tx, user.OrgID, user.ActorID, *result.SubstituteID, result.StartsAt, result.EndsAt); err != nil {
			return Status{}, err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return Status{}, fmt.Errorf("commit set away: %w", err)
	}
	s.notify(user.OrgID, high)
	result.finish(now)
	return result, nil
}

// checkSubstitute: an active person of the workspace, not the owner. A
// substitute who is away now may be named (the vacation may come later);
// readers hide them while they are away.
func checkSubstitute(ctx context.Context, tx pgx.Tx, user identity.User, substituteID string) error {
	if substituteID == user.ActorID {
		return ErrSubstituteInvalid
	}
	var ok bool
	err := tx.QueryRow(ctx, `SELECT type = 'user' AND status = 'active' AND deleted_at IS NULL FROM actors WHERE org_id = $1 AND id = $2`,
		user.OrgID, substituteID).Scan(&ok)
	if errors.Is(err, pgx.ErrNoRows) || (err == nil && !ok) {
		return ErrSubstituteInvalid
	}
	if err != nil {
		return fmt.Errorf("check substitute: %w", err)
	}
	return nil
}

// Clear removes the person's status, current or planned. A repeat, or no
// status at all, changes nothing and writes no event.
func (s *Service) Clear(ctx context.Context, user identity.User) error {
	var exists bool
	if err := s.pool.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM actor_away WHERE org_id = $1 AND actor_id = $2)`,
		user.OrgID, user.ActorID).Scan(&exists); err != nil {
		return fmt.Errorf("find away status: %w", err)
	}
	if !exists {
		return nil
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("begin clear away: %w", err)
	}
	defer tx.Rollback(ctx)
	if err := serializeOwner(ctx, tx, user); err != nil {
		return err
	}
	if err := lockOrganization(ctx, tx, user.OrgID); err != nil {
		return err
	}
	var substituteID *string
	err = tx.QueryRow(ctx, `DELETE FROM actor_away WHERE org_id = $1 AND actor_id = $2 RETURNING substitute_id`,
		user.OrgID, user.ActorID).Scan(&substituteID)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("clear away status: %w", err)
	}
	high, err := writeCleared(ctx, tx, user.OrgID, user.ActorID, substituteID)
	if err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("commit clear away: %w", err)
	}
	s.notify(user.OrgID, high)
	return nil
}

// Substituting lists the active people whose current or planned status
// names the caller as substitute, earliest start first.
func (s *Service) Substituting(ctx context.Context, user identity.User) (SubstitutingList, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT aw.actor_id, actor_away_public(aw.org_id, aw.actor_id, now())
		FROM actor_away aw
		JOIN actors a ON a.org_id = aw.org_id AND a.id = aw.actor_id AND a.status = 'active' AND a.deleted_at IS NULL
		WHERE aw.org_id = $1 AND aw.substitute_id = $2 AND aw.ends_at > now()
		ORDER BY aw.starts_at, aw.actor_id`, user.OrgID, user.ActorID)
	if err != nil {
		return SubstitutingList{}, fmt.Errorf("list substituting: %w", err)
	}
	defer rows.Close()
	result := SubstitutingList{Items: []SubstitutingEntry{}}
	for rows.Next() {
		var entry SubstitutingEntry
		var public *awayview.Public
		if err := rows.Scan(&entry.ActorID, &public); err != nil {
			return SubstitutingList{}, fmt.Errorf("scan substituting: %w", err)
		}
		if public == nil {
			continue
		}
		entry.Away = *public
		result.Items = append(result.Items, entry)
	}
	return result, rows.Err()
}

func (s *Service) notify(orgID string, seq int64) {
	if s.afterCommit != nil && seq > 0 {
		s.afterCommit(orgID, seq)
	}
}

// --- events ---

type updatedEvent struct {
	ActorID string           `json:"actor_id"`
	Away    *awayview.Public `json:"away"`
}

type assignedEvent struct {
	ActorID  string    `json:"actor_id"`
	StartsAt time.Time `json:"starts_at"`
	EndsAt   time.Time `json:"ends_at"`
}

type removedEvent struct {
	ActorID string `json:"actor_id"`
}

// writeUpdated writes actor.away.updated for the whole workspace with the
// person's AwayPublic as of at (null without a status).
func writeUpdated(ctx context.Context, tx pgx.Tx, orgID, actorID string, at time.Time) (int64, error) {
	var public *awayview.Public
	if err := tx.QueryRow(ctx, `SELECT actor_away_public($1, $2, $3)`, orgID, actorID, at).Scan(&public); err != nil {
		return 0, fmt.Errorf("read away public: %w", err)
	}
	if public != nil {
		public.StartsAt, public.EndsAt = public.StartsAt.UTC(), public.EndsAt.UTC()
	}
	return insertEvent(ctx, tx, orgID, EventUpdated, actorID, nil, updatedEvent{ActorID: actorID, Away: public}, false)
}

func writeCleared(ctx context.Context, tx pgx.Tx, orgID, actorID string, substituteID *string) (int64, error) {
	high, err := insertEvent(ctx, tx, orgID, EventUpdated, actorID, nil, updatedEvent{ActorID: actorID}, false)
	if err != nil {
		return 0, err
	}
	if substituteID != nil {
		return writeSubstituteRemoved(ctx, tx, orgID, actorID, *substituteID)
	}
	return high, nil
}

func writeSubstituteAssigned(ctx context.Context, tx pgx.Tx, orgID, actorID, substituteID string, startsAt, endsAt time.Time) (int64, error) {
	return insertEvent(ctx, tx, orgID, EventSubstituteAssigned, actorID, &substituteID,
		assignedEvent{ActorID: actorID, StartsAt: startsAt.UTC(), EndsAt: endsAt.UTC()}, true)
}

func writeSubstituteRemoved(ctx context.Context, tx pgx.Tx, orgID, actorID, substituteID string) (int64, error) {
	return insertEvent(ctx, tx, orgID, EventSubstituteRemoved, actorID, &substituteID, removedEvent{ActorID: actorID}, false)
}

// insertEvent writes one event of the away person (actor_id and subject_id),
// for the whole workspace or, with audience, for one person only. No chat:
// chat feeds and agent triggers never see these events.
func insertEvent(ctx context.Context, tx pgx.Tx, orgID, eventType, actorID string, audience *string, data any, push bool) (int64, error) {
	payload, err := json.Marshal(data)
	if err != nil {
		return 0, fmt.Errorf("marshal away event: %w", err)
	}
	var seq int64
	if err := tx.QueryRow(ctx, `UPDATE organizations SET event_seq = event_seq + 1 WHERE id = $1 RETURNING event_seq`, orgID).Scan(&seq); err != nil {
		return 0, fmt.Errorf("allocate away event sequence: %w", err)
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO events (org_id, seq, type, actor_id, chat_id, subject_id, audience_actor_id, data)
		VALUES ($1, $2, $3, $4, NULL, $4, $5, $6::jsonb)`, orgID, seq, eventType, actorID, audience, string(payload)); err != nil {
		return 0, fmt.Errorf("insert away event: %w", err)
	}
	if push {
		if _, err := tx.Exec(ctx, `INSERT INTO notification_jobs (org_id, event_seq) VALUES ($1, $2) ON CONFLICT DO NOTHING`, orgID, seq); err != nil {
			return 0, fmt.Errorf("queue away push: %w", err)
		}
	}
	return seq, nil
}
