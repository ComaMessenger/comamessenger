package task

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/comamessenger/comamessenger/core/internal/identity"
	"github.com/comamessenger/comamessenger/core/internal/orgstructure"
	"github.com/comamessenger/comamessenger/core/internal/permission"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Lock order of every write here, the same as message deletion:
//
//	organization → messages row → message_tasks row → message_task_items rows
//
// The organization row comes first (message.lockOrganization), so a task
// write, a River job and a message deletion never wait for each other in
// opposite orders. Nothing here locks actors, chats or chat members.

// Jobs schedules and cancels the River jobs of tasks inside the caller's
// transaction. A job that runs after its task changed finds nothing to do,
// so a missing cancellation is never harmful.
type Jobs interface {
	ScheduleTx(ctx context.Context, tx pgx.Tx, kind, messageID string, at time.Time) (int64, error)
	CancelTx(ctx context.Context, tx pgx.Tx, jobID int64) error
}

// Job kinds.
const (
	KindDueSoon = "message_task.due_soon"
	KindOverdue = "message_task.overdue"
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

func (s *Service) SetJobs(jobs Jobs)             { s.jobs = jobs }
func (s *Service) SetLimits(limits Limits)       { s.limits = limits }
func (s *Service) SetClock(now func() time.Time) { s.now = now }
func (s *Service) Limits() Limits                { return s.limits }
func (s *Service) Now() time.Time                { return s.now().UTC().Truncate(time.Microsecond) }

func (s *Service) notify(orgID string, seq int64) {
	if s.afterCommit != nil && seq > 0 {
		s.afterCommit(orgID, seq)
	}
}

type querier interface {
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
	Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error)
}

// memberInChat: the person `alias` is an active member of the task's chat
// `t.chat_id` now.
func memberInChat(actorExpr string) string {
	return `EXISTS (SELECT 1 FROM chat_members icm
		JOIN actors ia ON ia.org_id = icm.org_id AND ia.id = icm.actor_id AND ia.status = 'active' AND ia.deleted_at IS NULL
		WHERE icm.org_id = t.org_id AND icm.chat_id = t.chat_id AND icm.actor_id = ` + actorExpr + `)`
}

