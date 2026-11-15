// Package request implements requests («Запрос», phase 6.4 wave 1): a
// message of type request asks some members of a chat for an answer.
//
// Privacy is the point of the design. A request message is shared like any
// message, and so is its Summary (status, answer type, due date, «N из M»).
// Who is asked and who answered what are kept in message_request_recipients
// and leave the server only through Viewer (the reader's own answer, and the
// tally for those who may see it) and listRequestAnswers, both computed for
// one reader on every call: the author or a current chat admin, while they
// are in the chat. Chat-wide realtime events carry counters only; tallies go
// to the author alone and an answer to the person who gave it.
//
// The package sits below message: message.Service creates request messages
// through the ordinary send path and calls OnMessageDeletedTx when a message
// is deleted, so this package never imports message.
package request

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"sort"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"
)

var (
	ErrInvalid             = errors.New("request input is invalid")
	ErrAudienceEmpty       = errors.New("request audience is empty")
	ErrTooManyRecipients   = errors.New("request has too many recipients")
	ErrAudienceUnavailable = errors.New("request audience is not available yet")
	ErrNotFound            = errors.New("request not found")
	ErrForbidden           = errors.New("request action forbidden")
	ErrNotMember           = errors.New("not a member of the request chat")
	ErrClosed              = errors.New("request is closed")
	ErrChangeTooLate       = errors.New("request answer can no longer be changed")
	ErrChatArchived        = errors.New("request chat is archived")
	ErrLimitReached        = errors.New("request limit reached")
	ErrRemindTooSoon       = errors.New("request reminder too soon")
	ErrVersionConflict     = errors.New("request answer version conflict")
	ErrUnavailable         = errors.New("requests are not configured")
)

// InvalidError names the field that failed validation (details.field).
type InvalidError struct {
	Field   string
	Message string
}

func (e *InvalidError) Error() string     { return e.Message }
func (e *InvalidError) Is(err error) bool { return err == ErrInvalid }

func invalid(field, format string, args ...any) error {
	return &InvalidError{Field: field, Message: fmt.Sprintf(format, args...)}
}

// RemindTooSoonError carries when the author may remind again.
type RemindTooSoonError struct{ RetryAfter time.Duration }

func (e *RemindTooSoonError) Error() string     { return ErrRemindTooSoon.Error() }
func (e *RemindTooSoonError) Is(err error) bool { return err == ErrRemindTooSoon }

// Answer presets. Ready-made ones are keys translated by clients.
const (
	PresetAck    = "ack"
	PresetYesNo  = "yes_no"
	PresetAttend = "attend"
	PresetDone   = "done"
	PresetCustom = "custom"
)

var presetOptions = map[string]int{PresetAck: 1, PresetYesNo: 2, PresetAttend: 2, PresetDone: 1}

// OptionCount is how many buttons a request of this preset has.
func OptionCount(preset string, custom int) int {
	if preset == PresetCustom {
		return custom
	}
	return presetOptions[preset]
}

// Limits of requests. The zero value of a field means its default.
type Limits struct {
	MaxRecipients        int
	OpenPerAuthor        int
	OpenPerChat          int
	ManualRemindInterval time.Duration
	ManualRemindMax      int
	// DailyRemindersPerPerson caps request reminders one person gets from
	// all requests in 24 hours; the rest are counted but not sent.
	DailyRemindersPerPerson int
	// AutoRemindMaxLateness: an automatic reminder later than this is
	// skipped (the server was down).
	AutoRemindMaxLateness time.Duration
	// ExpireAfterDue closes a request with a due date this long after it;
	// ExpireIdle closes one without a due date this long after the last
	// answer or creation.
	ExpireAfterDue time.Duration
	ExpireIdle     time.Duration
}

func DefaultLimits() Limits {
	return Limits{
		MaxRecipients: 500, OpenPerAuthor: 200, OpenPerChat: 100,
		ManualRemindInterval: 2 * time.Hour, ManualRemindMax: 5, DailyRemindersPerPerson: 10,
		AutoRemindMaxLateness: 2 * time.Hour,
		ExpireAfterDue:        14 * 24 * time.Hour, ExpireIdle: 30 * 24 * time.Hour,
	}
}

// Bounds of the input.
const (
	MinDueAhead        = 10 * time.Minute
	MaxDueAhead        = 90 * 24 * time.Hour
	MinAutoRemindAhead = time.Hour
	MaxCommentRunes    = 280
	MaxOptionRunes     = 32
	MaxLabelRunes      = 60
)

// AnswerSpec is the answer type: a preset, and 2–4 options for custom.
type AnswerSpec struct {
	Preset  string   `json:"preset"`
	Options []string `json:"options,omitempty"`
}

