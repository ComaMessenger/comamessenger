package message

import (
	"context"
	"fmt"

	"github.com/comamessenger/comamessenger/core/internal/identity"
)

// ReadableMessage is a message with its author and chat, as «Important»
// shows it (SavedMessage without saved_at).
type ReadableMessage struct {
	Message Message     `json:"message"`
	Author  SavedAuthor `json:"author"`
	Chat    SavedChat   `json:"chat"`
}

// MaxReadableBatch bounds one ReadableMessages call: one page of a list.
const MaxReadableBatch = 100

// ReadableMessages returns those of the given messages the person can read
// right now, keyed by id: the message is not deleted, the chat is not
// archived, the person is an active member of it and not an agent that only
// writes there — the rule of «Important» (visibleSave). Anything else is
// simply absent, so a caller cannot tell a message it may not read from a
// missing one. Personal reminders show their message through it.
func (s *Service) ReadableMessages(ctx context.Context, user identity.User, messageIDs []string) (map[string]ReadableMessage, error) {
	result := make(map[string]ReadableMessage, len(messageIDs))
	if len(messageIDs) == 0 {
		return result, nil
	}
	if len(messageIDs) > MaxReadableBatch {
		return nil, fmt.Errorf("%w: at most %d messages at once", ErrInvalid, MaxReadableBatch)
	}
	for _, messageID := range messageIDs {
		if err := validateUUID("message_id", messageID); err != nil {
			return nil, err
		}
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return nil, fmt.Errorf("begin read messages: %w", err)
	}
	defer tx.Rollback(ctx)
	rows, err := tx.Query(ctx, `
		SELECT m.id, m.chat_id, m.actor_id, m.client_msg_id, m.type, m.body, m.body_format, m.reply_to_id,
			m.thread_root_id, m.version, m.created_seq, m.created_at, m.edited_at, m.deleted_at, m.forwarded_from,
			m.mentioned_actor_ids, m.blocks,
			author.id, author.display_name, author.type, author.avatar_version,
			c.id, c.kind, COALESCE(c.name, peer.display_name, 'Direct chat')
		FROM messages m
		JOIN chats c ON c.org_id = m.org_id AND c.id = m.chat_id AND c.archived_at IS NULL
		JOIN chat_members cm ON cm.org_id = m.org_id AND cm.chat_id = m.chat_id AND cm.actor_id = $2
		JOIN actors reader ON reader.org_id = cm.org_id AND reader.id = cm.actor_id
			AND reader.status = 'active' AND reader.deleted_at IS NULL
		JOIN actors author ON author.org_id = m.org_id AND author.id = m.actor_id
		LEFT JOIN LATERAL (
			SELECT a.display_name FROM chat_members other
			JOIN actors a ON a.org_id = other.org_id AND a.id = other.actor_id
			WHERE other.org_id = c.org_id AND other.chat_id = c.id AND other.actor_id <> $2
			LIMIT 1
		) peer ON c.kind = 'direct'
		WHERE m.org_id = $1 AND m.id = ANY($3::uuid[]) AND m.deleted_at IS NULL
		  AND NOT EXISTS (
			SELECT 1 FROM agents agent WHERE agent.org_id = m.org_id AND agent.actor_id = $2
			  AND m.chat_id = ANY(agent.write_only_chat_ids))`, user.OrgID, user.ActorID, messageIDs)
	if err != nil {
		return nil, fmt.Errorf("read messages: %w", err)
	}
	defer rows.Close()
	items := make([]ReadableMessage, 0, len(messageIDs))
	for rows.Next() {
		var item ReadableMessage
		m := &item.Message
		if err := rows.Scan(
			&m.ID, &m.ChatID, &m.ActorID, &m.ClientMsgID, &m.Type, &m.Body, &m.BodyFormat, &m.ReplyToID,
			&m.ThreadRootID, &m.Version, &m.CreatedSeq, &m.CreatedAt, &m.EditedAt, &m.DeletedAt,
			newJSONScanner(&m.ForwardedFrom), &m.MentionedActorIDs, newJSONScanner(&m.Blocks),
			&item.Author.ActorID, &item.Author.DisplayName, &item.Author.Type, &item.Author.AvatarVersion,
			&item.Chat.ID, &item.Chat.Kind, &item.Chat.DisplayName); err != nil {
			return nil, fmt.Errorf("scan readable message: %w", err)
		}
		items = append(items, item)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate readable messages: %w", err)
	}
	rows.Close()
	messages := make([]Message, len(items))
	for index := range items {
		messages[index] = items[index].Message
	}
	if err := hydrateThreadReplyCounts(ctx, tx, user.OrgID, messages); err != nil {
		return nil, err
	}
	if err := hydrateFiles(ctx, tx, user.OrgID, messages); err != nil {
		return nil, err
	}
	for index := range items {
		items[index].Message = messages[index]
		result[items[index].Message.ID] = items[index]
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, fmt.Errorf("commit read messages: %w", err)
	}
	return result, nil
}