// Load builds the tasks among messageIDs, three queries for the whole batch.
// Messages that are not tasks are absent from the result. in_chat, the
// source excerpt and whether the source is deleted are computed now. The
// task of a deleted message keeps its status but loses its texts: a deleted
// message has nothing left to show.
func Load(ctx context.Context, q querier, orgID string, messageIDs []string) (map[string]*Task, error) {
	result := make(map[string]*Task, len(messageIDs))
	if len(messageIDs) == 0 {
		return result, nil
	}
	rows, err := q.Query(ctx, `
		SELECT t.message_id, t.title, t.description, t.status, t.canceled_reason, t.status_changed_at,
			t.status_changed_by, t.assignee_kind, t.assignee_id, t.audience_department_id, t.audience_position_id,
			t.audience_label, t.due_at, t.remind_before_due, t.items_done, t.last_nudge_at, t.nudge_count, t.version,
			t.assignee_id IS NOT NULL AND `+memberInChat("t.assignee_id")+`,
			m.deleted_at IS NOT NULL,
			src.id, src.actor_id, src.deleted_at IS NOT NULL, left(src.body, 400)
		FROM message_tasks t
		JOIN messages m ON m.org_id = t.org_id AND m.id = t.message_id
		LEFT JOIN messages src ON src.org_id = t.org_id AND src.id = t.source_message_id
		WHERE t.org_id = $1 AND t.message_id = ANY($2::uuid[])`, orgID, messageIDs)
	if err != nil {
		return nil, fmt.Errorf("load tasks: %w", err)
	}
	defer rows.Close()
	deleted := map[string]bool{}
	for rows.Next() {
		var messageID, kind string
		var departmentID, positionID, sourceID, sourceAuthor, sourceBody *string
		var sourceDeleted *bool
		var messageDeleted bool
		item := &Task{Items: []Item{}}
		if err := rows.Scan(&messageID, &item.Title, &item.Description, &item.Status, &item.CanceledReason,
			&item.StatusChangedAt, &item.StatusChangedBy, &kind, &item.Assignee.ActorID, &departmentID, &positionID,
			&item.Assignee.Label, &item.DueAt, &item.RemindBeforeDue, &item.ItemsDone, &item.LastNudgeAt,
			&item.NudgeCount, &item.Version, &item.Assignee.InChat, &messageDeleted,
			&sourceID, &sourceAuthor, &sourceDeleted, &sourceBody); err != nil {
			return nil, fmt.Errorf("scan task: %w", err)
		}
		item.Assignee.Kind = kind
		item.Assignee.CandidateIDs = []string{}
		switch kind {
		case "department":
			item.Assignee.DepartmentID = OptionalID{Set: true, Value: departmentID}
		case "position":
			item.Assignee.PositionID = OptionalID{Set: true, Value: positionID}
		}
		if sourceID != nil && sourceAuthor != nil {
			item.Source = &Source{MessageID: *sourceID, AuthorID: *sourceAuthor, Deleted: sourceDeleted != nil && *sourceDeleted}
			if !item.Source.Deleted && sourceBody != nil {
				item.Source.Excerpt = truncateRunes(*sourceBody, MaxExcerptRunes)
			}
		}
		if messageDeleted {
			deleted[messageID] = true
			item.Title, item.Description, item.Source = "", "", nil
		}
		result[messageID] = item
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate tasks: %w", err)
	}
	rows.Close()
	if len(result) == 0 {
		return result, nil
	}
	candidates, err := q.Query(ctx, `
		SELECT message_id, actor_id FROM message_task_candidates
		WHERE org_id = $1 AND message_id = ANY($2::uuid[]) ORDER BY message_id, actor_id`, orgID, messageIDs)
	if err != nil {
		return nil, fmt.Errorf("load task candidates: %w", err)
	}
	for candidates.Next() {
		var messageID, actorID string
		if err := candidates.Scan(&messageID, &actorID); err != nil {
			candidates.Close()
			return nil, fmt.Errorf("scan task candidate: %w", err)
		}
		if item := result[messageID]; item != nil && item.Assignee.Kind != "person" {
			item.Assignee.CandidateIDs = append(item.Assignee.CandidateIDs, actorID)
		}
	}
	candidates.Close()
	if err := candidates.Err(); err != nil {
		return nil, fmt.Errorf("iterate task candidates: %w", err)
	}
	items, err := q.Query(ctx, `
		SELECT i.message_id, i.id, i.text, i.assignee_id, i.done_at, i.done_by,
			i.assignee_id IS NOT NULL AND `+memberInChat("i.assignee_id")+`
		FROM message_task_items i
		JOIN message_tasks t ON t.org_id = i.org_id AND t.message_id = i.message_id
		WHERE i.org_id = $1 AND i.message_id = ANY($2::uuid[])
		ORDER BY i.message_id, i.position`, orgID, messageIDs)
	if err != nil {
		return nil, fmt.Errorf("load task items: %w", err)
	}
	defer items.Close()
	for items.Next() {
		var messageID string
		var entry Item
		if err := items.Scan(&messageID, &entry.ID, &entry.Text, &entry.AssigneeID, &entry.DoneAt, &entry.DoneBy, &entry.AssigneeInChat); err != nil {
			return nil, fmt.Errorf("scan task item: %w", err)
		}
		if item := result[messageID]; item != nil && !deleted[messageID] {
			item.Items = append(item.Items, entry)
		}
	}
	if err := items.Err(); err != nil {
		return nil, fmt.Errorf("iterate task items: %w", err)
	}
	return result, nil
}

// LoadOne is Load for one message; ErrNotFound when it is not a task.
func LoadOne(ctx context.Context, q querier, orgID, messageID string) (*Task, error) {
	tasks, err := Load(ctx, q, orgID, []string{messageID})
	if err != nil {
		return nil, err
	}
	if tasks[messageID] == nil {
		return nil, ErrNotFound
	}
	return tasks[messageID], nil
}