// AudienceInput says whom to ask, before it is turned into people.
type AudienceInput struct {
	Kind         string   `json:"kind"`
	ActorIDs     []string `json:"actor_ids,omitempty"`
	DepartmentID *string  `json:"department_id,omitempty"`
	PositionID   *string  `json:"position_id,omitempty"`
}

// CreateSpec is the request part of createRequest.
type CreateSpec struct {
	Audience     AudienceInput
	Answer       AnswerSpec
	AllowComment *bool
	DueAt        *time.Time
	AutoRemind   bool
}

// Plan is a validated CreateSpec with the times derived from it.
type Plan struct {
	AudienceKind string
	ActorIDs     []string
	// DepartmentID and PositionID: the addressed group of the department
	// and position kinds, in canonical form; empty otherwise.
	DepartmentID string
	PositionID   string
	Answer       AnswerSpec
	AllowComment bool
	DueAt        *time.Time
	AutoRemindAt *time.Time
}

// Normalize validates spec against now without touching the database.
func Normalize(spec CreateSpec, now time.Time) (Plan, error) {
	plan := Plan{AudienceKind: spec.Audience.Kind, AllowComment: true}
	if spec.AllowComment != nil {
		plan.AllowComment = *spec.AllowComment
	}
	switch spec.Audience.Kind {
	case "department", "position":
		if err := normalizeGroupAudience(spec.Audience, &plan); err != nil {
			return Plan{}, err
		}
	case "chat":
		if len(spec.Audience.ActorIDs) > 0 || spec.Audience.DepartmentID != nil || spec.Audience.PositionID != nil {
			return Plan{}, invalid("audience", "audience chat takes no actor_ids")
		}
	case "people":
		if spec.Audience.DepartmentID != nil || spec.Audience.PositionID != nil {
			return Plan{}, invalid("audience", "audience people takes only actor_ids")
		}
		if len(spec.Audience.ActorIDs) == 0 {
			return Plan{}, invalid("audience.actor_ids", "audience people needs actor_ids")
		}
		if len(spec.Audience.ActorIDs) > DefaultLimits().MaxRecipients {
			return Plan{}, ErrTooManyRecipients
		}
		seen := make(map[string]struct{}, len(spec.Audience.ActorIDs))
		for _, actorID := range spec.Audience.ActorIDs {
			parsed, err := uuid.Parse(actorID)
			if err != nil {
				return Plan{}, invalid("audience.actor_ids", "actor_ids must contain UUIDs")
			}
			value := parsed.String()
			if _, ok := seen[value]; ok {
				return Plan{}, invalid("audience.actor_ids", "actor_ids must be unique")
			}
			seen[value] = struct{}{}
			plan.ActorIDs = append(plan.ActorIDs, value)
		}
		sort.Strings(plan.ActorIDs)
	default:
		return Plan{}, invalid("audience.kind", "audience kind must be people, chat, department or position")
	}

	plan.Answer.Preset = spec.Answer.Preset
	switch spec.Answer.Preset {
	case PresetAck, PresetYesNo, PresetAttend, PresetDone:
		if len(spec.Answer.Options) > 0 {
			return Plan{}, invalid("answer.options", "options are only for custom answers")
		}
	case PresetCustom:
		if len(spec.Answer.Options) < 2 || len(spec.Answer.Options) > 4 {
			return Plan{}, invalid("answer.options", "custom answers need 2 to 4 options")
		}
		seen := make(map[string]struct{}, len(spec.Answer.Options))
		for _, option := range spec.Answer.Options {
			option = strings.TrimSpace(option)
			length := utf8.RuneCountInString(option)
			if length < 1 || length > MaxOptionRunes || !utf8.ValidString(option) {
				return Plan{}, invalid("answer.options", "each option must be 1 to %d characters", MaxOptionRunes)
			}
			key := strings.ToLower(option)
			if _, ok := seen[key]; ok {
				return Plan{}, invalid("answer.options", "options must not repeat")
			}
			seen[key] = struct{}{}
			plan.Answer.Options = append(plan.Answer.Options, option)
		}
	default:
		return Plan{}, invalid("answer.preset", "unknown answer preset")
	}

	if spec.DueAt != nil {
		due := spec.DueAt.UTC().Truncate(time.Microsecond)
		if due.Before(now.Add(MinDueAhead)) || due.After(now.Add(MaxDueAhead)) {
			return Plan{}, invalid("due_at", "due_at must be between 10 minutes and 90 days ahead")
		}
		plan.DueAt = &due
	}
	if spec.AutoRemind {
		if plan.DueAt == nil || plan.DueAt.Before(now.Add(MinAutoRemindAhead)) {
			return Plan{}, invalid("auto_remind", "an automatic reminder needs a due date at least 1 hour ahead")
		}
		at := AutoRemindAt(now, *plan.DueAt)
		plan.AutoRemindAt = &at
	}
	return plan, nil
}

