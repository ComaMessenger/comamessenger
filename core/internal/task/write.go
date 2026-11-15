package task

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"time"

	"github.com/comamessenger/comamessenger/core/internal/id"
	"github.com/comamessenger/comamessenger/core/internal/identity"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

func newID() (string, error) {
	value, err := id.New()
	if err != nil {
		return "", fmt.Errorf("generate task id: %w", err)
	}
	return value, nil
}

// Change is what a write did, for the message layer that wraps it: the last
// event sequence to notify, and the texts when the title or the description
// changed (the message body is rebuilt, message.updated replaces
// task.updated).
type Change struct {
	Seq         int64
	ChatID      string
	TextChanged bool
	Title       string
	Description string
}

func (c *Change) bump(seq int64) {
	if seq > c.Seq {
		c.Seq = seq
	}
}

// action is a locked task with the reader's standing and its snapshot.
type action struct {
	t      lockedTask
	viewer Viewer
	task   *Task
	perms  Permissions
}

// begin opens an action: the organization lock, then the task (message row
// first), then the reader as stored now. Someone who is not a member gets
// 404, except people the task concerns, who get not_member.
func (s *Service) begin(ctx context.Context, tx pgx.Tx, user identity.User, messageID string) (action, error) {
	if uuid.Validate(messageID) != nil {
		return action{}, ErrNotFound
	}
	if err := lockOrganization(ctx, tx, user.OrgID); err != nil {
		return action{}, err
	}
	current, err := lockTask(ctx, tx, user.OrgID, messageID)
	if err != nil {
		return action{}, err
	}
	if current.MessageDeleted {
		return action{}, ErrNotFound
	}
	viewer, err := readViewer(ctx, tx, user, current.ChatID)
	if err != nil {
		return action{}, err
	}
	snapshot, err := LoadOne(ctx, tx, user.OrgID, messageID)
	if err != nil {
		return action{}, err
	}
	if !viewer.Member {
		concerned := current.AuthorID == user.ActorID ||
			(current.AssigneeID != nil && *current.AssigneeID == user.ActorID) ||
			slices.Contains(snapshot.Assignee.CandidateIDs, user.ActorID) ||
			slices.ContainsFunc(snapshot.Items, func(item Item) bool { return item.AssigneeID != nil && *item.AssigneeID == user.ActorID })
		if concerned {
			return action{}, ErrNotMember
		}
		return action{}, ErrNotFound
	}
	if current.ChatArchived {
		return action{}, ErrChatArchived
	}
	return action{t: current, viewer: viewer, task: snapshot, perms: PermissionsOf(snapshot, current.AuthorID, viewer, s.limits)}, nil
}

func (a action) manager() bool { return a.t.AuthorID == a.viewer.ActorID || a.viewer.Admin() }

func (a action) worker() bool {
	return a.manager() || (a.t.AssigneeID != nil && *a.t.AssigneeID == a.viewer.ActorID)
}

func (a action) conflict(code string) error { return &ConflictError{Code: code, Task: a.task} }

// OptionalTime is a JSON field that may be absent, null or a time.
type OptionalTime struct {
	Set   bool
	Value *time.Time
}

// OptionalString is a JSON field that may be absent, null or a string.
type OptionalString struct {
	Set   bool
	Value *string
}

// UpdateInput is updateTask. due_at null removes the due date; absent keeps
// it.
type UpdateInput struct {
	ExpectedVersion *int
	Title           *string
	Description     *string
	DueAt           OptionalTime
	RemindBeforeDue *bool
	Assignee        *AssigneeInput
}

func strictDecode(data []byte, target any) error {
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	return decoder.Decode(target)
}

func (input *UpdateInput) UnmarshalJSON(data []byte) error {
	var aux struct {
		ExpectedVersion *int            `json:"expected_version"`
		Title           *string         `json:"title"`
		Description     *string         `json:"description"`
		DueAt           json.RawMessage `json:"due_at"`
		RemindBeforeDue *bool           `json:"remind_before_due"`
		Assignee        *AssigneeInput  `json:"assignee"`
	}
	if err := strictDecode(data, &aux); err != nil {
		return err
	}
	*input = UpdateInput{ExpectedVersion: aux.ExpectedVersion, Title: aux.Title, Description: aux.Description,
		RemindBeforeDue: aux.RemindBeforeDue, Assignee: aux.Assignee}
	if aux.DueAt != nil {
		input.DueAt.Set = true
		if err := json.Unmarshal(aux.DueAt, &input.DueAt.Value); err != nil {
			return err
		}
	}
	return nil
}