// lockedTask is a task row under FOR UPDATE with its message and chat.
type lockedTask struct {
	OrgID, MessageID, ChatID, AuthorID string
	Title, Description                 string
	Kind                               string
	AssigneeID                         *string
	DepartmentID, PositionID           *string
	Label                              string
	Status                             string
	DueAt                              *time.Time
	RemindBeforeDue                    bool
	DueSoonJobID, OverdueJobID         *int64
	DueSoonSentAt, OverdueSentAt       *time.Time
	ItemsTotal, ItemsDone              int
	LastNudgeAt                        *time.Time
	NudgeCount                         int
	Version                            int
	MessageDeleted, ChatArchived       bool
}

// lockTask takes the message row and then the task row, the order of
// message deletion. The caller holds the organization lock.
func lockTask(ctx context.Context, tx pgx.Tx, orgID, messageID string) (lockedTask, error) {
	var exists bool
	if err := tx.QueryRow(ctx, `SELECT true FROM messages WHERE org_id = $1 AND id = $2 AND type = 'task' FOR NO KEY UPDATE`, orgID, messageID).Scan(&exists); errors.Is(err, pgx.ErrNoRows) {
		return lockedTask{}, ErrNotFound
	} else if err != nil {
		return lockedTask{}, fmt.Errorf("lock task message: %w", err)
	}
	var t lockedTask
	err := tx.QueryRow(ctx, `
		SELECT t.org_id, t.message_id, t.chat_id, t.author_id, t.title, t.description, t.assignee_kind, t.assignee_id,
			t.audience_department_id, t.audience_position_id, t.audience_label, t.status, t.due_at, t.remind_before_due,
			t.due_soon_job_id, t.overdue_job_id, t.due_soon_sent_at, t.overdue_sent_at, t.items_total, t.items_done,
			t.last_nudge_at, t.nudge_count, t.version, m.deleted_at IS NOT NULL, c.archived_at IS NOT NULL
		FROM message_tasks t
		JOIN messages m ON m.org_id = t.org_id AND m.id = t.message_id
		JOIN chats c ON c.org_id = t.org_id AND c.id = t.chat_id
		WHERE t.org_id = $1 AND t.message_id = $2
		FOR UPDATE OF t`, orgID, messageID).Scan(&t.OrgID, &t.MessageID, &t.ChatID, &t.AuthorID, &t.Title, &t.Description,
		&t.Kind, &t.AssigneeID, &t.DepartmentID, &t.PositionID, &t.Label, &t.Status, &t.DueAt, &t.RemindBeforeDue,
		&t.DueSoonJobID, &t.OverdueJobID, &t.DueSoonSentAt, &t.OverdueSentAt, &t.ItemsTotal, &t.ItemsDone,
		&t.LastNudgeAt, &t.NudgeCount, &t.Version, &t.MessageDeleted, &t.ChatArchived)
	if errors.Is(err, pgx.ErrNoRows) {
		return lockedTask{}, ErrNotFound
	}
	if err != nil {
		return lockedTask{}, fmt.Errorf("lock task: %w", err)
	}
	return t, nil
}

// readViewer reads the actor's standing in the chat from the database: the
// chat role while an active member, and chats.moderate from the stored role
// and grants, so a revoked admin or permission no longer counts.
func readViewer(ctx context.Context, q querier, user identity.User, chatID string) (Viewer, error) {
	viewer := Viewer{ActorID: user.ActorID}
	var role *string
	var orgRole string
	var stored []string
	err := q.QueryRow(ctx, `
		SELECT cm.role, a.org_role, ARRAY(SELECT permission FROM actor_permissions WHERE org_id = a.org_id AND actor_id = a.id)
		FROM actors a
		LEFT JOIN chat_members cm ON cm.org_id = a.org_id AND cm.chat_id = $3 AND cm.actor_id = a.id
		WHERE a.org_id = $1 AND a.id = $2 AND a.type = 'user' AND a.status = 'active' AND a.deleted_at IS NULL`,
		user.OrgID, user.ActorID, chatID).Scan(&role, &orgRole, &stored)
	if errors.Is(err, pgx.ErrNoRows) {
		return viewer, nil
	}
	if err != nil {
		return viewer, fmt.Errorf("read task viewer: %w", err)
	}
	if role == nil {
		return viewer, nil
	}
	viewer.Member, viewer.ChatRole = true, *role
	viewer.Moderator = permission.Allows(orgRole, storedCodes(orgRole, stored), permission.ChatsModerate)
	return viewer, nil
}