// AutoRemindAt is max(due − 24 h, created + (due − created) / 2): on Thursday
// 18:00 for «until Friday 18:00» set on Tuesday, at 14:00 for «today 18:00»
// set at 10:00. Clients use the same formula to label the switch.
func AutoRemindAt(created, due time.Time) time.Time {
	dayBefore := due.Add(-24 * time.Hour)
	half := created.Add(due.Sub(created) / 2)
	if dayBefore.After(half) {
		return dayBefore.UTC().Truncate(time.Microsecond)
	}
	return half.UTC().Truncate(time.Microsecond)
}

// Fingerprint identifies the request part of a create command, so a replay
// with another audience or answer type is an idempotency conflict.
func (p Plan) Fingerprint() string {
	var b strings.Builder
	b.WriteString(p.AudienceKind)
	b.WriteByte(0)
	b.WriteString(strings.Join(p.ActorIDs, ","))
	b.WriteByte(0)
	b.WriteString(p.Answer.Preset)
	for _, option := range p.Answer.Options {
		b.WriteByte(1)
		b.WriteString(option)
	}
	b.WriteByte(0)
	b.WriteString(strconv.FormatBool(p.AllowComment))
	b.WriteByte(0)
	if p.DueAt != nil {
		b.WriteString(strconv.FormatInt(p.DueAt.UnixMicro(), 10))
	}
	b.WriteByte(0)
	b.WriteString(strconv.FormatBool(p.AutoRemindAt != nil))
	// Only for the group kinds, so earlier fingerprints stay as they were.
	if p.DepartmentID != "" || p.PositionID != "" {
		b.WriteByte(0)
		b.WriteString(p.DepartmentID)
		b.WriteByte(0)
		b.WriteString(p.PositionID)
	}
	sum := sha256.Sum256([]byte(b.String()))
	return "\x00request\x00" + hex.EncodeToString(sum[:])
}

// Summary is the request as every reader of the message sees it
// (components/schemas/MessageRequest). It never lists recipients or answers.
type Summary struct {
	Status        string     `json:"status"`
	ClosedReason  *string    `json:"closed_reason"`
	Answer        AnswerSpec `json:"answer"`
	AllowComment  bool       `json:"allow_comment"`
	DueAt         *time.Time `json:"due_at"`
	AutoRemindAt  *time.Time `json:"auto_remind_at"`
	Audience      Audience   `json:"audience"`
	AnsweredCount int        `json:"answered_count"`
	WaitingCount  int        `json:"waiting_count"`
	Version       int        `json:"version"`
}

type Audience struct {
	Kind  string `json:"kind"`
	Label string `json:"label"`
	Count int    `json:"count"`
	// DepartmentID and PositionID: the addressed group of the department
	// and position kinds; nil once it is deleted. See MarshalJSON.
	DepartmentID *string `json:"department_id,omitempty"`
	PositionID   *string `json:"position_id,omitempty"`
}

// Viewer is what one reader may do with a request
// (components/schemas/MessageRequestViewer). Never put in realtime frames.
type Viewer struct {
	Role           string        `json:"role"`
	Answer         *ViewerAnswer `json:"answer"`
	CanAnswer      bool          `json:"can_answer"`
	CanChange      bool          `json:"can_change"`
	CanViewAnswers bool          `json:"can_view_answers"`
	CanClose       bool          `json:"can_close"`
	CanRemind      bool          `json:"can_remind"`
	NextRemindAt   *time.Time    `json:"next_remind_at"`
	Tally          []int         `json:"tally"`
}

type ViewerAnswer struct {
	Option     int       `json:"option"`
	Comment    string    `json:"comment"`
	AnsweredAt time.Time `json:"answered_at"`
	Late       bool      `json:"late"`
	Version    int       `json:"version"`
}

// State is a request with one reader's view of it.
type State struct {
	Request Summary `json:"request"`
	Viewer  Viewer  `json:"viewer"`
}

func truncateRunes(value string, limit int) string {
	if utf8.RuneCountInString(value) <= limit {
		return value
	}
	runes := []rune(value)
	return string(runes[:limit])
}

func validUUID(field, value string) error {
	if _, err := uuid.Parse(value); err != nil {
		return invalid(field, "%s must be a UUID", field)
	}
	return nil
}