// UpdateTx changes the title, the description, the due date, the reminder
// or the responsible person: the author or a chat admin, while the task is
// open or in progress.
func (s *Service) UpdateTx(ctx context.Context, tx pgx.Tx, user identity.User, messageID string, input UpdateInput) (Change, error) {
	if input.ExpectedVersion == nil || *input.ExpectedVersion < 1 {
		return Change{}, invalid("expected_version", "expected_version is required")
	}
	var title, description *string
	if input.Title != nil {
		value, err := NormalizeTitle(*input.Title)
		if err != nil {
			return Change{}, err
		}
		title = &value
	}
	if input.Description != nil {
		value, err := NormalizeDescription(*input.Description)
		if err != nil {
			return Change{}, err
		}
		description = &value
	}
	var assignee *AssigneeInput
	if input.Assignee != nil {
		value, err := NormalizeAssignee(*input.Assignee)
		if err != nil {
			return Change{}, err
		}
		assignee = &value
	}
	a, err := s.begin(ctx, tx, user, messageID)
	if err != nil {
		return Change{}, err
	}
	if !a.manager() {
		return Change{}, ErrForbidden
	}
	if !Active(a.t.Status) {
		return Change{}, ErrStatusInvalid
	}
	if *input.ExpectedVersion != a.t.Version {
		return Change{}, a.conflict("task_version_conflict")
	}
	now := s.Now()
	t := a.t
	change := Change{ChatID: t.ChatID, Title: t.Title, Description: t.Description}
	if title != nil && *title != t.Title {
		change.Title, change.TextChanged = *title, true
	}
	if description != nil && *description != t.Description {
		change.Description, change.TextChanged = *description, true
	}
	due, remind := t.DueAt, t.RemindBeforeDue
	dueChanged := false
	if input.DueAt.Set {
		switch {
		case input.DueAt.Value == nil:
			dueChanged = t.DueAt != nil
			due, remind = nil, false
		case t.DueAt != nil && input.DueAt.Value.Equal(*t.DueAt):
		default:
			value, err := NormalizeDue(*input.DueAt.Value, now)
			if err != nil {
				return Change{}, err
			}
			due, dueChanged = &value, true
		}
	}
	if input.RemindBeforeDue != nil {
		remind = *input.RemindBeforeDue
		if remind && remind != t.RemindBeforeDue || remind && dueChanged {
			if due == nil || !due.After(now.Add(RemindBefore)) {
				return Change{}, invalid("remind_before_due", "a reminder needs a due date more than 1 hour ahead")
			}
		}
	}
	if due == nil {
		remind = false
	}
	remindChanged := remind != t.RemindBeforeDue
	var resolved *resolvedAssignee
	if assignee != nil {
		samePerson := assignee.Kind == "person" && t.Kind == "person" && t.AssigneeID != nil && *t.AssigneeID == *assignee.ActorID
		if !samePerson {
			value, err := s.resolveAssignee(ctx, tx, user, t.ChatID, *assignee)
			if err != nil {
				return Change{}, err
			}
			resolved = &value
		}
	}
	if !change.TextChanged && !dueChanged && !remindChanged && resolved == nil {
		return change, nil
	}
	if err := tx.QueryRow(ctx, `
		UPDATE message_tasks SET title=$2, description=$3, due_at=$4, remind_before_due=$5,
			version=version+1, updated_at=$6
		WHERE message_id=$1 RETURNING version`, messageID, change.Title, change.Description, due, remind, now).Scan(&t.Version); err != nil {
		return Change{}, fmt.Errorf("update task: %w", err)
	}
	t.DueAt, t.RemindBeforeDue = due, remind
	notices := noticeSet{}
	previous := t.AssigneeID
	if resolved != nil {
		if _, err := tx.Exec(ctx, `
			UPDATE message_tasks SET assignee_kind=$2, assignee_id=$3, audience_department_id=$4,
				audience_position_id=$5, audience_label=$6
			WHERE message_id=$1`, messageID, resolved.Kind, resolved.ActorID, resolved.DepartmentID,
			resolved.PositionID, resolved.Label); err != nil {
			return Change{}, fmt.Errorf("reassign task: %w", err)
		}
		if _, err := tx.Exec(ctx, `DELETE FROM message_task_candidates WHERE message_id=$1`, messageID); err != nil {
			return Change{}, fmt.Errorf("clear task candidates: %w", err)
		}
		if len(resolved.Candidates) > 0 {
			if _, err := tx.Exec(ctx, `
				INSERT INTO message_task_candidates (org_id, message_id, actor_id)
				SELECT $1, $2, candidate FROM unnest($3::uuid[]) AS candidate`, user.OrgID, messageID, resolved.Candidates); err != nil {
				return Change{}, fmt.Errorf("insert task candidates: %w", err)
			}
		}
		t.Kind, t.AssigneeID = resolved.Kind, resolved.ActorID
		if resolved.ActorID != nil {
			notices.add("assigned", *resolved.ActorID)
		}
		for _, candidate := range resolved.Candidates {
			notices.add("offered", candidate)
		}
		if previous != nil && (resolved.ActorID == nil || *previous != *resolved.ActorID) {
			notices.add("unassigned", *previous)
		}
	}
	if dueChanged && t.AssigneeID != nil {
		notices.add("due_changed", *t.AssigneeID)
	}
	if dueChanged || remindChanged {
		if err := s.rescheduleTx(ctx, tx, &t, now); err != nil {
			return Change{}, err
		}
	}
	seq, err := notices.write(ctx, tx, user.OrgID, user.ActorID, t.ChatID, messageID, t.DueAt)
	if err != nil {
		return Change{}, err
	}
	change.bump(seq)
	if !change.TextChanged {
		seq, err := emitUpdated(ctx, tx, t, user.ActorID)
		if err != nil {
			return Change{}, err
		}
		change.bump(seq)
	}
	return change, nil
}

