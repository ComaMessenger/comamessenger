package message

import (
	"context"
	"fmt"
	"time"

	"github.com/comamessenger/comamessenger/core/internal/identity"
	"github.com/comamessenger/comamessenger/core/internal/poll"
	"github.com/comamessenger/comamessenger/core/internal/request"
	"github.com/comamessenger/comamessenger/core/internal/task"
	"github.com/jackc/pgx/v5"
)

// WaitingInboxItem is one entry of «Ждут вас» (listWaitingInbox).
type WaitingInboxItem struct {
	Kind    string           `json:"kind"`
	Message Message          `json:"message"`
	ChatID  string           `json:"chat_id"`
	Author  SavedAuthor      `json:"author"`
	Chat    SavedChat        `json:"chat"`
	DueAt   *time.Time       `json:"due_at"`
	Request *request.Summary `json:"request"`
	Viewer  *request.Viewer  `json:"viewer"`
	MyRole  *string          `json:"my_role"`
}

type WaitingInboxPage struct {
	Items      []WaitingInboxItem `json:"items"`
	NextCursor *string            `json:"next_cursor"`
}

type WaitingInboxOptions struct {
	Kind   string
	Cursor *string
	Limit  int
}

// WaitingInbox is «Ждут вас» as one list: open requests waiting for the
// reader's answer, open tasks the reader is concerned with and open polls
// with a due date the reader has not voted in, in chats they can read now
// (checked in the query, on every call). Items with a due date first,
// earliest first; then without one, newest first. A message is a request, a
// task or a poll, so (rank, key, message id) orders the kinds together
// without repeats.
func (s *Service) WaitingInbox(ctx context.Context, user identity.User, options WaitingInboxOptions) (WaitingInboxPage, error) {
	if s.tasks == nil || s.requests == nil {
		return WaitingInboxPage{}, task.ErrUnavailable
	}
	if options.Kind == "" {
		options.Kind = "all"
	}
	if options.Kind != "all" && options.Kind != "requests" && options.Kind != "tasks" && (options.Kind != "polls" || s.polls == nil) {
		return WaitingInboxPage{}, &task.InvalidError{Field: "kind", Message: "kind must be all, requests, tasks or polls"}
	}
	// Polls wait only with message_polls (decision 14: with a due date).
	withPolls := s.polls != nil
	limit := options.Limit
	if limit == 0 {
		limit = 50
	}
	if limit < 1 || limit > 100 {
		return WaitingInboxPage{}, &task.InvalidError{Field: "limit", Message: "limit must be between 1 and 100"}
	}
	var rank *int
	var key *int64
	var cursorID *string
	if options.Cursor != nil {
		decoded, err := task.DecodeCursor(*options.Cursor)
		if err != nil {
			return WaitingInboxPage{}, err
		}
		rank, key, cursorID = &decoded.Rank, &decoded.Key, &decoded.MessageID
	}
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{AccessMode: pgx.ReadOnly, IsoLevel: pgx.RepeatableRead})
	if err != nil {
		return WaitingInboxPage{}, fmt.Errorf("begin waiting inbox: %w", err)
	}
	defer tx.Rollback(ctx)
	rows, err := tx.Query(ctx, `
		WITH waiting AS (
			SELECT 'request'::text AS kind, m.id AS message_id, r.due_at, m.created_at, NULL::text AS role
			FROM message_request_recipients rr `+request.VisibleRecipientSQL+`
			WHERE rr.org_id = $1 AND rr.actor_id = $2 AND rr.request_open AND rr.answered_at IS NULL AND $3 IN ('all', 'requests')
			UNION ALL
			SELECT 'task', mine.message_id, mine.due_at, mine.created_at, mine.role
			FROM (`+task.MineSQL("$1", "$2")+`) mine
			WHERE $3 IN ('all', 'tasks')
			UNION ALL
			SELECT 'poll', pw.message_id, pw.due_at, pw.created_at, NULL
			FROM (`+poll.WaitingSQL("$1", "$2")+`) pw
			WHERE $3 IN ('all', 'polls') AND $8::boolean
		)
		SELECT `+task.OpenRank("due_at")+`, `+task.OpenKey("due_at", "created_at")+`, message_id, kind, role, due_at
		FROM waiting
		WHERE $4::int IS NULL OR (`+task.OpenRank("due_at")+`, `+task.OpenKey("due_at", "created_at")+`, message_id) > ($4::int, $5::bigint, $6::uuid)
		ORDER BY 1, 2, message_id
		LIMIT $7`, user.OrgID, user.ActorID, options.Kind, rank, key, cursorID, limit+1, withPolls)
	if err != nil {
		return WaitingInboxPage{}, fmt.Errorf("list waiting inbox: %w", err)
	}
	type entry struct {
		rank      int
		key       int64
		messageID string
		kind      string
		role      *string
		due       *time.Time
	}
	entries := make([]entry, 0, limit+1)
	for rows.Next() {
		var item entry
		if err := rows.Scan(&item.rank, &item.key, &item.messageID, &item.kind, &item.role, &item.due); err != nil {
			rows.Close()
			return WaitingInboxPage{}, fmt.Errorf("scan waiting inbox: %w", err)
		}
		entries = append(entries, item)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return WaitingInboxPage{}, fmt.Errorf("iterate waiting inbox: %w", err)
	}
	page := WaitingInboxPage{Items: make([]WaitingInboxItem, 0, limit)}
	if len(entries) > limit {
		entries = entries[:limit]
		last := entries[limit-1]
		value := task.EncodeCursor(task.Cursor{Rank: last.rank, Key: last.key, MessageID: last.messageID})
		page.NextCursor = &value
	}
	ids := make([]string, len(entries))
	for index, item := range entries {
		ids[index] = item.messageID
	}
	messages, err := s.loadMessages(ctx, tx, user, ids)
	if err != nil {
		return WaitingInboxPage{}, err
	}
	contexts, err := s.messageContexts(ctx, tx, user, ids)
	if err != nil {
		return WaitingInboxPage{}, err
	}
	byID := make(map[string]Message, len(messages))
	for _, item := range messages {
		byID[item.ID] = item
	}
	for _, item := range entries {
		message, ok := byID[item.messageID]
		if !ok {
			continue
		}
		info := contexts[item.messageID]
		result := WaitingInboxItem{
			Kind: item.kind, Message: message, ChatID: message.ChatID, Author: info.author, Chat: info.chat, DueAt: item.due,
		}
		switch item.kind {
		case "request":
			if message.Request == nil || message.RequestViewer == nil {
				continue
			}
			result.Request, result.Viewer = message.Request, message.RequestViewer
		case "poll":
			// The poll and the reader's view are message.poll and
			// message.poll_viewer.
			if message.Poll == nil || message.PollViewer == nil {
				continue
			}
		default:
			if message.Task == nil {
				continue
			}
			result.MyRole = item.role
		}
		page.Items = append(page.Items, result)
	}
	return page, tx.Commit(ctx)
}
