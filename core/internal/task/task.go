// Package task implements tasks («Задача», phase 6.6 wave 3): a message of
// type task asks one responsible person, or a queue of a department or a
// position, to do something by a due date, with an optional checklist.
//
// A task has no private part: every member of the chat sees all of it, so
// MessageTask is the same for every reader and goes into chat-wide frames.
// Access is derived from the current membership and chat role on every read
// and every action; nothing about it is stored. task.notified events, sent
// to one person each, carry ids and the due date only, never the title, the
// description or item texts.
//
// The package sits below message: message.Service creates task messages
// through the ordinary send path and calls OnMessageDeletedTx when a message
// is deleted, so this package never imports message.
package task

import (
	"errors"
	"fmt"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"
)

var (
	ErrInvalid           = errors.New("task input is invalid")
	ErrAssigneeInvalid   = errors.New("task assignee is invalid")
	ErrTooManyCandidates = errors.New("task queue has too many candidates")
	ErrAudienceEmpty     = errors.New("task queue is empty")
	ErrAudienceForbidden = errors.New("task queue needs requests.address_groups")
	ErrDepartmentMissing = errors.New("department not found")
	ErrPositionMissing   = errors.New("position not found")
	ErrNotMember         = errors.New("not a member of the task chat")
	ErrForbidden         = errors.New("task action forbidden")
	ErrNotFound          = errors.New("task not found")
	ErrStatusInvalid     = errors.New("task status change is not allowed")
	ErrLimitReached      = errors.New("task limit reached")
	ErrChatArchived      = errors.New("task chat is archived")
	ErrNudgeTooSoon      = errors.New("task nudge too soon")
	ErrUnavailable       = errors.New("tasks are not configured")
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

// ConflictError carries the current task of 409 task_version_conflict and
// 409 task_already_taken (details.task).
type ConflictError struct {
	Code string // "task_version_conflict" or "task_already_taken"
	Task *Task
}

func (e *ConflictError) Error() string { return e.Code }

// NudgeTooSoonError carries when «Напомнить» is allowed again.
type NudgeTooSoonError struct{ RetryAfter time.Duration }

func (e *NudgeTooSoonError) Error() string     { return ErrNudgeTooSoon.Error() }
func (e *NudgeTooSoonError) Is(err error) bool { return err == ErrNudgeTooSoon }

// Statuses.
const (
	StatusOpen       = "open"
	StatusInProgress = "in_progress"
	StatusDone       = "done"
	StatusCanceled   = "canceled"
)

// Active is open or in progress: the task still asks for work.
func Active(status string) bool { return status == StatusOpen || status == StatusInProgress }

// Limits of tasks. The zero value of a field means its default.
type Limits struct {
	OpenPerChat   int
	OpenPerAuthor int
	MaxItems      int
	MaxCandidates int
	NudgeInterval time.Duration
	NudgeMax      int
	// DailyNudgesPerPerson caps the «Напомнить» pushes one person gets from
	// all tasks in 24 hours; the rest are recorded without a push.
	DailyNudgesPerPerson int
	// DueSoonMaxLateness: a reminder one hour before the due date later than
	// this is not sent. OverdueMaxLateness: an overdue push later than this
	// is not sent (task.updated still is).
	DueSoonMaxLateness time.Duration
	OverdueMaxLateness time.Duration
}

func DefaultLimits() Limits {
	return Limits{
		OpenPerChat: 300, OpenPerAuthor: 500, MaxItems: 30, MaxCandidates: 100,
		NudgeInterval: 2 * time.Hour, NudgeMax: 5, DailyNudgesPerPerson: 10,
		DueSoonMaxLateness: 30 * time.Minute, OverdueMaxLateness: 6 * time.Hour,
	}
}

// Bounds of the input.
const (
	MaxTitleRunes       = 200
	MaxDescriptionRunes = 4000
	MaxItemRunes        = 200
	MaxLabelRunes       = 60
	MaxExcerptRunes     = 140
	MinDueAhead         = 5 * time.Minute
	MaxDueAhead         = 365 * 24 * time.Hour
	RemindBefore        = time.Hour
	HotWithin           = 24 * time.Hour
)

// AssigneeInput says who is responsible, before a queue is turned into
// people.
type AssigneeInput struct {
	Kind         string  `json:"kind"`
	ActorID      *string `json:"actor_id,omitempty"`
	DepartmentID *string `json:"department_id,omitempty"`
	PositionID   *string `json:"position_id,omitempty"`
}

// ItemInput is one checklist item of createTask.
type ItemInput struct {
	Text       string  `json:"text"`
	AssigneeID *string `json:"assignee_id,omitempty"`
}

// CreateSpec is the task part of createTask.
type CreateSpec struct {
	Title           string
	Description     string
	Assignee        AssigneeInput
	DueAt           *time.Time
	RemindBeforeDue bool
	Items           []ItemInput
	SourceMessageID *string
}

// Plan is a validated CreateSpec.
type Plan struct {
	Title           string
	Description     string
	Assignee        AssigneeInput
	DueAt           *time.Time
	RemindBeforeDue bool
	Items           []ItemInput
	SourceMessageID *string
}

// Body is the text of the task message: the title and, after an empty
// line, the description.
func Body(title, description string) string {
	if description == "" {
		return title
	}
	return title + "\n\n" + description
}

func validText(value string, min, max int) bool {
	if !utf8.ValidString(value) || strings.ContainsRune(value, 0) {
		return false
	}
	length := utf8.RuneCountInString(value)
	return length >= min && length <= max
}

// NormalizeTitle trims the title and checks its length.
func NormalizeTitle(value string) (string, error) {
	value = strings.TrimSpace(value)
	if !validText(value, 1, MaxTitleRunes) {
		return "", invalid("title", "title must be 1 to %d characters", MaxTitleRunes)
	}
	return value, nil
}

// NormalizeDescription trims trailing space and checks the length.
func NormalizeDescription(value string) (string, error) {
	value = strings.TrimRight(value, " \t\r\n")
	if !validText(value, 0, MaxDescriptionRunes) {
		return "", invalid("description", "description must be at most %d characters", MaxDescriptionRunes)
	}
	return value, nil
}

// NormalizeItemText trims an item text and checks its length.
func NormalizeItemText(field, value string) (string, error) {
	value = strings.TrimSpace(value)
	if !validText(value, 1, MaxItemRunes) {
		return "", invalid(field, "item text must be 1 to %d characters", MaxItemRunes)
	}
	return value, nil
}

// NormalizeDue checks a due date against now.
func NormalizeDue(value time.Time, now time.Time) (time.Time, error) {
	due := value.UTC().Truncate(time.Microsecond)
	if due.Before(now.Add(MinDueAhead)) || due.After(now.Add(MaxDueAhead)) {
		return time.Time{}, invalid("due_at", "due_at must be between 5 minutes and 365 days ahead")
	}
	return due, nil
}

func normalizeUUID(field string, value *string) (*string, error) {
	if value == nil {
		return nil, nil
	}
	parsed, err := uuid.Parse(*value)
	if err != nil {
		return nil, invalid(field, "%s must be a UUID", field)
	}
	result := parsed.String()
	return &result, nil
}

// NormalizeAssignee checks the shape of an assignee input.
func NormalizeAssignee(input AssigneeInput) (AssigneeInput, error) {
	result := AssigneeInput{Kind: input.Kind}
	var err error
	switch input.Kind {
	case "person":
		if input.DepartmentID != nil || input.PositionID != nil || input.ActorID == nil {
			return AssigneeInput{}, invalid("assignee", "a person assignee takes actor_id only")
		}
		if result.ActorID, err = normalizeUUID("assignee.actor_id", input.ActorID); err != nil {
			return AssigneeInput{}, err
		}
	case "department":
		if input.ActorID != nil || input.PositionID != nil || input.DepartmentID == nil {
			return AssigneeInput{}, invalid("assignee", "a department assignee takes department_id only")
		}
		if result.DepartmentID, err = normalizeUUID("assignee.department_id", input.DepartmentID); err != nil {
			return AssigneeInput{}, err
		}
	case "position":
		if input.ActorID != nil || input.DepartmentID != nil || input.PositionID == nil {
			return AssigneeInput{}, invalid("assignee", "a position assignee takes position_id only")
		}
		if result.PositionID, err = normalizeUUID("assignee.position_id", input.PositionID); err != nil {
			return AssigneeInput{}, err
		}
	default:
		return AssigneeInput{}, invalid("assignee.kind", "assignee kind must be person, department or position")
	}
	return result, nil
}

// Normalize validates spec against now without touching the database.
func Normalize(spec CreateSpec, now time.Time) (Plan, error) {
	var plan Plan
	var err error
	if plan.Title, err = NormalizeTitle(spec.Title); err != nil {
		return Plan{}, err
	}
	if plan.Description, err = NormalizeDescription(spec.Description); err != nil {
		return Plan{}, err
	}
	if plan.Assignee, err = NormalizeAssignee(spec.Assignee); err != nil {
		return Plan{}, err
	}
	if spec.DueAt != nil {
		due, err := NormalizeDue(*spec.DueAt, now)
		if err != nil {
			return Plan{}, err
		}
		plan.DueAt = &due
	}
	if spec.RemindBeforeDue {
		if plan.DueAt == nil || !plan.DueAt.After(now.Add(RemindBefore)) {
			return Plan{}, invalid("remind_before_due", "a reminder needs a due date more than 1 hour ahead")
		}
		plan.RemindBeforeDue = true
	}
	if len(spec.Items) > DefaultLimits().MaxItems {
		return Plan{}, invalid("items", "a task has at most %d items", DefaultLimits().MaxItems)
	}
	for index, item := range spec.Items {
		field := fmt.Sprintf("items[%d]", index)
		text, err := NormalizeItemText(field+".text", item.Text)
		if err != nil {
			return Plan{}, err
		}
		assignee, err := normalizeUUID(field+".assignee_id", item.AssigneeID)
		if err != nil {
			return Plan{}, err
		}
		plan.Items = append(plan.Items, ItemInput{Text: text, AssigneeID: assignee})
	}
	if plan.SourceMessageID, err = normalizeUUID("source_message_id", spec.SourceMessageID); err != nil {
		return Plan{}, err
	}
	return plan, nil
}

// Fingerprint identifies the task part of a create command, so a replay
// with other content is an idempotency conflict. The title and the
// description are in body, which the message fingerprint covers.
func (p Plan) Fingerprint() string {
	var b strings.Builder
	b.WriteString("\x00task\x00")
	b.WriteString(p.Assignee.Kind)
	for _, value := range []*string{p.Assignee.ActorID, p.Assignee.DepartmentID, p.Assignee.PositionID, p.SourceMessageID} {
		b.WriteByte(0)
		if value != nil {
			b.WriteString(*value)
		}
	}
	b.WriteByte(0)
	if p.DueAt != nil {
		b.WriteString(p.DueAt.UTC().Format(time.RFC3339Nano))
	}
	fmt.Fprintf(&b, "\x00%t", p.RemindBeforeDue)
	for _, item := range p.Items {
		b.WriteByte(1)
		b.WriteString(item.Text)
		b.WriteByte(2)
		if item.AssigneeID != nil {
			b.WriteString(*item.AssigneeID)
		}
	}
	return b.String()
}

// Task is MessageTask: the task as every reader of the message sees it.
type Task struct {
	Title           string     `json:"title"`
	Description     string     `json:"description"`
	Status          string     `json:"status"`
	CanceledReason  *string    `json:"canceled_reason"`
	StatusChangedAt *time.Time `json:"status_changed_at"`
	StatusChangedBy *string    `json:"status_changed_by"`
	Assignee        Assignee   `json:"assignee"`
	DueAt           *time.Time `json:"due_at"`
	RemindBeforeDue bool       `json:"remind_before_due"`
	Items           []Item     `json:"items"`
	ItemsDone       int        `json:"items_done"`
	Source          *Source    `json:"source"`
	LastNudgeAt     *time.Time `json:"last_nudge_at"`
	NudgeCount      int        `json:"nudge_count"`
	Version         int        `json:"version"`
}

// Assignee is MessageTaskAssignee. DepartmentID and PositionID are present
// (possibly null) only on their own kind.
type Assignee struct {
	Kind         string   `json:"kind"`
	ActorID      *string  `json:"actor_id"`
	Label        string   `json:"label"`
	CandidateIDs []string `json:"candidate_ids"`
	InChat       bool     `json:"in_chat"`
	DepartmentID OptionalID
	PositionID   OptionalID
}

// OptionalID is a nullable id that may also be absent from the JSON.
type OptionalID struct {
	Set   bool
	Value *string
}

type Item struct {
	ID             string     `json:"id"`
	Text           string     `json:"text"`
	AssigneeID     *string    `json:"assignee_id"`
	AssigneeInChat bool       `json:"assignee_in_chat"`
	DoneAt         *time.Time `json:"done_at"`
	DoneBy         *string    `json:"done_by"`
}

type Source struct {
	MessageID string `json:"message_id"`
	AuthorID  string `json:"author_id"`
	Excerpt   string `json:"excerpt"`
	Deleted   bool   `json:"deleted"`
}

// Queue is a task of a department or position nobody has taken.
func (t *Task) Queue() bool { return t.Assignee.Kind != "person" && t.Assignee.ActorID == nil }

// Hot: active and overdue or due within 24 hours of now.
func Hot(status string, due *time.Time, now time.Time) bool {
	return Active(status) && due != nil && due.Before(now.Add(HotWithin))
}

func truncateRunes(value string, limit int) string {
	if utf8.RuneCountInString(value) <= limit {
		return value
	}
	return string([]rune(value)[:limit])
}

func strPtr(value string) *string { return &value }
