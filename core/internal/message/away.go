package message

import (
	"context"
	"fmt"

	"github.com/comamessenger/comamessenger/core/internal/id"
	"github.com/comamessenger/comamessenger/core/internal/identity"
	"github.com/jackc/pgx/v5"
)

// AwayHook runs inside the transaction of a new message a person wrote in a
// direct chat, after its message.created event («Отсутствую», phase 6.7):
// package away schedules the auto-reply of a recipient who is away. It is
// not called for agents' messages or for auto-replies themselves, so two
// away people never answer each other in a loop.
type AwayHook func(ctx context.Context, tx pgx.Tx, sender identity.User, chatID, messageID string) error

// SetAwayHook installs the hook; nil (tests, tools) sends no auto-replies.
func (s *Service) SetAwayHook(hook AwayHook) { s.awayHook = hook }

func (s *Service) afterDirectMessageTx(ctx context.Context, tx pgx.Tx, user identity.User, chatID, kind string, robot bool, input CreateInput, messageID string) error {
	if s.awayHook == nil || kind != "direct" || robot || input.autoReply {
		return nil
	}
	return s.awayHook(ctx, tx, user, chatID, messageID)
}

// CreateAutoReplyTx writes the auto-reply of author, who is away, into the
// direct chat inside the caller's transaction: their own plain-text message,
// silent, marked auto_reply. It goes through the ordinary send path
// (membership, permissions, the message.created event and its push), but it
// does not move the author's read cursor: sending never does. The caller
// commits and then wakes realtime with the returned high watermark.
func (s *Service) CreateAutoReplyTx(ctx context.Context, tx pgx.Tx, author identity.User, chatID, body string) (Message, int64, error) {
	clientMsgID, err := id.New()
	if err != nil {
		return Message{}, 0, fmt.Errorf("generate auto-reply client id: %w", err)
	}
	input := CreateInput{ClientMsgID: clientMsgID, Body: body, BodyFormat: "plain", Silent: true, autoReply: true}
	if err := s.validateCreate(chatID, &input); err != nil {
		return Message{}, 0, err
	}
	input.links = PrepareLinks(input.Body, input.BodyFormat)
	result, created, highWatermark, err := s.createTx(ctx, tx, author, chatID, input, nil, false)
	if err != nil {
		return Message{}, 0, err
	}
	if !created {
		return Message{}, 0, fmt.Errorf("auto-reply was not created")
	}
	if _, err := tx.Exec(ctx, `UPDATE messages SET auto_reply = true WHERE org_id = $1 AND id = $2`, author.OrgID, result.ID); err != nil {
		return Message{}, 0, fmt.Errorf("mark auto-reply: %w", err)
	}
	result.AutoReply = true
	return result, highWatermark, nil
}

// hydrateAutoReplies marks the auto-replies of the batch: Message.auto_reply
// in REST and in realtime frames (CompleteEventMessages).
func hydrateAutoReplies(ctx context.Context, tx pgx.Tx, orgID string, messages []Message) error {
	if len(messages) == 0 {
		return nil
	}
	ids := make([]string, len(messages))
	for index := range messages {
		ids[index] = messages[index].ID
	}
	rows, err := tx.Query(ctx, `SELECT id FROM messages WHERE org_id = $1 AND id = ANY($2::uuid[]) AND auto_reply`, orgID, ids)
	if err != nil {
		return fmt.Errorf("load auto-replies: %w", err)
	}
	defer rows.Close()
	marked := map[string]bool{}
	for rows.Next() {
		var messageID string
		if err := rows.Scan(&messageID); err != nil {
			return fmt.Errorf("scan auto-reply: %w", err)
		}
		marked[messageID] = true
	}
	if err := rows.Err(); err != nil {
		return fmt.Errorf("iterate auto-replies: %w", err)
	}
	for index := range messages {
		messages[index].AutoReply = marked[messages[index].ID]
	}
	return nil
}
