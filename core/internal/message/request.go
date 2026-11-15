package message

import (
	"context"
	"encoding/base64"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/comamessenger/comamessenger/core/internal/identity"
	"github.com/comamessenger/comamessenger/core/internal/request"
	"github.com/jackc/pgx/v5"
)

// Requests («Запрос») are messages of type request. This file is the glue
// between the ordinary send path and package request: a request is written
// by createTx like any message, with request.assigned events before it and
// the request rows after it, in the same transaction.

// SetRequests enables request messages; without it CreateRequest fails.
func (s *Service) SetRequests(requests *request.Service) { s.requests = requests }

// requestCreation travels with CreateInput through createTx.
type requestCreation struct {
	plan request.Plan
}

// CreateRequestInput is createRequest: the message part and the request part.
type CreateRequestInput struct {
	ClientMsgID       string                `json:"client_msg_id"`
	Body              string                `json:"body"`
	BodyFormat        string                `json:"body_format"`
	MentionedActorIDs []string              `json:"mentioned_actor_ids"`
	Audience          request.AudienceInput `json:"audience"`
	Answer            request.AnswerSpec    `json:"answer"`
	AllowComment      *bool                 `json:"allow_comment"`
	DueAt             *time.Time            `json:"due_at"`
	AutoRemind        bool                  `json:"auto_remind"`
}

// CreateRequest sends a request message. People only: agents and API keys
// are refused. Requests go to the main feed of the chat, never into a
// thread. A replay with the same client_msg_id and content returns the
// original message with created false.
func (s *Service) CreateRequest(ctx context.Context, user identity.User, chatID string, input CreateRequestInput) (Message, bool, error) {
	if s.requests == nil {
		return Message{}, false, request.ErrUnavailable
	}
	plan, err := request.Normalize(request.CreateSpec{
		Audience: input.Audience, Answer: input.Answer, AllowComment: input.AllowComment,
		DueAt: input.DueAt, AutoRemind: input.AutoRemind,
	}, s.requests.Now())
	if err != nil {
		return Message{}, false, err
	}
	draft := CreateInput{
		ClientMsgID: input.ClientMsgID, Body: input.Body, BodyFormat: input.BodyFormat,
		MentionedActorIDs: input.MentionedActorIDs,
		request:           &requestCreation{plan: plan},
	}
	if err := s.validateCreate(chatID, &draft); err != nil {
		return Message{}, false, err
	}
	draft.links = PrepareLinks(draft.Body, draft.BodyFormat)
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Message{}, false, fmt.Errorf("begin create request: %w", err)
	}
	defer tx.Rollback(ctx)
	result, created, highWatermark, err := s.createTx(ctx, tx, user, chatID, draft, nil, false)
	if err != nil {
		return Message{}, false, err
	}
	if err := s.hydrateRequestViewers(ctx, tx, user, []*Message{&result}); err != nil {
		return Message{}, false, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Message{}, false, fmt.Errorf("commit create request: %w", err)
	}
	if created {
		s.notifyAfterCommit(user.OrgID, highWatermark)
	}
	return result, created, nil
}

// prepareRequestTx runs inside createTx under the organization lock, before
// the message is written: it fixes the list of recipients and tells each of
// them, so request.assigned precedes message.created.
func (s *Service) prepareRequestTx(ctx context.Context, tx pgx.Tx, user identity.User, chatID, messageID string, input CreateInput) (request.Recipients, error) {
	if input.ThreadRootID != nil || input.ReplyToID != nil || len(input.FileIDs) > 0 || input.Blocks != nil || input.Silent {
		return request.Recipients{}, invalid("a request is a plain message of the main feed")
	}
	// Requests are asked by people, whatever path the call took.
	var person bool
	if err := tx.QueryRow(ctx, `SELECT type = 'user' FROM actors WHERE org_id = $1 AND id = $2`, user.OrgID, user.ActorID).Scan(&person); err != nil {
		return request.Recipients{}, fmt.Errorf("check request author: %w", err)
	}
	if !person {
		return request.Recipients{}, ErrForbidden
	}
	recipients, err := s.requests.ResolveTx(ctx, tx, user, chatID, input.request.plan)
	if err != nil {
		return request.Recipients{}, err
	}
	if err := request.AssignTx(ctx, tx, user, chatID, messageID, input.request.plan, recipients); err != nil {
		return request.Recipients{}, err
	}
	return recipients, nil
}

// hydrateRequests fills Request, the part every reader shares, on messages
// of type request: one query per batch. Called by hydrateFiles, so every
// reader of messages, realtime frames included, gets it.
func hydrateRequests(ctx context.Context, tx pgx.Tx, orgID string, messages []Message) error {
	ids := make([]string, 0)
	for index := range messages {
		messages[index].Request = nil
		if messages[index].Type == "request" {
			ids = append(ids, messages[index].ID)
		}
	}
	if len(ids) == 0 {
		return nil
	}
	summaries, err := request.Summaries(ctx, tx, orgID, ids)
	if err != nil {
		return err
	}
	for index := range messages {
		if summary, ok := summaries[messages[index].ID]; ok {
			messages[index].Request = summary
		}
	}
	return nil
}

