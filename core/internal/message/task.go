package message

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/comamessenger/comamessenger/core/internal/id"
	"github.com/comamessenger/comamessenger/core/internal/identity"
	"github.com/comamessenger/comamessenger/core/internal/task"
	"github.com/comamessenger/comamessenger/core/internal/wirejson"
	"github.com/jackc/pgx/v5"
)

// Tasks («Задача») are messages of type task. This file is the glue between
// the ordinary send path and package task: a task is written by createTx
// like any message, with task.notified events before it and the task rows
// after it, in the same transaction. Every other task write runs in package
// task inside a transaction opened here, so the reply carries the message
// as it is after the change.

// SetTasks enables task messages; without it the task methods fail with
// task.ErrUnavailable.
func (s *Service) SetTasks(tasks *task.Service) { s.tasks = tasks }

// Tasks returns the task service, nil when tasks are off.
func (s *Service) Tasks() *task.Service { return s.tasks }

// taskCreation travels with CreateInput through createTx.
type taskCreation struct {
	plan task.Plan
}

// CreateTaskInput is createTask.
type CreateTaskInput struct {
	ClientMsgID     string             `json:"client_msg_id"`
	Title           string             `json:"title"`
	Description     string             `json:"description"`
	Assignee        task.AssigneeInput `json:"assignee"`
	DueAt           *time.Time         `json:"due_at"`
	RemindBeforeDue *bool              `json:"remind_before_due"`
	Items           []task.ItemInput   `json:"items"`
	SourceMessageID *string            `json:"source_message_id"`
}

// CreateTask sends a task message. People only: agents and API keys are
// refused. Tasks go to the main feed of the chat, never into a thread. A
// replay with the same client_msg_id and content returns the original
// message with created false.
func (s *Service) CreateTask(ctx context.Context, user identity.User, chatID string, input CreateTaskInput) (Message, bool, error) {
	if s.tasks == nil {
		return Message{}, false, task.ErrUnavailable
	}
	if input.RemindBeforeDue == nil {
		return Message{}, false, &task.InvalidError{Field: "remind_before_due", Message: "remind_before_due is required"}
	}
	spec := task.CreateSpec{
		Title: input.Title, Description: input.Description, Assignee: input.Assignee, DueAt: input.DueAt,
		RemindBeforeDue: *input.RemindBeforeDue, Items: input.Items, SourceMessageID: input.SourceMessageID,
	}
	plan, err := task.Normalize(spec, s.tasks.Now())
	if errors.Is(err, task.ErrInvalid) {
		// A replay that arrives after its due date went stale is checked
		// against the moment it was first accepted.
		var createdAt time.Time
		if lookupErr := s.pool.QueryRow(ctx, `SELECT created_at FROM messages WHERE actor_id = $1 AND client_msg_id = $2 AND type = 'task'`,
			user.ActorID, input.ClientMsgID).Scan(&createdAt); lookupErr == nil {
			plan, err = task.Normalize(spec, createdAt)
		}
	}
	if err != nil {
		return Message{}, false, err
	}
	draft := CreateInput{
		ClientMsgID: input.ClientMsgID, Body: task.Body(plan.Title, plan.Description), BodyFormat: "markdown",
		task: &taskCreation{plan: plan},
	}
	if err := s.validateCreate(chatID, &draft); err != nil {
		return Message{}, false, err
	}
	draft.links = PrepareLinks(draft.Body, draft.BodyFormat)
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Message{}, false, fmt.Errorf("begin create task: %w", err)
	}
	defer tx.Rollback(ctx)
	result, created, highWatermark, err := s.createTx(ctx, tx, user, chatID, draft, nil, false)
	if err != nil {
		return Message{}, false, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Message{}, false, fmt.Errorf("commit create task: %w", err)
	}
	if created {
		s.notifyAfterCommit(user.OrgID, highWatermark)
	}
	return result, created, nil
}

// prepareTaskTx runs inside createTx under the organization lock, before
// the message is written.
func (s *Service) prepareTaskTx(ctx context.Context, tx pgx.Tx, user identity.User, chatID, messageID string, input CreateInput) (task.Prepared, error) {
	if input.ThreadRootID != nil || input.ReplyToID != nil || len(input.FileIDs) > 0 || input.Blocks != nil || input.Silent || len(input.MentionedActorIDs) > 0 || len(input.MentionedDepartmentIDs) > 0 {
		return task.Prepared{}, invalid("a task is a plain message of the main feed")
	}
	return s.tasks.PrepareTx(ctx, tx, user, chatID, messageID, input.task.plan)
}