// StatusInput is setTaskStatus.
type StatusInput struct {
	Status          string `json:"status"`
	ExpectedVersion *int   `json:"expected_version"`
}

// SetStatusTx moves the task between statuses by decision 4 and 5. The
// same status again changes nothing.
func (s *Service) SetStatusTx(ctx context.Context, tx pgx.Tx, user identity.User, messageID string, input StatusInput) (Change, error) {
	switch input.Status {
	case StatusOpen, StatusInProgress, StatusDone, StatusCanceled:
	default:
		return Change{}, invalid("status", "status must be open, in_progress, done or canceled")
	}
	if input.ExpectedVersion != nil && *input.ExpectedVersion < 1 {
		return Change{}, invalid("expected_version", "expected_version must be positive")
	}
	a, err := s.begin(ctx, tx, user, messageID)
	if err != nil {
		return Change{}, err
	}
	t := a.t
	change := Change{ChatID: t.ChatID}
	if input.ExpectedVersion != nil && *input.ExpectedVersion != t.Version {
		return Change{}, a.conflict("task_version_conflict")
	}
	if input.Status == t.Status {
		return change, nil
	}
	if !TransitionAllowed(t.Status, input.Status) {
		return Change{}, ErrStatusInvalid
	}
	if !a.perms.CanSetStatus(t.Status, input.Status) {
		return Change{}, ErrForbidden
	}
	now := s.Now()
	from := t.Status
	if !Active(from) {
		var openInChat, openByAuthor int
		if err := tx.QueryRow(ctx, `
			SELECT
				(SELECT count(*) FROM message_tasks WHERE org_id=$1 AND chat_id=$2 AND status IN ('open','in_progress')),
				(SELECT count(*) FROM message_tasks WHERE org_id=$1 AND author_id=$3 AND status IN ('open','in_progress'))`,
			user.OrgID, t.ChatID, t.AuthorID).Scan(&openInChat, &openByAuthor); err != nil {
			return Change{}, fmt.Errorf("count open tasks: %w", err)
		}
		if openInChat >= s.limits.OpenPerChat || openByAuthor >= s.limits.OpenPerAuthor {
			return Change{}, ErrLimitReached
		}
	}
	var reason *string
	if input.Status == StatusCanceled {
		reason = strPtr("author")
		if t.AuthorID != user.ActorID {
			reason = strPtr("moderator")
		}
	}
	if err := tx.QueryRow(ctx, `
		UPDATE message_tasks SET status=$2, canceled_reason=$3, status_changed_by=$4, status_changed_at=$5,
			version=version+1, updated_at=$5
		WHERE message_id=$1 RETURNING version`, messageID, input.Status, reason, user.ActorID, now).Scan(&t.Version); err != nil {
		return Change{}, fmt.Errorf("set task status: %w", err)
	}
	t.Status = input.Status
	switch {
	case !Active(input.Status):
		if err := s.cancelJobs(ctx, tx, &t); err != nil {
			return Change{}, err
		}
		if _, err := tx.Exec(ctx, `UPDATE message_tasks SET due_soon_job_id=NULL, overdue_job_id=NULL WHERE message_id=$1`, messageID); err != nil {
			return Change{}, fmt.Errorf("clear task jobs: %w", err)
		}
	case !Active(from):
		if err := s.rescheduleTx(ctx, tx, &t, now); err != nil {
			return Change{}, err
		}
	}
	notices := noticeSet{}
	if input.Status == StatusDone {
		notices.add("completed", t.AuthorID)
	}
	if from == StatusDone && input.Status == StatusOpen && t.AssigneeID != nil {
		notices.add("reopened", *t.AssigneeID)
	}
	seq, err := notices.write(ctx, tx, user.OrgID, user.ActorID, t.ChatID, messageID, t.DueAt)
	if err != nil {
		return Change{}, err
	}
	change.bump(seq)
	if seq, err = emitUpdated(ctx, tx, t, user.ActorID); err != nil {
		return Change{}, err
	}
	change.bump(seq)
	return change, nil
}