// hydrateRequestViewers fills RequestViewer for the reading person: REST
// only, never in realtime frames, which the whole chat shares.
func (s *Service) hydrateRequestViewers(ctx context.Context, tx pgx.Tx, user identity.User, messages []*Message) error {
	if s.requests == nil {
		return nil
	}
	ids := make([]string, 0)
	for _, item := range messages {
		if item.Type == "request" && item.Request != nil {
			ids = append(ids, item.ID)
		}
	}
	if len(ids) == 0 {
		return nil
	}
	viewers, err := request.Viewers(ctx, tx, user, s.requests.Now(), s.requests.Limits(), ids)
	if err != nil {
		return err
	}
	for _, item := range messages {
		if viewer, ok := viewers[item.ID]; ok {
			item.RequestViewer = viewer
		}
	}
	return nil
}

func (s *Service) hydrateRequestViewerSlice(ctx context.Context, tx pgx.Tx, user identity.User, messages []Message) error {
	pointers := make([]*Message, len(messages))
	for index := range messages {
		pointers[index] = &messages[index]
	}
	return s.hydrateRequestViewers(ctx, tx, user, pointers)
}

// RequestInboxItem is one entry of «Ждут вас».
type RequestInboxItem struct {
	Message Message         `json:"message"`
	ChatID  string          `json:"chat_id"`
	Author  SavedAuthor     `json:"author"`
	Chat    SavedChat       `json:"chat"`
	Request request.Summary `json:"request"`
	Viewer  request.Viewer  `json:"viewer"`
}

type RequestInboxPage struct {
	Items      []RequestInboxItem `json:"items"`
	NextCursor *string            `json:"next_cursor"`
}

type RequestInboxOptions struct {
	State  string
	Cursor *string
	Limit  int
}

// inboxCursor is a position in one person's inbox: the rank and key of
// the ordering below and the message id.
type inboxCursor struct {
	rank      int
	key       int64
	messageID string
}

func encodeInboxCursor(c inboxCursor) string {
	raw := strconv.Itoa(c.rank) + "." + strconv.FormatInt(c.key, 10) + "." + c.messageID
	return base64.RawURLEncoding.EncodeToString([]byte(raw))
}

func decodeInboxCursor(value string) (inboxCursor, error) {
	raw, err := base64.RawURLEncoding.DecodeString(value)
	parts := strings.SplitN(string(raw), ".", 3)
	if err != nil || len(parts) != 3 {
		return inboxCursor{}, fmt.Errorf("%w: cursor is malformed", ErrInvalid)
	}
	rank, rankErr := strconv.Atoi(parts[0])
	key, keyErr := strconv.ParseInt(parts[1], 10, 64)
	if rankErr != nil || keyErr != nil || (rank != 0 && rank != 1) || validateUUID("cursor", parts[2]) != nil {
		return inboxCursor{}, fmt.Errorf("%w: cursor is malformed", ErrInvalid)
	}
	return inboxCursor{rank: rank, key: key, messageID: parts[2]}, nil
}