func storedCodes(role string, stored []string) []permission.Code {
	granted := make([]permission.Code, len(stored))
	for index, code := range stored {
		granted[index] = permission.Code(code)
	}
	return permission.Effective(role, granted)
}

// canAddressGroups reads requests.address_groups from the stored role and
// grants of the actor, not from the session.
func canAddressGroups(ctx context.Context, q querier, user identity.User) (bool, error) {
	var orgRole string
	var stored []string
	err := q.QueryRow(ctx, `
		SELECT org_role, ARRAY(SELECT permission FROM actor_permissions WHERE org_id = $1 AND actor_id = $2)
		FROM actors WHERE org_id = $1 AND id = $2 AND type = 'user' AND status = 'active' AND deleted_at IS NULL`,
		user.OrgID, user.ActorID).Scan(&orgRole, &stored)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, fmt.Errorf("read address groups permission: %w", err)
	}
	return permission.Allows(orgRole, storedCodes(orgRole, stored), permission.RequestsAddressGroups), nil
}

// assignablePeople returns those of actorIDs who are active people (not
// agents) and members of the chat now.
func assignablePeople(ctx context.Context, q querier, orgID, chatID string, actorIDs []string) (map[string]bool, error) {
	result := map[string]bool{}
	if len(actorIDs) == 0 {
		return result, nil
	}
	rows, err := q.Query(ctx, `
		SELECT a.id FROM chat_members cm
		JOIN actors a ON a.org_id = cm.org_id AND a.id = cm.actor_id
		WHERE cm.org_id = $1 AND cm.chat_id = $2 AND cm.actor_id = ANY($3::uuid[])
		  AND a.type = 'user' AND a.status = 'active' AND a.deleted_at IS NULL`, orgID, chatID, actorIDs)
	if err != nil {
		return nil, fmt.Errorf("check task assignees: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var actorID string
		if err := rows.Scan(&actorID); err != nil {
			return nil, fmt.Errorf("scan task assignee: %w", err)
		}
		result[actorID] = true
	}
	return result, rows.Err()
}

func requireAssignable(ctx context.Context, q querier, orgID, chatID string, actorIDs ...string) error {
	found, err := assignablePeople(ctx, q, orgID, chatID, actorIDs)
	if err != nil {
		return err
	}
	for _, actorID := range actorIDs {
		if !found[actorID] {
			return ErrAssigneeInvalid
		}
	}
	return nil
}

// resolvedAssignee is an assignee input turned into people under the
// organization lock.
type resolvedAssignee struct {
	Kind         string
	ActorID      *string
	DepartmentID *string
	PositionID   *string
	Label        string
	Candidates   []string
}

// resolveAssignee checks a person or builds a queue: the people of the
// department (with subdepartments, primary and additional members) or of
// the position who are active members of the chat, the author included.
// The caller holds the organization lock.
func (s *Service) resolveAssignee(ctx context.Context, tx pgx.Tx, user identity.User, chatID string, input AssigneeInput) (resolvedAssignee, error) {
	result := resolvedAssignee{Kind: input.Kind}
	if input.Kind == "person" {
		if err := requireAssignable(ctx, tx, user.OrgID, chatID, *input.ActorID); err != nil {
			return resolvedAssignee{}, err
		}
		result.ActorID = input.ActorID
		return result, nil
	}
	allowed, err := canAddressGroups(ctx, tx, user)
	if err != nil {
		return resolvedAssignee{}, err
	}
	if !allowed {
		return resolvedAssignee{}, ErrAudienceForbidden
	}
	var departments, positions []string
	var name string
	if input.Kind == "department" {
		err = tx.QueryRow(ctx, `SELECT name FROM departments WHERE org_id = $1 AND id = $2`, user.OrgID, *input.DepartmentID).Scan(&name)
		if errors.Is(err, pgx.ErrNoRows) {
			return resolvedAssignee{}, ErrDepartmentMissing
		}
		departments, result.DepartmentID = []string{*input.DepartmentID}, input.DepartmentID
	} else {
		err = tx.QueryRow(ctx, `SELECT name FROM positions WHERE org_id = $1 AND id = $2`, user.OrgID, *input.PositionID).Scan(&name)
		if errors.Is(err, pgx.ErrNoRows) {
			return resolvedAssignee{}, ErrPositionMissing
		}
		positions, result.PositionID = []string{*input.PositionID}, input.PositionID
	}
	if err != nil {
		return resolvedAssignee{}, fmt.Errorf("read task queue name: %w", err)
	}
	result.Label = truncateRunes(name, MaxLabelRunes)
	result.Candidates, err = orgstructure.Expand(ctx, tx, user.OrgID, departments, positions, chatID)
	if err != nil {
		return resolvedAssignee{}, err
	}
	switch {
	case len(result.Candidates) == 0:
		return resolvedAssignee{}, ErrAudienceEmpty
	case len(result.Candidates) > s.limits.MaxCandidates:
		return resolvedAssignee{}, ErrTooManyCandidates
	}
	return result, nil
}

// Prepared is the task part of a message being created, resolved under the
// organization lock before the message is written.
type Prepared struct {
	plan     Plan
	assignee resolvedAssignee
}

// PrepareTx runs inside the send transaction under the organization lock,
// before the message is written: it checks the limits, the responsible
// person or builds the queue, the item assignees and the source, and tells
// each person concerned (task.notified), so the notices precede
// message.created.
func (s *Service) PrepareTx(ctx context.Context, tx pgx.Tx, user identity.User, chatID, messageID string, plan Plan) (Prepared, error) {
	var person bool
	if err := tx.QueryRow(ctx, `SELECT type = 'user' FROM actors WHERE org_id = $1 AND id = $2`, user.OrgID, user.ActorID).Scan(&person); err != nil {
		return Prepared{}, fmt.Errorf("check task author: %w", err)
	}
	if !person {
		return Prepared{}, ErrForbidden
	}
	var openInChat, openByAuthor int
	if err := tx.QueryRow(ctx, `
		SELECT
			(SELECT count(*) FROM message_tasks WHERE org_id=$1 AND chat_id=$2 AND status IN ('open','in_progress')),
			(SELECT count(*) FROM message_tasks WHERE org_id=$1 AND author_id=$3 AND status IN ('open','in_progress'))`,
		user.OrgID, chatID, user.ActorID).Scan(&openInChat, &openByAuthor); err != nil {
		return Prepared{}, fmt.Errorf("count open tasks: %w", err)
	}
	if openInChat >= s.limits.OpenPerChat || openByAuthor >= s.limits.OpenPerAuthor {
		return Prepared{}, ErrLimitReached
	}
	assignee, err := s.resolveAssignee(ctx, tx, user, chatID, plan.Assignee)
	if err != nil {
		return Prepared{}, err
	}
	itemAssignees := make([]string, 0, len(plan.Items))
	for _, item := range plan.Items {
		if item.AssigneeID != nil {
			itemAssignees = append(itemAssignees, *item.AssigneeID)
		}
	}
	if err := requireAssignable(ctx, tx, user.OrgID, chatID, itemAssignees...); err != nil {
		return Prepared{}, err
	}
	if plan.SourceMessageID != nil {
		var ok bool
		if err := tx.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM messages WHERE org_id = $1 AND id = $2 AND chat_id = $3 AND deleted_at IS NULL)`,
			user.OrgID, *plan.SourceMessageID, chatID).Scan(&ok); err != nil {
			return Prepared{}, fmt.Errorf("check task source: %w", err)
		}
		if !ok {
			return Prepared{}, invalid("source_message_id", "the source must be a message of the same chat")
		}
	}
	notices := noticeSet{}
	if assignee.ActorID != nil {
		notices.add("assigned", *assignee.ActorID)
	}
	for _, candidate := range assignee.Candidates {
		notices.add("offered", candidate)
	}
	for _, actorID := range itemAssignees {
		notices.add("item_assigned", actorID)
	}
	if _, err := notices.write(ctx, tx, user.OrgID, user.ActorID, chatID, messageID, plan.DueAt); err != nil {
		return Prepared{}, err
	}
	return Prepared{plan: plan, assignee: assignee}, nil
}

// InsertTx stores the task of a just inserted message and schedules its
// jobs.
func (s *Service) InsertTx(ctx context.Context, tx pgx.Tx, user identity.User, chatID, messageID string, prepared Prepared) error {
	plan, assignee := prepared.plan, prepared.assignee
	now := s.Now()
	if _, err := tx.Exec(ctx, `
		INSERT INTO message_tasks (org_id, message_id, chat_id, author_id, title, description, source_message_id,
			assignee_kind, assignee_id, audience_department_id, audience_position_id, audience_label,
			due_at, remind_before_due, items_total, created_at, updated_at)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$16)`,
		user.OrgID, messageID, chatID, user.ActorID, plan.Title, plan.Description, plan.SourceMessageID,
		assignee.Kind, assignee.ActorID, assignee.DepartmentID, assignee.PositionID, assignee.Label,
		plan.DueAt, plan.RemindBeforeDue, len(plan.Items), now); err != nil {
		return fmt.Errorf("insert task: %w", err)
	}
	if len(assignee.Candidates) > 0 {
		if _, err := tx.Exec(ctx, `
			INSERT INTO message_task_candidates (org_id, message_id, actor_id)
			SELECT $1, $2, candidate FROM unnest($3::uuid[]) AS candidate`, user.OrgID, messageID, assignee.Candidates); err != nil {
			return fmt.Errorf("insert task candidates: %w", err)
		}
	}
	for index, item := range plan.Items {
		itemID, err := newID()
		if err != nil {
			return err
		}
		var assignedAt *time.Time
		if item.AssigneeID != nil {
			assignedAt = &now
		}
		if _, err := tx.Exec(ctx, `
			INSERT INTO message_task_items (id, org_id, message_id, position, text, assignee_id, assigned_at, created_by, created_at)
			VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, itemID, user.OrgID, messageID, index, item.Text, item.AssigneeID, assignedAt, user.ActorID, now); err != nil {
			return fmt.Errorf("insert task item: %w", err)
		}
	}
	current := lockedTask{
		OrgID: user.OrgID, MessageID: messageID, ChatID: chatID, AuthorID: user.ActorID, Status: StatusOpen,
		DueAt: plan.DueAt, RemindBeforeDue: plan.RemindBeforeDue,
	}
	return s.rescheduleTx(ctx, tx, &current, now)
}

