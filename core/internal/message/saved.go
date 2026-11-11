package message

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/comamessenger/comamessenger/core/internal/identity"
	"github.com/jackc/pgx/v5"
)

// Saved messages («Важные») are a private bookmark of one person on one
// message. Unlike pins they are invisible to every other member, including
// chat and workspace admins: no endpoint reads another person's saves, and
// the only event goes to the saver's own sessions.
//
// Access is checked on every read, not stored: a save in a chat the person
// left, was removed from or that was archived is kept but hidden, so it comes
// back if access does (re-invite, restore). A deleted message is gone for
// good, so Delete drops its saves. Hidden saves are purged when the person
// hits the limit, so they never block new saves.

// DefaultSavedLimit bounds how many messages one person can keep saved.
const DefaultSavedLimit = 5000

var ErrSavedLimit = errors.New("saved messages limit reached")

type SavedState struct {
	MessageID string    `json:"message_id"`
	ChatID    string    `json:"chat_id"`
	SavedAt   time.Time `json:"saved_at"`
}

type SavedAuthor struct {
	ActorID       string `json:"actor_id"`
	DisplayName   string `json:"display_name"`
	Type          string `json:"type"`
	AvatarVersion int64  `json:"avatar_version"`
}

type SavedChat struct {
	ID          string `json:"id"`
	Kind        string `json:"kind"`
	DisplayName string `json:"display_name"`
}

type SavedMessage struct {
	Cursor  int64       `json:"cursor"`
	SavedAt time.Time   `json:"saved_at"`
	Message Message     `json:"message"`
	Author  SavedAuthor `json:"author"`
	Chat    SavedChat   `json:"chat"`
}

type SavedPage struct {
	Items      []SavedMessage `json:"items"`
	NextBefore *int64         `json:"next_before"`
}

type SavedListOptions struct {
	ChatID *string
	Before *int64
	Limit  int
}

// visibleSave is the access rule of a save row `sm`: the saver is still an
// active member of a live chat and the message is not deleted. It joins `c`
// (chat) and `m` (message) for the caller.
const visibleSave = `
	JOIN messages m ON m.org_id = sm.org_id AND m.id = sm.message_id AND m.deleted_at IS NULL
	JOIN chats c ON c.org_id = sm.org_id AND c.id = sm.chat_id AND c.archived_at IS NULL
	JOIN chat_members cm ON cm.org_id = sm.org_id AND cm.chat_id = sm.chat_id AND cm.actor_id = sm.actor_id
	JOIN actors saver ON saver.org_id = sm.org_id AND saver.id = sm.actor_id
		AND saver.status = 'active' AND saver.deleted_at IS NULL`

func (s *Service) savedLimitValue() int {
	if s.savedLimit > 0 {
		return s.savedLimit
	}
	return DefaultSavedLimit
}

// SaveMessage saves a message the person can read. The reply says whether the
// save is new; a repeated call returns the existing save and emits nothing.
func (s *Service) SaveMessage(ctx context.Context, user identity.User, messageID string) (SavedState, bool, error) {
	if err := validateUUID("message_id", messageID); err != nil {
		return SavedState{}, false, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return SavedState{}, false, fmt.Errorf("begin save message: %w", err)
	}
	defer tx.Rollback(ctx)
	if err := lockOrganization(ctx, tx, user.OrgID); err != nil {
		return SavedState{}, false, err
	}
	// lockMessage checks active membership in a live chat; a stranger, a
	// former member and an admin outside the chat all get not found.
	message, _, _, err := lockMessage(ctx, tx, user, messageID)
	if err != nil {
		return SavedState{}, false, err
	}
	if message.DeletedAt != nil {
		return SavedState{}, false, ErrNotFound
	}
	// Like the feed: an agent does not read a chat it only writes to.
	if _, writeOnly, err := agentChatRole(ctx, tx, user.OrgID, user.ActorID, message.ChatID); err != nil {
		return SavedState{}, false, err
	} else if writeOnly {
		return SavedState{}, false, ErrForbidden
	}
	result := SavedState{MessageID: messageID, ChatID: message.ChatID}
	err = tx.QueryRow(ctx, `SELECT saved_at FROM saved_messages WHERE actor_id = $1 AND message_id = $2`,
		user.ActorID, messageID).Scan(&result.SavedAt)
	if err == nil {
		return result, false, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return SavedState{}, false, fmt.Errorf("find saved message: %w", err)
	}
	limit := s.savedLimitValue()
	count, err := countSaved(ctx, tx, user)
	if err != nil {
		return SavedState{}, false, err
	}
	if count >= limit {
		// Saves the person can no longer read do not count against the limit.
		if _, err := tx.Exec(ctx, `
			DELETE FROM saved_messages target
			WHERE target.org_id = $1 AND target.actor_id = $2
			  AND NOT EXISTS (SELECT 1 FROM saved_messages sm `+visibleSave+`
				WHERE sm.id = target.id)`, user.OrgID, user.ActorID); err != nil {
			return SavedState{}, false, fmt.Errorf("purge hidden saved messages: %w", err)
		}
		if count, err = countSaved(ctx, tx, user); err != nil {
			return SavedState{}, false, err
		}
		if count >= limit {
			return SavedState{}, false, ErrSavedLimit
		}
	}
	err = tx.QueryRow(ctx, `
		INSERT INTO saved_messages (org_id, actor_id, message_id, chat_id)
		VALUES ($1, $2, $3, $4)
		RETURNING saved_at`, user.OrgID, user.ActorID, messageID, message.ChatID).Scan(&result.SavedAt)
	if err != nil {
		return SavedState{}, false, fmt.Errorf("insert saved message: %w", err)
	}
	seq, err := nextSequence(ctx, tx, user.OrgID)
	if err != nil {
		return SavedState{}, false, err
	}
	if err := insertSavedEvent(ctx, tx, user, messageID, seq, "message.saved", result); err != nil {
		return SavedState{}, false, err
	}
	if err := tx.Commit(ctx); err != nil {
		return SavedState{}, false, fmt.Errorf("commit save message: %w", err)
	}
	s.notifyAfterCommit(user.OrgID, seq)
	return result, true, nil
}