// RequestInbox lists «Ждут вас»: open requests addressed to the person in
// chats they can read now. waiting: requests with a due date first, earliest
// first, then the rest, newest first. answered: latest answer first.
func (s *Service) RequestInbox(ctx context.Context, user identity.User, options RequestInboxOptions) (RequestInboxPage, error) {
	if s.requests == nil {
		return RequestInboxPage{}, request.ErrUnavailable
	}
	if options.State == "" {
		options.State = "waiting"
	}
	if options.State != "waiting" && options.State != "answered" {
		return RequestInboxPage{}, fmt.Errorf("%w: state must be waiting or answered", ErrInvalid)
	}
	limit := options.Limit
	if limit == 0 {
		limit = 50
	}
	if limit < 1 || limit > 100 {
		return RequestInboxPage{}, fmt.Errorf("%w: limit must be between 1 and 100", ErrInvalid)
	}
	var cursorRank *int
	var cursorKey *int64
	var cursorID *string
	if options.Cursor != nil {
		decoded, err := decodeInboxCursor(*options.Cursor)
		if err != nil {
			return RequestInboxPage{}, err
		}
		cursorRank, cursorKey, cursorID = &decoded.rank, &decoded.key, &decoded.messageID
	}
	// One ascending order (rank, key, id) for both lists. waiting: rank 0
	// holds requests with a due date, earliest first; rank 1 the rest,
	// newest first (negated creation time). answered: latest answer first.
	const rankExpr = `CASE WHEN $3 = 'waiting' AND r.due_at IS NULL THEN 1 ELSE 0 END`
	const keyExpr = `(CASE WHEN $3 = 'answered' THEN -extract(epoch FROM rr.answered_at)
		WHEN r.due_at IS NULL THEN -extract(epoch FROM m.created_at) ELSE extract(epoch FROM r.due_at) END * 1000000)::bigint`
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{AccessMode: pgx.ReadOnly, IsoLevel: pgx.RepeatableRead})
	if err != nil {
		return RequestInboxPage{}, fmt.Errorf("begin list request inbox: %w", err)
	}
	defer tx.Rollback(ctx)
	rows, err := tx.Query(ctx, `
		SELECT `+rankExpr+`, `+keyExpr+`,
			m.id, m.chat_id, m.actor_id, m.client_msg_id, m.type, m.body, m.body_format, m.reply_to_id,
			m.thread_root_id, m.version, m.created_seq, m.created_at, m.edited_at, m.deleted_at, m.forwarded_from,
			m.mentioned_actor_ids, m.blocks,
			author.id, author.display_name, author.type, author.avatar_version,
			c.id, c.kind, COALESCE(c.name, peer.display_name, 'Direct chat')
		FROM message_request_recipients rr `+request.VisibleRecipientSQL+`
		JOIN actors author ON author.org_id = m.org_id AND author.id = m.actor_id
		LEFT JOIN LATERAL (
			SELECT a.display_name FROM chat_members other
			JOIN actors a ON a.org_id = other.org_id AND a.id = other.actor_id
			WHERE other.org_id = c.org_id AND other.chat_id = c.id AND other.actor_id <> rr.actor_id
			LIMIT 1
		) peer ON c.kind = 'direct'
		WHERE rr.org_id = $1 AND rr.actor_id = $2
		  AND (rr.answered_at IS NOT NULL) = ($3 = 'answered')
		  AND ($4::int IS NULL OR (`+rankExpr+`, `+keyExpr+`, m.id) > ($4::int, $5::bigint, $6::uuid))
		ORDER BY `+rankExpr+`, `+keyExpr+`, m.id
		LIMIT $7`, user.OrgID, user.ActorID, options.State, cursorRank, cursorKey, cursorID, limit+1)
	if err != nil {
		return RequestInboxPage{}, fmt.Errorf("list request inbox: %w", err)
	}
	defer rows.Close()
	type position struct {
		rank int
		key  int64
	}
	items := make([]RequestInboxItem, 0, limit)
	positions := make([]position, 0, limit)
	for rows.Next() {
		var item RequestInboxItem
		var pos position
		m := &item.Message
		if err := rows.Scan(&pos.rank, &pos.key,
			&m.ID, &m.ChatID, &m.ActorID, &m.ClientMsgID, &m.Type, &m.Body, &m.BodyFormat, &m.ReplyToID,
			&m.ThreadRootID, &m.Version, &m.CreatedSeq, &m.CreatedAt, &m.EditedAt, &m.DeletedAt,
			newJSONScanner(&m.ForwardedFrom), &m.MentionedActorIDs, newJSONScanner(&m.Blocks),
			&item.Author.ActorID, &item.Author.DisplayName, &item.Author.Type, &item.Author.AvatarVersion,
			&item.Chat.ID, &item.Chat.Kind, &item.Chat.DisplayName); err != nil {
			return RequestInboxPage{}, fmt.Errorf("scan request inbox item: %w", err)
		}
		item.ChatID = m.ChatID
		items = append(items, item)
		positions = append(positions, pos)
	}
	if err := rows.Err(); err != nil {
		return RequestInboxPage{}, fmt.Errorf("iterate request inbox: %w", err)
	}
	rows.Close()
	var next *string
	if len(items) > limit {
		items = items[:limit]
		last := positions[limit-1]
		value := encodeInboxCursor(inboxCursor{rank: last.rank, key: last.key, messageID: items[limit-1].Message.ID})
		next = &value
	}
	messages := make([]Message, len(items))
	for index := range items {
		messages[index] = items[index].Message
	}
	if err := hydrateThreadReplyCounts(ctx, tx, user.OrgID, messages); err != nil {
		return RequestInboxPage{}, err
	}
	if err := hydrateFiles(ctx, tx, user.OrgID, messages); err != nil {
		return RequestInboxPage{}, err
	}
	if err := s.hydrateRequestViewerSlice(ctx, tx, user, messages); err != nil {
		return RequestInboxPage{}, err
	}
	result := make([]RequestInboxItem, 0, len(items))
	for index := range items {
		message := messages[index]
		if message.Request == nil || message.RequestViewer == nil {
			continue
		}
		item := items[index]
		item.Request, item.Viewer = *message.Request, *message.RequestViewer
		item.Message = message
		result = append(result, item)
	}
	if err := tx.Commit(ctx); err != nil {
		return RequestInboxPage{}, fmt.Errorf("commit list request inbox: %w", err)
	}
	return RequestInboxPage{Items: result, NextCursor: next}, nil
}