// rescheduleTx cancels the jobs of the task and schedules new ones for its
// current due date: overdue at due_at while it is ahead, due_soon an hour
// before when the reminder is on and that moment is ahead. The sent marks
// are cleared. It writes the job ids to the row.
func (s *Service) rescheduleTx(ctx context.Context, tx pgx.Tx, t *lockedTask, now time.Time) error {
	if err := s.cancelJobs(ctx, tx, t); err != nil {
		return err
	}
	t.DueSoonJobID, t.OverdueJobID, t.DueSoonSentAt, t.OverdueSentAt = nil, nil, nil, nil
	if s.jobs != nil && Active(t.Status) && t.DueAt != nil && t.DueAt.After(now) {
		jobID, err := s.jobs.ScheduleTx(ctx, tx, KindOverdue, t.MessageID, *t.DueAt)
		if err != nil {
			return fmt.Errorf("schedule task overdue: %w", err)
		}
		t.OverdueJobID = &jobID
		if t.RemindBeforeDue {
			if at := t.DueAt.Add(-RemindBefore); at.After(now) {
				jobID, err := s.jobs.ScheduleTx(ctx, tx, KindDueSoon, t.MessageID, at)
				if err != nil {
					return fmt.Errorf("schedule task reminder: %w", err)
				}
				t.DueSoonJobID = &jobID
			}
		}
	}
	if _, err := tx.Exec(ctx, `
		UPDATE message_tasks SET due_soon_job_id=$2, overdue_job_id=$3, due_soon_sent_at=NULL, overdue_sent_at=NULL
		WHERE message_id=$1`, t.MessageID, t.DueSoonJobID, t.OverdueJobID); err != nil {
		return fmt.Errorf("record task jobs: %w", err)
	}
	return nil
}