// UnsaveMessage removes the person's own save. It needs no access to the chat:
// a person may clean up saves from a chat they left. Nothing is revealed — the
// reply is the same whether the message exists or not.
func (s *Service) UnsaveMessage(ctx context.Context, user identity.User, messageID string) (bool, error) {
	if err := validateUUID("message_id", messageID); err != nil {
		return false, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return false, fmt.Errorf("begin unsave message: %w", err)
	}
	defer tx.Rollback(ctx)
	if err := lockOrganization(ctx, tx, user.OrgID); err != nil {
		return false, err
	}
	var chatID string
	err = tx.QueryRow(ctx, `
		DELETE FROM saved_messages WHERE org_id = $1 AND actor_id = $2 AND message_id = $3
		RETURNING chat_id`, user.OrgID, user.ActorID, messageID).Scan(&chatID)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, fmt.Errorf("delete saved message: %w", err)
	}
	seq, err := nextSequence(ctx, tx, user.OrgID)
	if err != nil {
		return false, err
	}
	payload := map[string]any{"message_id": messageID, "chat_id": chatID}
	if err := insertSavedEvent(ctx, tx, user, messageID, seq, "message.unsaved", payload); err != nil {
		return false, err
	}
	if err := tx.Commit(ctx); err != nil {
		return false, fmt.Errorf("commit unsave message: %w", err)
	}
	s.notifyAfterCommit(user.OrgID, seq)
	return true, nil
}

// ListSaved returns the person's readable saves, newest first.
func (s *Service) ListSaved(ctx context.Context, user identity.User, options SavedListOptions) (SavedPage, error) {
	if options.ChatID != nil {
		if err := validateUUID("chat_id", *options.ChatID); err != nil {
			return SavedPage{}, err
		}
	}
	if options.Before != nil && *options.Before < 1 {
		return SavedPage{}, fmt.Errorf("%w: before must be positive", ErrInvalid)
	}
	limit := options.Limit
	if limit == 0 {
		limit = 50
	}
	if limit < 1 || limit > 100 {
		return SavedPage{}, fmt.Errorf("%w: limit must be between 1 and 100", ErrInvalid)
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return SavedPage{}, fmt.Errorf("begin list saved messages: %w", err)
	}
	defer tx.Rollback(ctx)
	rows, err := tx.Query(ctx, `
		SELECT sm.id, sm.saved_at,
			m.id, m.chat_id, m.actor_id, m.client_msg_id, m.type, m.body, m.body_format, m.reply_to_id,
			m.thread_root_id, m.version, m.created_seq, m.created_at, m.edited_at, m.deleted_at, m.forwarded_from,
			m.mentioned_actor_ids, m.blocks,
			author.id, author.display_name, author.type, author.avatar_version,
			c.id, c.kind, COALESCE(c.name, peer.display_name, 'Direct chat')
		FROM saved_messages sm `+visibleSave+`
		JOIN actors author ON author.org_id = m.org_id AND author.id = m.actor_id
		LEFT JOIN LATERAL (
			SELECT a.display_name FROM chat_members other
			JOIN actors a ON a.org_id = other.org_id AND a.id = other.actor_id
			WHERE other.org_id = c.org_id AND other.chat_id = c.id AND other.actor_id <> sm.actor_id
			LIMIT 1
		) peer ON c.kind = 'direct'
		WHERE sm.org_id = $1 AND sm.actor_id = $2
		  AND ($3::uuid IS NULL OR sm.chat_id = $3)
		  AND ($4::bigint IS NULL OR sm.id < $4)
		  AND NOT EXISTS (
			SELECT 1 FROM agents agent WHERE agent.org_id = sm.org_id AND agent.actor_id = sm.actor_id
			  AND sm.chat_id = ANY(agent.write_only_chat_ids))
		ORDER BY sm.id DESC
		LIMIT $5`, user.OrgID, user.ActorID, options.ChatID, options.Before, limit+1)
	if err != nil {
		return SavedPage{}, fmt.Errorf("list saved messages: %w", err)
	}
	defer rows.Close()
	items := make([]SavedMessage, 0, limit)
	for rows.Next() {
		var item SavedMessage
		m := &item.Message
		if err := rows.Scan(&item.Cursor, &item.SavedAt,
			&m.ID, &m.ChatID, &m.ActorID, &m.ClientMsgID, &m.Type, &m.Body, &m.BodyFormat, &m.ReplyToID,
			&m.ThreadRootID, &m.Version, &m.CreatedSeq, &m.CreatedAt, &m.EditedAt, &m.DeletedAt,
			newJSONScanner(&m.ForwardedFrom), &m.MentionedActorIDs, newJSONScanner(&m.Blocks),
			&item.Author.ActorID, &item.Author.DisplayName, &item.Author.Type, &item.Author.AvatarVersion,
			&item.Chat.ID, &item.Chat.Kind, &item.Chat.DisplayName); err != nil {
			return SavedPage{}, fmt.Errorf("scan saved message: %w", err)
		}
		items = append(items, item)
	}
	if err := rows.Err(); err != nil {
		return SavedPage{}, fmt.Errorf("iterate saved messages: %w", err)
	}
	rows.Close()
	var next *int64
	if len(items) > limit {
		items = items[:limit]
		cursor := items[len(items)-1].Cursor
		next = &cursor
	}
	messages := make([]Message, len(items))
	for index := range items {
		messages[index] = items[index].Message
	}
	if err := hydrateThreadReplyCounts(ctx, tx, user.OrgID, messages); err != nil {
		return SavedPage{}, err
	}
	if err := hydrateFiles(ctx, tx, user.OrgID, messages); err != nil {
		return SavedPage{}, err
	}
	for index := range items {
		items[index].Message = messages[index]
	}
	if err := tx.Commit(ctx); err != nil {
		return SavedPage{}, fmt.Errorf("commit list saved messages: %w", err)
	}
	return SavedPage{Items: items, NextBefore: next}, nil
}