// TakeTx makes a candidate of a queue nobody has taken the responsible
// person. Two candidates at once: the task row lock lets one through; the
// other gets task_already_taken.
func (s *Service) TakeTx(ctx context.Context, tx pgx.Tx, user identity.User, messageID string) (Change, error) {
	a, err := s.begin(ctx, tx, user, messageID)
	if err != nil {
		return Change{}, err
	}
	t := a.t
	if t.Kind == "person" || !slices.Contains(a.task.Assignee.CandidateIDs, user.ActorID) {
		return Change{}, ErrForbidden
	}
	if !Active(t.Status) {
		return Change{}, ErrStatusInvalid
	}
	if t.AssigneeID != nil {
		return Change{}, a.conflict("task_already_taken")
	}
	now := s.Now()
	if err := tx.QueryRow(ctx, `
		UPDATE message_tasks SET assignee_id=$2, version=version+1, updated_at=$3
		WHERE message_id=$1 RETURNING version`, messageID, user.ActorID, now).Scan(&t.Version); err != nil {
		return Change{}, fmt.Errorf("take task: %w", err)
	}
	t.AssigneeID = &user.ActorID
	change := Change{ChatID: t.ChatID}
	notices := noticeSet{}
	notices.add("taken", t.AuthorID)
	seq, err := notices.write(ctx, tx, user.OrgID, user.ActorID, t.ChatID, messageID, t.DueAt)
	if err != nil {
		return Change{}, err
	}
	change.bump(seq)
	if seq, err = emitUpdated(ctx, tx, t, user.ActorID); err != nil {
		return Change{}, err
	}
	change.bump(seq)
	return change, nil
}

// requireManageItems: the author, the responsible person or a chat admin,
// while the task is active.
func (a action) requireManageItems() error {
	if a.perms.ManageItems {
		return nil
	}
	if !Active(a.t.Status) && a.worker() {
		return ErrStatusInvalid
	}
	return ErrForbidden
}

// AddItemInput is addTaskItem.
type AddItemInput struct {
	Text       string  `json:"text"`
	AssigneeID *string `json:"assignee_id"`
	Position   *int    `json:"position"`
}

