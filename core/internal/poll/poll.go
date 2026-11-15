// Package poll implements polls («Опрос», phase 6.7 wave 4): a message of
// type poll asks the chat to choose among 2–10 options, one or several,
// openly or anonymously, with an optional due date.
//
// Anonymity is honest. For an anonymous poll the server keeps only the
// counts per option (message_polls.option_counts) and who has voted
// (message_poll_voters), never who chose what: no row in message_poll_votes
// (a trigger refuses one), nothing in events, frames, replies or logs. The
// price is that such a vote is final.
//
// MessagePoll (Poll) is the same for every reader and goes into chat-wide
// frames: it never carries the counts of an open poll. The counts and the
// reader's own vote are in PollViewer (Viewer), REST only, computed for one
// person from the database on every read: membership, the chat role and
// chats.moderate are read anew each time, nothing is taken from the session.
//
// The package sits below message: message.Service creates poll messages
// through the ordinary send path and calls OnMessageDeletedTx when a message
// is deleted, so this package never imports message.
package poll

import (
	"errors"
	"fmt"
	"strings"
	"time"
	"unicode/utf8"
)

var (
	ErrInvalid         = errors.New("poll input is invalid")
	ErrNotFound        = errors.New("poll not found")
	ErrNotMember       = errors.New("not a member of the poll chat")
	ErrForbidden       = errors.New("poll action forbidden")
	ErrClosed          = errors.New("poll is closed")
	ErrVoteFinal       = errors.New("an anonymous vote is final")
	ErrChatArchived    = errors.New("poll chat is archived")
	ErrLimitReached    = errors.New("poll limit reached")
	ErrVersionConflict = errors.New("poll version conflict")
	ErrRemindTooSoon   = errors.New("poll reminder too soon")
	ErrUnavailable     = errors.New("polls are not configured")
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

// RemindTooSoonError carries when «Напомнить» is allowed again.
type RemindTooSoonError struct{ RetryAfter time.Duration }

func (e *RemindTooSoonError) Error() string     { return ErrRemindTooSoon.Error() }
func (e *RemindTooSoonError) Is(err error) bool { return err == ErrRemindTooSoon }

// Statuses and reasons.
const (
	StatusOpen   = "open"
	StatusClosed = "closed"

	ReasonAuthor         = "author"
	ReasonModerator      = "moderator"
	ReasonExpired        = "expired"
	ReasonMessageDeleted = "message_deleted"
)

// Limits of polls. The zero value of a field means its default.
type Limits struct {
	OpenPerChat    int
	OpenPerAuthor  int
	RemindInterval time.Duration
	RemindMax      int
	// DailyRemindersPerPerson caps the reminder pushes one person gets from
	// all polls in 24 hours; the rest are recorded without a push.
	DailyRemindersPerPerson int
}

func DefaultLimits() Limits {
	return Limits{OpenPerChat: 100, OpenPerAuthor: 200, RemindInterval: 2 * time.Hour, RemindMax: 5, DailyRemindersPerPerson: 10}
}

// Bounds of the input.
const (
	MaxQuestionRunes = 300
	MaxOptionRunes   = 100
	MinOptions       = 2
	MaxOptions       = 10
	MinDueAhead      = 10 * time.Minute
	MaxDueAhead      = 90 * 24 * time.Hour
	HotWithin        = 24 * time.Hour
)

// CreateSpec is the poll part of createPoll.
type CreateSpec struct {
	Question  string
	Options   []string
	Multiple  bool
	Anonymous bool
	DueAt     *time.Time
}

// Plan is a validated CreateSpec.
type Plan struct {
	Question  string
	Options   []string
	Multiple  bool
	Anonymous bool
	DueAt     *time.Time
}

func validText(value string, min, max int) bool {
	if !utf8.ValidString(value) || strings.ContainsRune(value, 0) {
		return false
	}
	length := utf8.RuneCountInString(value)
	return length >= min && length <= max
}

// NormalizeQuestion trims the question and checks its length.
func NormalizeQuestion(value string) (string, error) {
	value = strings.TrimSpace(value)
	if !validText(value, 1, MaxQuestionRunes) {
		return "", invalid("question", "question must be 1 to %d characters", MaxQuestionRunes)
	}
	return value, nil
}

// Normalize validates spec against now without touching the database.
func Normalize(spec CreateSpec, now time.Time) (Plan, error) {
	plan := Plan{Multiple: spec.Multiple, Anonymous: spec.Anonymous}
	var err error
	if plan.Question, err = NormalizeQuestion(spec.Question); err != nil {
		return Plan{}, err
	}
	if len(spec.Options) < MinOptions || len(spec.Options) > MaxOptions {
		return Plan{}, invalid("options", "a poll has %d to %d options", MinOptions, MaxOptions)
	}
	seen := map[string]bool{}
	for index, option := range spec.Options {
		option = strings.TrimSpace(option)
		if !validText(option, 1, MaxOptionRunes) {
			return Plan{}, invalid(fmt.Sprintf("options[%d]", index), "an option must be 1 to %d characters", MaxOptionRunes)
		}
		key := strings.ToLower(option)
		if seen[key] {
			return Plan{}, invalid("options", "options must not repeat")
		}
		seen[key] = true
		plan.Options = append(plan.Options, option)
	}
	if spec.DueAt != nil {
		due := spec.DueAt.UTC().Truncate(time.Microsecond)
		if due.Before(now.Add(MinDueAhead)) || due.After(now.Add(MaxDueAhead)) {
			return Plan{}, invalid("due_at", "due_at must be between 10 minutes and 90 days ahead")
		}
		plan.DueAt = &due
	}
	return plan, nil
}

// Body is the text of the poll message: «Опрос: {question}», an empty line,
// then «— {option}» per option. Search, agents and older clients read it.
func Body(question string, options []string) string {
	var b strings.Builder
	b.WriteString("Опрос: ")
	b.WriteString(question)
	b.WriteString("\n")
	for _, option := range options {
		b.WriteString("\n— ")
		b.WriteString(option)
	}
	return b.String()
}

// Fingerprint identifies the poll part of a create command, so a replay with
// other content is an idempotency conflict. The question and the options
// are in body, which the message fingerprint covers.
func (p Plan) Fingerprint() string {
	due := ""
	if p.DueAt != nil {
		due = p.DueAt.UTC().Format(time.RFC3339Nano)
	}
	return fmt.Sprintf("\x00poll\x00%t\x00%t\x00%s\x00%s", p.Multiple, p.Anonymous, due, strings.Join(p.Options, "\x01"))
}

// Poll is MessagePoll: the poll as every reader of the message sees it.
// It never carries the counts of an open poll.
type Poll struct {
	Question     string     `json:"question"`
	Options      []string   `json:"options"`
	Multiple     bool       `json:"multiple"`
	Anonymous    bool       `json:"anonymous"`
	DueAt        *time.Time `json:"due_at"`
	Status       string     `json:"status"`
	ClosedReason *string    `json:"closed_reason"`
	ClosedAt     *time.Time `json:"closed_at"`
	VoterCount   int        `json:"voter_count"`
	MemberCount  int        `json:"member_count"`
	FinalCounts  []int      `json:"final_counts"`
	Version      int        `json:"version"`
}

// Viewer is PollViewer: what one person may see and do with a poll. REST
// only; never in a frame.
type Viewer struct {
	Voted          bool       `json:"voted"`
	MyOptions      []int      `json:"my_options"`
	CanVote        bool       `json:"can_vote"`
	CanChange      bool       `json:"can_change"`
	CanViewResults bool       `json:"can_view_results"`
	CanViewVoters  bool       `json:"can_view_voters"`
	CanViewWaiting bool       `json:"can_view_waiting"`
	CanClose       bool       `json:"can_close"`
	CanRemind      bool       `json:"can_remind"`
	NextRemindAt   *time.Time `json:"next_remind_at"`
	Counts         []int      `json:"counts"`
}

// State is PollState: the poll and the reader's view of it.
type State struct {
	Poll   *Poll   `json:"poll"`
	Viewer *Viewer `json:"viewer"`
}

// Hot: open with a due date within 24 hours of now.
func Hot(due *time.Time, now time.Time) bool { return due != nil && due.Before(now.Add(HotWithin)) }