// hydrateTasks fills Task on messages of type task, three queries per
// batch. Called by hydrateFiles, so every reader of messages, realtime
// frames included, gets it.
func hydrateTasks(ctx context.Context, tx pgx.Tx, orgID string, messages []Message) error {
	ids := make([]string, 0)
	for index := range messages {
		messages[index].Task = nil
		if messages[index].Type == "task" {
			ids = append(ids, messages[index].ID)
		}
	}
	if len(ids) == 0 {
		return nil
	}
	tasks, err := task.Load(ctx, tx, orgID, ids)
	if err != nil {
		return err
	}
	for index := range messages {
		if item, ok := tasks[messages[index].ID]; ok {
			messages[index].Task = item
		}
	}
	return nil
}

// hideTasksFromAgents drops Task from messages read by an agent: agents
// read a task as its text (body) only, decision 20 of phase 6.6.
func hideTasksFromAgents(ctx context.Context, tx pgx.Tx, user identity.User, messages []*Message) error {
	found := false
	for _, item := range messages {
		if item.Task != nil {
			found = true
			break
		}
	}
	if !found {
		return nil
	}
	var person bool
	if err := tx.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM actors WHERE org_id = $1 AND id = $2 AND type = 'user')`, user.OrgID, user.ActorID).Scan(&person); err != nil {
		return fmt.Errorf("check task reader: %w", err)
	}
	if !person {
		for _, item := range messages {
			item.Task = nil
		}
	}
	return nil
}

// HideTaskFromFrame removes task from a message.* frame payload, for
// agents among its recipients.
func HideTaskFromFrame(data json.RawMessage) (json.RawMessage, error) {
	var message Message
	if err := json.Unmarshal(data, &message); err != nil {
		return nil, fmt.Errorf("decode message event: %w", err)
	}
	message.Task = nil
	return wirejson.Marshal(message)
}

// loadMessages reads messages by id in the given order, with everything the
// feed shows (the request view of user included).
func (s *Service) loadMessages(ctx context.Context, tx pgx.Tx, user identity.User, ids []string) ([]Message, error) {
	if len(ids) == 0 {
		return []Message{}, nil
	}
	rows, err := tx.Query(ctx, `
		SELECT id, chat_id, actor_id, client_msg_id, type, body, body_format, reply_to_id,
			thread_root_id, version, created_seq, created_at, edited_at, deleted_at, forwarded_from, mentioned_actor_ids, blocks
		FROM messages WHERE org_id = $1 AND id = ANY($2::uuid[])`, user.OrgID, ids)
	if err != nil {
		return nil, fmt.Errorf("load messages: %w", err)
	}
	defer rows.Close()
	byID := make(map[string]Message, len(ids))
	for rows.Next() {
		var item Message
		if err := scanMessage(rows, &item); err != nil {
			return nil, fmt.Errorf("scan message: %w", err)
		}
		byID[item.ID] = item
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate messages: %w", err)
	}
	rows.Close()
	result := make([]Message, 0, len(ids))
	for _, messageID := range ids {
		if item, ok := byID[messageID]; ok {
			result = append(result, item)
		}
	}
	if err := hydrateThreadReplyCounts(ctx, tx, user.OrgID, result); err != nil {
		return nil, err
	}
	if err := hydrateFiles(ctx, tx, user.OrgID, result); err != nil {
		return nil, err
	}
	if err := s.hydrateRequestViewerSlice(ctx, tx, user, result); err != nil {
		return nil, err
	}
	return result, nil
}

func (s *Service) loadMessage(ctx context.Context, tx pgx.Tx, user identity.User, messageID string) (Message, error) {
	items, err := s.loadMessages(ctx, tx, user, []string{messageID})
	if err != nil {
		return Message{}, err
	}
	if len(items) == 0 {
		return Message{}, task.ErrNotFound
	}
	return items[0], nil
}

// GetTask returns the task message to anyone who can read it.
func (s *Service) GetTask(ctx context.Context, user identity.User, messageID string) (Message, error) {
	if s.tasks == nil {
		return Message{}, task.ErrUnavailable
	}
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{AccessMode: pgx.ReadOnly, IsoLevel: pgx.RepeatableRead})
	if err != nil {
		return Message{}, fmt.Errorf("begin get task: %w", err)
	}
	defer tx.Rollback(ctx)
	if err := task.Get(ctx, tx, user, messageID); err != nil {
		return Message{}, err
	}
	result, err := s.loadMessage(ctx, tx, user, messageID)
	if err != nil {
		return Message{}, err
	}
	return result, tx.Commit(ctx)
}

// taskWrite runs one task write in a transaction and commits it.
func (s *Service) taskWrite(ctx context.Context, user identity.User, write func(pgx.Tx) (task.Change, error), after func(pgx.Tx, task.Change) error) error {
	if s.tasks == nil {
		return task.ErrUnavailable
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("begin task write: %w", err)
	}
	defer tx.Rollback(ctx)
	change, err := write(tx)
	if err != nil {
		return err
	}
	if after != nil {
		if err := after(tx, change); err != nil {
			return err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("commit task write: %w", err)
	}
	s.notifyAfterCommit(user.OrgID, change.Seq)
	return nil
}

// UpdateTask changes a task; a new title or description rebuilds the
// message body (message.updated, edited_at).
func (s *Service) UpdateTask(ctx context.Context, user identity.User, messageID string, input task.UpdateInput) (Message, error) {
	var result Message
	err := s.taskWrite(ctx, user, func(tx pgx.Tx) (task.Change, error) {
		change, err := s.tasks.UpdateTx(ctx, tx, user, messageID, input)
		if err != nil || !change.TextChanged {
			return change, err
		}
		seq, err := s.rewriteTaskBody(ctx, tx, user, messageID, change)
		if seq > change.Seq {
			change.Seq = seq
		}
		return change, err
	}, func(tx pgx.Tx, _ task.Change) error {
		var err error
		result, err = s.loadMessage(ctx, tx, user, messageID)
		return err
	})
	return result, err
}

// rewriteTaskBody puts the new title and description into the message, as
// an edit by user: a revision, a new version, edited_at, message.updated.
func (s *Service) rewriteTaskBody(ctx context.Context, tx pgx.Tx, user identity.User, messageID string, change task.Change) (int64, error) {
	var current Message
	if err := scanMessage(tx.QueryRow(ctx, `
		SELECT id, chat_id, actor_id, client_msg_id, type, body, body_format, reply_to_id,
			thread_root_id, version, created_seq, created_at, edited_at, deleted_at, forwarded_from, mentioned_actor_ids, blocks
		FROM messages WHERE org_id = $1 AND id = $2`, user.OrgID, messageID), &current); err != nil {
		return 0, fmt.Errorf("read task message: %w", err)
	}
	body := task.Body(change.Title, change.Description)
	links := PrepareLinks(body, "markdown")
	revisionID, err := id.New()
	if err != nil {
		return 0, fmt.Errorf("generate revision id: %w", err)
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO message_revisions (id, org_id, message_id, version, body, body_format, edited_by, mentioned_actor_ids)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`, revisionID, user.OrgID, messageID, current.Version,
		current.Body, current.BodyFormat, user.ActorID, current.MentionedActorIDs); err != nil {
		return 0, fmt.Errorf("insert task revision: %w", err)
	}
	seq, err := nextSequence(ctx, tx, user.OrgID)
	if err != nil {
		return 0, err
	}
	var result Message
	if err := scanMessage(tx.QueryRow(ctx, `
		UPDATE messages SET body = $3, body_format = 'markdown', version = version + 1, edited_at = now()
		WHERE org_id = $1 AND id = $2
		RETURNING id, chat_id, actor_id, client_msg_id, type, body, body_format, reply_to_id,
			thread_root_id, version, created_seq, created_at, edited_at, deleted_at, forwarded_from, mentioned_actor_ids, blocks`,
		user.OrgID, messageID, body), &result); err != nil {
		return 0, fmt.Errorf("rewrite task body: %w", err)
	}
	if err := insertEvent(ctx, tx, user, result.ChatID, result.ID, seq, "message.updated"); err != nil {
		return 0, err
	}
	if err := syncMessageLinks(ctx, tx, user.OrgID, result, true, links); err != nil {
		return 0, err
	}
	return seq, nil
}