// AddItemTx adds a checklist item, last or at position.
func (s *Service) AddItemTx(ctx context.Context, tx pgx.Tx, user identity.User, messageID string, input AddItemInput) (Change, error) {
	text, err := NormalizeItemText("text", input.Text)
	if err != nil {
		return Change{}, err
	}
	assignee, err := normalizeUUID("assignee_id", input.AssigneeID)
	if err != nil {
		return Change{}, err
	}
	if input.Position != nil && (*input.Position < 0 || *input.Position >= s.limits.MaxItems) {
		return Change{}, invalid("position", "position must be between 0 and %d", s.limits.MaxItems-1)
	}
	a, err := s.begin(ctx, tx, user, messageID)
	if err != nil {
		return Change{}, err
	}
	if err := a.requireManageItems(); err != nil {
		return Change{}, err
	}
	t := a.t
	if t.ItemsTotal >= s.limits.MaxItems {
		return Change{}, ErrLimitReached
	}
	if assignee != nil {
		if err := requireAssignable(ctx, tx, user.OrgID, t.ChatID, *assignee); err != nil {
			return Change{}, err
		}
	}
	position := t.ItemsTotal
	if input.Position != nil {
		if *input.Position > t.ItemsTotal {
			return Change{}, invalid("position", "position must be at most %d", t.ItemsTotal)
		}
		position = *input.Position
	}
	if _, err := tx.Exec(ctx, `SELECT 1 FROM message_task_items WHERE message_id=$1 FOR UPDATE`, messageID); err != nil {
		return Change{}, fmt.Errorf("lock task items: %w", err)
	}
	if _, err := tx.Exec(ctx, `UPDATE message_task_items SET position=position+1 WHERE message_id=$1 AND position>=$2`, messageID, position); err != nil {
		return Change{}, fmt.Errorf("shift task items: %w", err)
	}
	itemID, err := newID()
	if err != nil {
		return Change{}, err
	}
	now := s.Now()
	var assignedAt *time.Time
	if assignee != nil {
		assignedAt = &now
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO message_task_items (id, org_id, message_id, position, text, assignee_id, assigned_at, created_by, created_at)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, itemID, user.OrgID, messageID, position, text, assignee, assignedAt, user.ActorID, now); err != nil {
		return Change{}, fmt.Errorf("insert task item: %w", err)
	}
	if err := tx.QueryRow(ctx, `
		UPDATE message_tasks SET items_total=items_total+1, version=version+1, updated_at=$2
		WHERE message_id=$1 RETURNING version`, messageID, now).Scan(&t.Version); err != nil {
		return Change{}, fmt.Errorf("count task items: %w", err)
	}
	change := Change{ChatID: t.ChatID}
	notices := noticeSet{}
	if assignee != nil {
		notices.add("item_assigned", *assignee)
	}
	seq, err := notices.write(ctx, tx, user.OrgID, user.ActorID, t.ChatID, messageID, t.DueAt)
	if err != nil {
		return Change{}, err
	}
	change.bump(seq)
	if seq, err = emitUpdated(ctx, tx, t, user.ActorID); err != nil {
		return Change{}, err
	}
	change.bump(seq)
	return change, nil
}

// UpdateItemInput is updateTaskItem; assignee_id null removes the assignee.
type UpdateItemInput struct {
	Text       *string
	AssigneeID OptionalString
	Done       *bool
	Position   *int
}

func (input *UpdateItemInput) UnmarshalJSON(data []byte) error {
	var aux struct {
		Text       *string         `json:"text"`
		AssigneeID json.RawMessage `json:"assignee_id"`
		Done       *bool           `json:"done"`
		Position   *int            `json:"position"`
	}
	if err := strictDecode(data, &aux); err != nil {
		return err
	}
	*input = UpdateItemInput{Text: aux.Text, Done: aux.Done, Position: aux.Position}
	if aux.AssigneeID != nil {
		input.AssigneeID.Set = true
		if err := json.Unmarshal(aux.AssigneeID, &input.AssigneeID.Value); err != nil {
			return err
		}
	}
	return nil
}

type lockedItem struct {
	position   int
	text       string
	assigneeID *string
	done       bool
}