func (s *Service) cancelJobs(ctx context.Context, tx pgx.Tx, t *lockedTask) error {
	if s.jobs == nil {
		return nil
	}
	for _, jobID := range []*int64{t.DueSoonJobID, t.OverdueJobID} {
		if jobID != nil {
			if err := s.jobs.CancelTx(ctx, tx, *jobID); err != nil {
				return fmt.Errorf("cancel task job: %w", err)
			}
		}
	}
	return nil
}

// OnMessageDeletedTx cancels the task of a message deleted in tx and its
// jobs. The caller holds the organization lock and the message row
// (message.Service.Delete): the order every task write follows. A message
// that is not a task, or a task already closed, is left alone (its jobs are
// gone with the close). service may be nil (tests, tools without jobs):
// stale jobs then find a canceled task.
func OnMessageDeletedTx(ctx context.Context, tx pgx.Tx, service *Service, user identity.User, messageID string) error {
	current, err := lockTask(ctx, tx, user.OrgID, messageID)
	if errors.Is(err, ErrNotFound) {
		return nil
	}
	if err != nil {
		return err
	}
	if !Active(current.Status) {
		return nil
	}
	if err := tx.QueryRow(ctx, `
		UPDATE message_tasks SET status='canceled', canceled_reason='message_deleted', status_changed_by=$2,
			status_changed_at=now(), version=version+1, updated_at=now(), due_soon_job_id=NULL, overdue_job_id=NULL
		WHERE message_id=$1 RETURNING version`, messageID, user.ActorID).Scan(&current.Version); err != nil {
		return fmt.Errorf("cancel task of deleted message: %w", err)
	}
	if service != nil {
		if err := service.cancelJobs(ctx, tx, &current); err != nil {
			return err
		}
	}
	_, err = emitUpdated(ctx, tx, current, user.ActorID)
	return err
}