// SetTaskStatus moves a task to another status.
func (s *Service) SetTaskStatus(ctx context.Context, user identity.User, messageID string, input task.StatusInput) (Message, error) {
	return s.taskMessageWrite(ctx, user, messageID, func(tx pgx.Tx) (task.Change, error) {
		return s.tasks.SetStatusTx(ctx, tx, user, messageID, input)
	})
}

// TakeTask is «Взять себе».
func (s *Service) TakeTask(ctx context.Context, user identity.User, messageID string) (Message, error) {
	return s.taskMessageWrite(ctx, user, messageID, func(tx pgx.Tx) (task.Change, error) {
		return s.tasks.TakeTx(ctx, tx, user, messageID)
	})
}

func (s *Service) taskMessageWrite(ctx context.Context, user identity.User, messageID string, write func(pgx.Tx) (task.Change, error)) (Message, error) {
	var result Message
	err := s.taskWrite(ctx, user, write, func(tx pgx.Tx, _ task.Change) error {
		var err error
		result, err = s.loadMessage(ctx, tx, user, messageID)
		return err
	})
	return result, err
}

func (s *Service) taskOnlyWrite(ctx context.Context, user identity.User, messageID string, write func(pgx.Tx) (task.Change, error)) (*task.Task, error) {
	var result *task.Task
	err := s.taskWrite(ctx, user, write, func(tx pgx.Tx, _ task.Change) error {
		var err error
		result, err = task.LoadOne(ctx, tx, user.OrgID, messageID)
		return err
	})
	return result, err
}