// UpdateItemTx changes an item. Marking it done or not done is allowed to
// the assignee of the item too; everything else needs ManageItems.
func (s *Service) UpdateItemTx(ctx context.Context, tx pgx.Tx, user identity.User, messageID, itemID string, input UpdateItemInput) (Change, error) {
	if input.Text == nil && !input.AssigneeID.Set && input.Done == nil && input.Position == nil {
		return Change{}, invalid("item", "nothing to change")
	}
	var text *string
	if input.Text != nil {
		value, err := NormalizeItemText("text", *input.Text)
		if err != nil {
			return Change{}, err
		}
		text = &value
	}
	assignee, err := normalizeUUID("assignee_id", input.AssigneeID.Value)
	if err != nil {
		return Change{}, err
	}
	if input.Position != nil && (*input.Position < 0 || *input.Position >= s.limits.MaxItems) {
		return Change{}, invalid("position", "position must be between 0 and %d", s.limits.MaxItems-1)
	}
	if uuid.Validate(itemID) != nil {
		return Change{}, ErrNotFound
	}
	a, err := s.begin(ctx, tx, user, messageID)
	if err != nil {
		return Change{}, err
	}
	onlyDone := text == nil && !input.AssigneeID.Set && input.Position == nil
	if onlyDone {
		if !a.perms.CanCheck(itemID) {
			mine := slices.ContainsFunc(a.task.Items, func(item Item) bool {
				return item.ID == itemID && item.AssigneeID != nil && *item.AssigneeID == user.ActorID
			})
			switch {
			case a.perms.ManageItems:
				return Change{}, ErrNotFound
			case !Active(a.t.Status) && (mine || a.worker()):
				return Change{}, ErrStatusInvalid
			default:
				return Change{}, ErrForbidden
			}
		}
	} else if err := a.requireManageItems(); err != nil {
		return Change{}, err
	}
	t := a.t
	var item lockedItem
	var doneAt *time.Time
	err = tx.QueryRow(ctx, `
		SELECT position, text, assignee_id, done_at FROM message_task_items
		WHERE org_id=$1 AND message_id=$2 AND id=$3 FOR UPDATE`, user.OrgID, messageID, itemID).Scan(&item.position, &item.text, &item.assigneeID, &doneAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return Change{}, ErrNotFound
	}
	if err != nil {
		return Change{}, fmt.Errorf("lock task item: %w", err)
	}
	item.done = doneAt != nil
	change := Change{ChatID: t.ChatID}
	changed := false
	now := s.Now()
	notices := noticeSet{}
	if text != nil && *text != item.text {
		if _, err := tx.Exec(ctx, `UPDATE message_task_items SET text=$2 WHERE id=$1`, itemID, *text); err != nil {
			return Change{}, fmt.Errorf("update task item text: %w", err)
		}
		changed = true
	}
	if input.AssigneeID.Set && !sameID(assignee, item.assigneeID) {
		if assignee != nil {
			if err := requireAssignable(ctx, tx, user.OrgID, t.ChatID, *assignee); err != nil {
				return Change{}, err
			}
			notices.add("item_assigned", *assignee)
		}
		if _, err := tx.Exec(ctx, `UPDATE message_task_items SET assignee_id=$2, assigned_at=CASE WHEN $2::uuid IS NULL THEN NULL ELSE $3::timestamptz END WHERE id=$1`,
			itemID, assignee, now); err != nil {
			return Change{}, fmt.Errorf("assign task item: %w", err)
		}
		changed = true
	}
	doneDelta := 0
	if input.Done != nil && *input.Done != item.done {
		if *input.Done {
			_, err = tx.Exec(ctx, `UPDATE message_task_items SET done_at=$2, done_by=$3 WHERE id=$1`, itemID, now, user.ActorID)
			doneDelta = 1
		} else {
			_, err = tx.Exec(ctx, `UPDATE message_task_items SET done_at=NULL, done_by=NULL WHERE id=$1`, itemID)
			doneDelta = -1
		}
		if err != nil {
			return Change{}, fmt.Errorf("check task item: %w", err)
		}
		changed = true
	}
	if input.Position != nil && *input.Position != item.position {
		target := *input.Position
		if target >= t.ItemsTotal {
			return Change{}, invalid("position", "position must be at most %d", t.ItemsTotal-1)
		}
		if _, err := tx.Exec(ctx, `SELECT 1 FROM message_task_items WHERE message_id=$1 FOR UPDATE`, messageID); err != nil {
			return Change{}, fmt.Errorf("lock task items: %w", err)
		}
		if target < item.position {
			_, err = tx.Exec(ctx, `UPDATE message_task_items SET position=position+1 WHERE message_id=$1 AND position>=$2 AND position<$3`, messageID, target, item.position)
		} else {
			_, err = tx.Exec(ctx, `UPDATE message_task_items SET position=position-1 WHERE message_id=$1 AND position>$2 AND position<=$3`, messageID, item.position, target)
		}
		if err != nil {
			return Change{}, fmt.Errorf("move task items: %w", err)
		}
		if _, err := tx.Exec(ctx, `UPDATE message_task_items SET position=$2 WHERE id=$1`, itemID, target); err != nil {
			return Change{}, fmt.Errorf("move task item: %w", err)
		}
		changed = true
	}
	if !changed {
		return change, nil
	}
	if err := tx.QueryRow(ctx, `
		UPDATE message_tasks SET items_done=items_done+$2, version=version+1, updated_at=$3
		WHERE message_id=$1 RETURNING version`, messageID, doneDelta, now).Scan(&t.Version); err != nil {
		return Change{}, fmt.Errorf("update task after item: %w", err)
	}
	seq, err := notices.write(ctx, tx, user.OrgID, user.ActorID, t.ChatID, messageID, t.DueAt)
	if err != nil {
		return Change{}, err
	}
	change.bump(seq)
	if seq, err = emitUpdated(ctx, tx, t, user.ActorID); err != nil {
		return Change{}, err
	}
	change.bump(seq)
	return change, nil
}