// Events. task.updated stores ids and the version only: the frame gets the
// task as it is when the frame is built (message.CompleteTaskEvents), so the
// events table never keeps a task's texts and a replay never shows the
// texts of a task deleted since. task.notified never carries texts at all.

type updatedEvent struct {
	MessageID string `json:"message_id"`
	ChatID    string `json:"chat_id"`
	Version   int    `json:"version"`
}

type notifiedEvent struct {
	MessageID string     `json:"message_id"`
	ChatID    string     `json:"chat_id"`
	Kind      string     `json:"kind"`
	ByActorID *string    `json:"by_actor_id"`
	DueAt     *time.Time `json:"due_at"`
}

// emitUpdated writes task.updated to the whole chat. actorID is the actor
// of the change (the author for the server's own changes).
func emitUpdated(ctx context.Context, tx pgx.Tx, t lockedTask, actorID string) (int64, error) {
	seq, err := nextSequence(ctx, tx, t.OrgID)
	if err != nil {
		return 0, err
	}
	payload, err := json.Marshal(updatedEvent{MessageID: t.MessageID, ChatID: t.ChatID, Version: t.Version})
	if err != nil {
		return 0, err
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO events (org_id, seq, type, actor_id, chat_id, subject_id, data)
		VALUES ($1, $2, 'task.updated', $3, $4, $5, $6::jsonb)`, t.OrgID, seq, actorID, t.ChatID, t.MessageID, string(payload)); err != nil {
		return 0, fmt.Errorf("insert task.updated: %w", err)
	}
	return seq, nil
}

// noticeSet collects task.notified events, one per person: the first kind
// a person gets in one action wins (assigned before item_assigned).
type noticeSet struct {
	order []notice
	seen  map[string]bool
}

type notice struct {
	kind, actorID string
	push          bool
}

func (n *noticeSet) add(kind, actorID string) { n.addPush(kind, actorID, kind != "unassigned") }

func (n *noticeSet) addPush(kind, actorID string, push bool) {
	if n.seen == nil {
		n.seen = map[string]bool{}
	}
	if n.seen[actorID] {
		return
	}
	n.seen[actorID] = true
	n.order = append(n.order, notice{kind: kind, actorID: actorID, push: push})
}

// write inserts the notices, skipping the actor, with one sequence range;
// a push job goes with each one that is pushed. by is nil for the server's
// own notices (due_soon, overdue); then actorID is the task's author.
func (n *noticeSet) write(ctx context.Context, tx pgx.Tx, orgID, actorID, chatID, messageID string, due *time.Time) (int64, error) {
	return n.writeBy(ctx, tx, orgID, actorID, &actorID, chatID, messageID, due)
}

func (n *noticeSet) writeBy(ctx context.Context, tx pgx.Tx, orgID, actorID string, by *string, chatID, messageID string, due *time.Time) (int64, error) {
	targets := make([]notice, 0, len(n.order))
	for _, item := range n.order {
		if by != nil && item.actorID == *by {
			continue
		}
		targets = append(targets, item)
	}
	if len(targets) == 0 {
		return 0, nil
	}
	var last int64
	if err := tx.QueryRow(ctx, `UPDATE organizations SET event_seq = event_seq + $2 WHERE id = $1 RETURNING event_seq`, orgID, len(targets)).Scan(&last); err != nil {
		return 0, fmt.Errorf("allocate task event sequences: %w", err)
	}
	first := last - int64(len(targets)) + 1
	audiences, payloads, pushed := make([]string, len(targets)), make([]string, len(targets)), make([]int64, 0, len(targets))
	for index, item := range targets {
		payload, err := json.Marshal(notifiedEvent{MessageID: messageID, ChatID: chatID, Kind: item.kind, ByActorID: by, DueAt: due})
		if err != nil {
			return 0, err
		}
		audiences[index], payloads[index] = item.actorID, string(payload)
		if item.push {
			pushed = append(pushed, first+int64(index))
		}
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO events (org_id, seq, type, actor_id, chat_id, subject_id, audience_actor_id, data)
		SELECT $1, $2 + ordinality - 1, 'task.notified', $3, $4, $5, target.audience, target.payload::jsonb
		FROM unnest($6::uuid[], $7::text[]) WITH ORDINALITY AS target(audience, payload, ordinality)`,
		orgID, first, actorID, chatID, messageID, audiences, payloads); err != nil {
		return 0, fmt.Errorf("insert task.notified: %w", err)
	}
	if len(pushed) > 0 {
		if _, err := tx.Exec(ctx, `INSERT INTO notification_jobs (org_id, event_seq) SELECT $1, unnest($2::bigint[]) ON CONFLICT DO NOTHING`, orgID, pushed); err != nil {
			return 0, fmt.Errorf("enqueue task notifications: %w", err)
		}
	}
	return last, nil
}

func nextSequence(ctx context.Context, tx pgx.Tx, orgID string) (int64, error) {
	var seq int64
	if err := tx.QueryRow(ctx, `UPDATE organizations SET event_seq = event_seq + 1 WHERE id = $1 RETURNING event_seq`, orgID).Scan(&seq); err != nil {
		return 0, fmt.Errorf("allocate event sequence: %w", err)
	}
	return seq, nil
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