// AddTaskItem adds a checklist item and returns the task.
func (s *Service) AddTaskItem(ctx context.Context, user identity.User, messageID string, input task.AddItemInput) (*task.Task, error) {
	return s.taskOnlyWrite(ctx, user, messageID, func(tx pgx.Tx) (task.Change, error) {
		return s.tasks.AddItemTx(ctx, tx, user, messageID, input)
	})
}

// UpdateTaskItem changes a checklist item and returns the task.
func (s *Service) UpdateTaskItem(ctx context.Context, user identity.User, messageID, itemID string, input task.UpdateItemInput) (*task.Task, error) {
	return s.taskOnlyWrite(ctx, user, messageID, func(tx pgx.Tx) (task.Change, error) {
		return s.tasks.UpdateItemTx(ctx, tx, user, messageID, itemID, input)
	})
}

// DeleteTaskItem removes a checklist item.
func (s *Service) DeleteTaskItem(ctx context.Context, user identity.User, messageID, itemID string) error {
	return s.taskWrite(ctx, user, func(tx pgx.Tx) (task.Change, error) {
		return s.tasks.DeleteItemTx(ctx, tx, user, messageID, itemID)
	}, nil)
}

// NudgeTask is «Напомнить».
func (s *Service) NudgeTask(ctx context.Context, user identity.User, messageID string) (task.NudgeResult, error) {
	var result task.NudgeResult
	err := s.taskWrite(ctx, user, func(tx pgx.Tx) (task.Change, error) {
		value, change, err := s.tasks.NudgeTx(ctx, tx, user, messageID)
		result = value
		return change, err
	}, nil)
	return result, err
}

// ChatTaskPage is listChatTasks.
type ChatTaskPage struct {
	Items      []Message       `json:"items"`
	Counts     task.ChatCounts `json:"counts"`
	NextCursor *string         `json:"next_cursor"`
}

// ListChatTasks lists the tasks of a chat for one of its members.
func (s *Service) ListChatTasks(ctx context.Context, user identity.User, chatID string, options task.ChatListOptions) (ChatTaskPage, error) {
	if s.tasks == nil {
		return ChatTaskPage{}, task.ErrUnavailable
	}
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{AccessMode: pgx.ReadOnly, IsoLevel: pgx.RepeatableRead})
	if err != nil {
		return ChatTaskPage{}, fmt.Errorf("begin list chat tasks: %w", err)
	}
	defer tx.Rollback(ctx)
	page, counts, err := task.ListChat(ctx, tx, user, chatID, options, s.tasks.Now())
	if err != nil {
		return ChatTaskPage{}, err
	}
	ids := make([]string, len(page.Rows))
	for index, row := range page.Rows {
		ids[index] = row.MessageID
	}
	items, err := s.loadMessages(ctx, tx, user, ids)
	if err != nil {
		return ChatTaskPage{}, err
	}
	return ChatTaskPage{Items: items, Counts: counts, NextCursor: page.NextCursor}, tx.Commit(ctx)
}

// MyTaskItem is one entry of listMyTasks.
type MyTaskItem struct {
	Message Message     `json:"message"`
	Author  SavedAuthor `json:"author"`
	Chat    SavedChat   `json:"chat"`
	MyRole  string      `json:"my_role"`
}

type MyTaskPage struct {
	Items      []MyTaskItem `json:"items"`
	NextCursor *string      `json:"next_cursor"`
}