func sameID(left, right *string) bool {
	if left == nil || right == nil {
		return left == nil && right == nil
	}
	return *left == *right
}

// DeleteItemTx removes an item. An item that is not there is already
// removed: nothing happens.
func (s *Service) DeleteItemTx(ctx context.Context, tx pgx.Tx, user identity.User, messageID, itemID string) (Change, error) {
	a, err := s.begin(ctx, tx, user, messageID)
	if err != nil {
		return Change{}, err
	}
	if err := a.requireManageItems(); err != nil {
		return Change{}, err
	}
	t := a.t
	change := Change{ChatID: t.ChatID}
	if uuid.Validate(itemID) != nil {
		return change, nil
	}
	if _, err := tx.Exec(ctx, `SELECT 1 FROM message_task_items WHERE message_id=$1 FOR UPDATE`, messageID); err != nil {
		return Change{}, fmt.Errorf("lock task items: %w", err)
	}
	var position int
	var doneAt *time.Time
	err = tx.QueryRow(ctx, `DELETE FROM message_task_items WHERE org_id=$1 AND message_id=$2 AND id=$3 RETURNING position, done_at`,
		user.OrgID, messageID, itemID).Scan(&position, &doneAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return change, nil
	}
	if err != nil {
		return Change{}, fmt.Errorf("delete task item: %w", err)
	}
	if _, err := tx.Exec(ctx, `UPDATE message_task_items SET position=position-1 WHERE message_id=$1 AND position>$2`, messageID, position); err != nil {
		return Change{}, fmt.Errorf("shift task items: %w", err)
	}
	done := 0
	if doneAt != nil {
		done = 1
	}
	if err := tx.QueryRow(ctx, `
		UPDATE message_tasks SET items_total=items_total-1, items_done=items_done-$2, version=version+1, updated_at=$3
		WHERE message_id=$1 RETURNING version`, messageID, done, s.Now()).Scan(&t.Version); err != nil {
		return Change{}, fmt.Errorf("count task items: %w", err)
	}
	seq, err := emitUpdated(ctx, tx, t, user.ActorID)
	if err != nil {
		return Change{}, err
	}
	change.bump(seq)
	return change, nil
}

// NudgeResult is the reply of nudgeTask.
type NudgeResult struct {
	NextNudgeAt *time.Time `json:"next_nudge_at"`
}