// SavedIDs returns which messages of one chat the person saved: the star in
// the feed. The chat must be readable, as for the feed itself.
func (s *Service) SavedIDs(ctx context.Context, user identity.User, chatID string) ([]string, error) {
	if err := validateUUID("chat_id", chatID); err != nil {
		return nil, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return nil, fmt.Errorf("begin list saved message ids: %w", err)
	}
	defer tx.Rollback(ctx)
	if _, _, err := requireMembership(ctx, tx, user, chatID); err != nil {
		return nil, err
	}
	if _, writeOnly, err := agentChatRole(ctx, tx, user.OrgID, user.ActorID, chatID); err != nil {
		return nil, err
	} else if writeOnly {
		return nil, ErrForbidden
	}
	rows, err := tx.Query(ctx, `
		SELECT sm.message_id FROM saved_messages sm
		JOIN messages m ON m.org_id = sm.org_id AND m.id = sm.message_id AND m.deleted_at IS NULL
		WHERE sm.org_id = $1 AND sm.actor_id = $2 AND sm.chat_id = $3
		ORDER BY sm.id DESC`, user.OrgID, user.ActorID, chatID)
	if err != nil {
		return nil, fmt.Errorf("list saved message ids: %w", err)
	}
	defer rows.Close()
	result := make([]string, 0)
	for rows.Next() {
		var value string
		if err := rows.Scan(&value); err != nil {
			return nil, fmt.Errorf("scan saved message id: %w", err)
		}
		result = append(result, value)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate saved message ids: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, fmt.Errorf("commit list saved message ids: %w", err)
	}
	return result, nil
}

func countSaved(ctx context.Context, tx pgx.Tx, user identity.User) (int, error) {
	var count int
	if err := tx.QueryRow(ctx, `SELECT count(*) FROM saved_messages WHERE org_id = $1 AND actor_id = $2`,
		user.OrgID, user.ActorID).Scan(&count); err != nil {
		return 0, fmt.Errorf("count saved messages: %w", err)
	}
	return count, nil
}

// insertSavedEvent writes an event only the saver receives. It carries no
// chat_id, so neither chat feeds nor agent triggers (which read chat events
// only) ever see it, and no message content: just identifiers.
func insertSavedEvent(ctx context.Context, tx pgx.Tx, user identity.User, messageID string, seq int64, eventType string, data any) error {
	payload, err := json.Marshal(data)
	if err != nil {
		return fmt.Errorf("marshal saved message event: %w", err)
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO events (org_id, seq, type, actor_id, chat_id, subject_id, audience_actor_id, data)
		VALUES ($1, $2, $3, $4, NULL, $5, $4, $6::jsonb)`,
		user.OrgID, seq, eventType, user.ActorID, messageID, string(payload)); err != nil {
		return fmt.Errorf("insert saved message event: %w", err)
	}
	return nil
}