// ListMyTasks lists the reader's tasks from all chats they can read now.
func (s *Service) ListMyTasks(ctx context.Context, user identity.User, options task.MineListOptions) (MyTaskPage, error) {
	if s.tasks == nil {
		return MyTaskPage{}, task.ErrUnavailable
	}
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{AccessMode: pgx.ReadOnly, IsoLevel: pgx.RepeatableRead})
	if err != nil {
		return MyTaskPage{}, fmt.Errorf("begin list my tasks: %w", err)
	}
	defer tx.Rollback(ctx)
	page, err := task.ListMine(ctx, tx, user, options, s.tasks.Now())
	if err != nil {
		return MyTaskPage{}, err
	}
	ids := make([]string, len(page.Rows))
	for index, row := range page.Rows {
		ids[index] = row.MessageID
	}
	messages, err := s.loadMessages(ctx, tx, user, ids)
	if err != nil {
		return MyTaskPage{}, err
	}
	contexts, err := s.messageContexts(ctx, tx, user, ids)
	if err != nil {
		return MyTaskPage{}, err
	}
	result := MyTaskPage{Items: make([]MyTaskItem, 0, len(messages)), NextCursor: page.NextCursor}
	for index, item := range messages {
		info := contexts[item.ID]
		result.Items = append(result.Items, MyTaskItem{Message: item, Author: info.author, Chat: info.chat, MyRole: page.Rows[index].Role})
	}
	return result, tx.Commit(ctx)
}

type messageContext struct {
	author SavedAuthor
	chat   SavedChat
}

// messageContexts reads the author and the chat (a direct chat named after
// the other person) of messages, for lists across chats.
func (s *Service) messageContexts(ctx context.Context, tx pgx.Tx, user identity.User, ids []string) (map[string]messageContext, error) {
	result := make(map[string]messageContext, len(ids))
	if len(ids) == 0 {
		return result, nil
	}
	rows, err := tx.Query(ctx, `
		SELECT m.id, author.id, author.display_name, author.type, author.avatar_version,
			c.id, c.kind, COALESCE(c.name, peer.display_name, 'Direct chat')
		FROM messages m
		JOIN actors author ON author.org_id = m.org_id AND author.id = m.actor_id
		JOIN chats c ON c.org_id = m.org_id AND c.id = m.chat_id
		LEFT JOIN LATERAL (
			SELECT a.display_name FROM chat_members other
			JOIN actors a ON a.org_id = other.org_id AND a.id = other.actor_id
			WHERE other.org_id = c.org_id AND other.chat_id = c.id AND other.actor_id <> $3
			LIMIT 1
		) peer ON c.kind = 'direct'
		WHERE m.org_id = $1 AND m.id = ANY($2::uuid[])`, user.OrgID, ids, user.ActorID)
	if err != nil {
		return nil, fmt.Errorf("load message contexts: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var messageID string
		var info messageContext
		if err := rows.Scan(&messageID, &info.author.ActorID, &info.author.DisplayName, &info.author.Type, &info.author.AvatarVersion,
			&info.chat.ID, &info.chat.Kind, &info.chat.DisplayName); err != nil {
			return nil, fmt.Errorf("scan message context: %w", err)
		}
		result[messageID] = info
	}
	return result, rows.Err()
}

// CompleteTaskEvents gives task.updated frames the task as it is when the
// frame is built: the event row keeps ids and the version only. A task
// whose message is gone for good gets no frame data change (the frame is
// dropped by the caller's visibility rules anyway).
func CompleteTaskEvents(ctx context.Context, tx pgx.Tx, orgID string, items []EventMessage) error {
	if len(items) == 0 {
		return nil
	}
	type stored struct {
		MessageID string `json:"message_id"`
		ChatID    string `json:"chat_id"`
	}
	decoded := make([]stored, len(items))
	ids := make([]string, 0, len(items))
	for index, item := range items {
		if err := json.Unmarshal(*item.Data, &decoded[index]); err != nil {
			return fmt.Errorf("decode task event: %w", err)
		}
		ids = append(ids, decoded[index].MessageID)
	}
	tasks, err := task.Load(ctx, tx, orgID, ids)
	if err != nil {
		return err
	}
	for index, item := range items {
		current := tasks[decoded[index].MessageID]
		if current == nil {
			continue
		}
		encoded, err := wirejson.Marshal(map[string]any{
			"message_id": decoded[index].MessageID, "chat_id": decoded[index].ChatID, "task": current,
		})
		if err != nil {
			return fmt.Errorf("encode task event: %w", err)
		}
		*item.Data = encoded
	}
	return nil
}