// NudgeTx is «Напомнить»: the author or a chat admin reminds the
// responsible person, or the candidates of a queue nobody has taken.
func (s *Service) NudgeTx(ctx context.Context, tx pgx.Tx, user identity.User, messageID string) (NudgeResult, Change, error) {
	a, err := s.begin(ctx, tx, user, messageID)
	if err != nil {
		return NudgeResult{}, Change{}, err
	}
	t := a.t
	switch {
	case !a.manager():
		return NudgeResult{}, Change{}, ErrForbidden
	case !Active(t.Status):
		return NudgeResult{}, Change{}, ErrStatusInvalid
	case t.NudgeCount >= s.limits.NudgeMax:
		return NudgeResult{}, Change{}, ErrLimitReached
	case !a.perms.Nudge:
		return NudgeResult{}, Change{}, ErrForbidden
	}
	now := s.Now()
	if t.LastNudgeAt != nil {
		if next := t.LastNudgeAt.Add(s.limits.NudgeInterval); now.Before(next) {
			return NudgeResult{}, Change{}, &NudgeTooSoonError{RetryAfter: next.Sub(now)}
		}
	}
	targets, err := s.audienceInChat(ctx, tx, t, &user.ActorID)
	if err != nil {
		return NudgeResult{}, Change{}, err
	}
	// The daily limit counts every nudge a person got in the last 24 hours,
	// from all tasks; above it the notice still goes, without a push.
	rows, err := tx.Query(ctx, `
		SELECT target, (SELECT count(*) FROM message_task_nudge_log log
			WHERE log.org_id = $1 AND log.actor_id = target AND log.nudged_at > $3::timestamptz - interval '24 hours') < $4
		FROM unnest($2::uuid[]) AS target`, user.OrgID, targets, now, s.limits.DailyNudgesPerPerson)
	if err != nil {
		return NudgeResult{}, Change{}, fmt.Errorf("count task nudges: %w", err)
	}
	notices := noticeSet{}
	pushed := make([]string, 0, len(targets))
	for rows.Next() {
		var target string
		var push bool
		if err := rows.Scan(&target, &push); err != nil {
			rows.Close()
			return NudgeResult{}, Change{}, fmt.Errorf("scan task nudge: %w", err)
		}
		notices.addPush("nudged", target, push)
		if push {
			pushed = append(pushed, target)
		}
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return NudgeResult{}, Change{}, fmt.Errorf("iterate task nudges: %w", err)
	}
	if len(pushed) > 0 {
		if _, err := tx.Exec(ctx, `
			WITH expired AS (
				DELETE FROM message_task_nudge_log
				WHERE org_id = $1 AND actor_id = ANY($2::uuid[]) AND nudged_at <= $3::timestamptz - interval '24 hours'
			)
			INSERT INTO message_task_nudge_log (org_id, actor_id, nudged_at)
			SELECT $1, target, $3 FROM unnest($2::uuid[]) AS target`, user.OrgID, pushed, now); err != nil {
			return NudgeResult{}, Change{}, fmt.Errorf("log task nudges: %w", err)
		}
	}
	if err := tx.QueryRow(ctx, `
		UPDATE message_tasks SET last_nudge_at=$2, nudge_count=nudge_count+1, version=version+1, updated_at=$2
		WHERE message_id=$1 RETURNING version, nudge_count`, messageID, now).Scan(&t.Version, &t.NudgeCount); err != nil {
		return NudgeResult{}, Change{}, fmt.Errorf("record task nudge: %w", err)
	}
	change := Change{ChatID: t.ChatID}
	seq, err := notices.write(ctx, tx, user.OrgID, user.ActorID, t.ChatID, messageID, t.DueAt)
	if err != nil {
		return NudgeResult{}, Change{}, err
	}
	change.bump(seq)
	if seq, err = emitUpdated(ctx, tx, t, user.ActorID); err != nil {
		return NudgeResult{}, Change{}, err
	}
	change.bump(seq)
	result := NudgeResult{}
	if t.NudgeCount < s.limits.NudgeMax {
		next := now.Add(s.limits.NudgeInterval)
		result.NextNudgeAt = &next
	}
	return result, change, nil
}

// audienceInChat is whom a task concerns now: the responsible person, or
// the candidates of a queue nobody has taken, who are active members of the
// chat; except is left out.
func (s *Service) audienceInChat(ctx context.Context, tx pgx.Tx, t lockedTask, except *string) ([]string, error) {
	rows, err := tx.Query(ctx, `
		SELECT people.actor_id FROM (
			SELECT t.assignee_id AS actor_id FROM message_tasks t WHERE t.message_id = $2 AND t.assignee_id IS NOT NULL
			UNION
			SELECT c.actor_id FROM message_task_candidates c JOIN message_tasks t ON t.message_id = c.message_id
			WHERE c.message_id = $2 AND t.assignee_id IS NULL AND t.assignee_kind <> 'person'
		) people
		JOIN chat_members cm ON cm.org_id = $1 AND cm.chat_id = $3 AND cm.actor_id = people.actor_id
		JOIN actors a ON a.org_id = $1 AND a.id = people.actor_id AND a.type = 'user' AND a.status = 'active' AND a.deleted_at IS NULL
		WHERE $4::uuid IS NULL OR people.actor_id <> $4::uuid
		ORDER BY people.actor_id`, t.OrgID, t.MessageID, t.ChatID, except)
	if err != nil {
		return nil, fmt.Errorf("find task audience: %w", err)
	}
	return pgx.CollectRows(rows, pgx.RowTo[string])
}
