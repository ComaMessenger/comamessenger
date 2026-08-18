package message

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/comamessenger/comamessenger/core/internal/authz"
	"github.com/comamessenger/comamessenger/core/internal/id"
	"github.com/comamessenger/comamessenger/core/internal/identity"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

type Reaction struct {
	MessageID string    `json:"message_id"`
	ActorID   string    `json:"actor_id"`
	Emoji     string    `json:"emoji"`
	CreatedAt time.Time `json:"created_at"`
}

type Pin struct {
	MessageID string    `json:"message_id"`
	PinnedBy  string    `json:"pinned_by"`
	PinnedAt  time.Time `json:"pinned_at"`
}

type ThreadSummary struct {
	Root            Message   `json:"root"`
	ReplyCount      int64     `json:"reply_count"`
	LastReplySeq    *int64    `json:"last_reply_seq"`
	LastActivitySeq int64     `json:"last_activity_seq"`
	FollowedAt      time.Time `json:"followed_at"`
}

type ThreadPage struct {
	Threads       []ThreadSummary `json:"threads"`
	NextBeforeSeq *int64          `json:"next_before_seq"`
}

type ForwardInput struct {
	ChatID      string `json:"chat_id"`
	ClientMsgID string `json:"client_msg_id"`
}

func (s *Service) ListThread(ctx context.Context, user identity.User, rootID string, options ListOptions) (Page, error) {
	if err := validateUUID("root_id", rootID); err != nil {
		return Page{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Page{}, fmt.Errorf("begin resolve thread: %w", err)
	}
	defer tx.Rollback(ctx)
	root, _, _, err := lockMessage(ctx, tx, user, rootID)
	if err != nil {
		return Page{}, err
	}
	if root.ThreadRootID != nil {
		return Page{}, fmt.Errorf("%w: message is not a thread root", ErrInvalid)
	}
	if err := tx.Commit(ctx); err != nil {
		return Page{}, fmt.Errorf("commit resolve thread: %w", err)
	}
	options.ThreadRootID = &root.ID
	return s.List(ctx, user, root.ChatID, options)
}

func (s *Service) FollowThread(ctx context.Context, user identity.User, rootID string) (time.Time, bool, error) {
	if err := validateUUID("root_id", rootID); err != nil {
		return time.Time{}, false, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return time.Time{}, false, fmt.Errorf("begin follow thread: %w", err)
	}
	defer tx.Rollback(ctx)
	if err := lockOrganization(ctx, tx, user.OrgID); err != nil {
		return time.Time{}, false, err
	}
	root, _, _, err := lockMessage(ctx, tx, user, rootID)
	if err != nil {
		return time.Time{}, false, err
	}
	if root.ThreadRootID != nil || root.DeletedAt != nil {
		return time.Time{}, false, fmt.Errorf("%w: message is not an active thread root", ErrInvalid)
	}
	followedAt, created, highWatermark, err := followThread(ctx, tx, user, root, user.ActorID, false, 0)
	if err != nil {
		return time.Time{}, false, err
	}
	if err := tx.Commit(ctx); err != nil {
		return time.Time{}, false, fmt.Errorf("commit follow thread: %w", err)
	}
	if created {
		s.notifyAfterCommit(user.OrgID, highWatermark)
	}
	return followedAt, created, nil
}

func (s *Service) UnfollowThread(ctx context.Context, user identity.User, rootID string) (bool, error) {
	if err := validateUUID("root_id", rootID); err != nil {
		return false, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return false, fmt.Errorf("begin unfollow thread: %w", err)
	}
	defer tx.Rollback(ctx)
	if err := lockOrganization(ctx, tx, user.OrgID); err != nil {
		return false, err
	}
	root, _, _, err := lockMessage(ctx, tx, user, rootID)
	if err != nil {
		return false, err
	}
	if root.ThreadRootID != nil {
		return false, fmt.Errorf("%w: message is not a thread root", ErrInvalid)
	}
	command, err := tx.Exec(ctx, `DELETE FROM thread_followers WHERE org_id = $1 AND thread_root_id = $2 AND actor_id = $3`, user.OrgID, rootID, user.ActorID)
	if err != nil {
		return false, fmt.Errorf("delete thread follower: %w", err)
	}
	removed := command.RowsAffected() == 1
	var seq int64
	if removed {
		seq, err = nextSequence(ctx, tx, user.OrgID)
		if err != nil {
			return false, err
		}
		payload := map[string]any{"thread_root_id": rootID, "actor_id": user.ActorID}
		if err := insertEventData(ctx, tx, user, root.ChatID, rootID, seq, "thread.unfollowed", &user.ActorID, payload); err != nil {
			return false, err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return false, fmt.Errorf("commit unfollow thread: %w", err)
	}
	if removed {
		s.notifyAfterCommit(user.OrgID, seq)
	}
	return removed, nil
}

func (s *Service) ListFollowedThreads(ctx context.Context, user identity.User, beforeSeq *int64, limit int) (ThreadPage, error) {
	if beforeSeq != nil && *beforeSeq < 1 {
		return ThreadPage{}, fmt.Errorf("%w: before_seq must be positive", ErrInvalid)
	}
	if limit == 0 {
		limit = 50
	}
	if limit < 1 || limit > s.maxPageSize {
		return ThreadPage{}, fmt.Errorf("%w: limit must be between 1 and %d", ErrInvalid, s.maxPageSize)
	}
	rows, err := s.pool.Query(ctx, `
		SELECT root.id, root.chat_id, root.actor_id, root.client_msg_id, root.type, root.body, root.body_format,
			root.reply_to_id, root.thread_root_id, root.version, root.created_seq, root.created_at, root.edited_at,
			root.deleted_at, root.forwarded_from, root.mentioned_actor_ids, tf.followed_at, count(reply.id), max(reply.created_seq),
			GREATEST(root.created_seq, COALESCE(max(reply.created_seq), root.created_seq)) AS activity_seq
		FROM thread_followers tf
		JOIN messages root ON root.org_id = tf.org_id AND root.id = tf.thread_root_id
		JOIN chats c ON c.org_id = root.org_id AND c.id = root.chat_id AND c.archived_at IS NULL
		JOIN chat_members cm ON cm.org_id = c.org_id AND cm.chat_id = c.id AND cm.actor_id = $2
		JOIN actors recipient ON recipient.org_id = cm.org_id AND recipient.id = cm.actor_id
		LEFT JOIN messages reply ON reply.org_id = root.org_id AND reply.thread_root_id = root.id
		WHERE tf.org_id = $1 AND tf.actor_id = $2
		  AND recipient.status = 'active' AND recipient.deleted_at IS NULL
		GROUP BY root.id, tf.followed_at
		HAVING ($3::bigint IS NULL OR GREATEST(root.created_seq, COALESCE(max(reply.created_seq), root.created_seq)) < $3)
		ORDER BY activity_seq DESC
		LIMIT $4`, user.OrgID, user.ActorID, beforeSeq, limit+1)
	if err != nil {
		return ThreadPage{}, fmt.Errorf("list followed threads: %w", err)
	}
	defer rows.Close()
	threads := make([]ThreadSummary, 0, limit)
	for rows.Next() {
		var item ThreadSummary
		if err := rows.Scan(&item.Root.ID, &item.Root.ChatID, &item.Root.ActorID, &item.Root.ClientMsgID,
			&item.Root.Type, &item.Root.Body, &item.Root.BodyFormat, &item.Root.ReplyToID, &item.Root.ThreadRootID,
			&item.Root.Version, &item.Root.CreatedSeq, &item.Root.CreatedAt, &item.Root.EditedAt, &item.Root.DeletedAt,
			newJSONScanner(&item.Root.ForwardedFrom), &item.Root.MentionedActorIDs, &item.FollowedAt, &item.ReplyCount, &item.LastReplySeq,
			&item.LastActivitySeq); err != nil {
			return ThreadPage{}, fmt.Errorf("scan followed thread: %w", err)
		}
		threads = append(threads, item)
	}
	if err := rows.Err(); err != nil {
		return ThreadPage{}, fmt.Errorf("iterate followed threads: %w", err)
	}
	var next *int64
	if len(threads) > limit {
		threads = threads[:limit]
		cursor := threads[len(threads)-1].LastActivitySeq
		next = &cursor
	}
	return ThreadPage{Threads: threads, NextBeforeSeq: next}, nil
}

func (s *Service) PutReaction(ctx context.Context, user identity.User, messageID, emoji string) (Reaction, bool, error) {
	emoji, err := validateEmoji(messageID, emoji)
	if err != nil {
		return Reaction{}, false, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Reaction{}, false, fmt.Errorf("begin add reaction: %w", err)
	}
	defer tx.Rollback(ctx)
	if err := lockOrganization(ctx, tx, user.OrgID); err != nil {
		return Reaction{}, false, err
	}
	message, _, _, err := lockMessage(ctx, tx, user, messageID)
	if err != nil {
		return Reaction{}, false, err
	}
	if message.DeletedAt != nil {
		return Reaction{}, false, ErrNotFound
	}
	result := Reaction{MessageID: messageID, ActorID: user.ActorID, Emoji: emoji}
	err = tx.QueryRow(ctx, `
		INSERT INTO reactions (org_id, message_id, actor_id, emoji)
		VALUES ($1, $2, $3, $4)
		ON CONFLICT (message_id, actor_id, emoji) DO NOTHING
		RETURNING created_at`, user.OrgID, messageID, user.ActorID, emoji).Scan(&result.CreatedAt)
	created := err == nil
	if errors.Is(err, pgx.ErrNoRows) {
		err = tx.QueryRow(ctx, `SELECT created_at FROM reactions WHERE message_id = $1 AND actor_id = $2 AND emoji = $3`, messageID, user.ActorID, emoji).Scan(&result.CreatedAt)
	}
	if err != nil {
		return Reaction{}, false, fmt.Errorf("upsert reaction: %w", err)
	}
	var seq int64
	if created {
		seq, err = nextSequence(ctx, tx, user.OrgID)
		if err != nil {
			return Reaction{}, false, err
		}
		if err := insertEventData(ctx, tx, user, message.ChatID, messageID, seq, "reaction.added", nil, result); err != nil {
			return Reaction{}, false, err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return Reaction{}, false, fmt.Errorf("commit add reaction: %w", err)
	}
	if created {
		s.notifyAfterCommit(user.OrgID, seq)
	}
	return result, created, nil
}

func (s *Service) ListReactions(ctx context.Context, user identity.User, messageID string) ([]Reaction, error) {
	if err := validateUUID("message_id", messageID); err != nil {
		return nil, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return nil, fmt.Errorf("begin list reactions: %w", err)
	}
	defer tx.Rollback(ctx)
	if _, _, _, err := lockMessage(ctx, tx, user, messageID); err != nil {
		return nil, err
	}
	rows, err := tx.Query(ctx, `
		SELECT message_id, actor_id, emoji, created_at
		FROM reactions WHERE org_id = $1 AND message_id = $2
		ORDER BY created_at, actor_id, emoji`, user.OrgID, messageID)
	if err != nil {
		return nil, fmt.Errorf("list reactions: %w", err)
	}
	defer rows.Close()
	result := make([]Reaction, 0)
	for rows.Next() {
		var reaction Reaction
		if err := rows.Scan(&reaction.MessageID, &reaction.ActorID, &reaction.Emoji, &reaction.CreatedAt); err != nil {
			return nil, fmt.Errorf("scan reaction: %w", err)
		}
		result = append(result, reaction)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate reactions: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, fmt.Errorf("commit list reactions: %w", err)
	}
	return result, nil
}

func (s *Service) DeleteReaction(ctx context.Context, user identity.User, messageID, emoji string) (bool, error) {
	emoji, err := validateEmoji(messageID, emoji)
	if err != nil {
		return false, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return false, fmt.Errorf("begin delete reaction: %w", err)
	}
	defer tx.Rollback(ctx)
	if err := lockOrganization(ctx, tx, user.OrgID); err != nil {
		return false, err
	}
	message, _, _, err := lockMessage(ctx, tx, user, messageID)
	if err != nil {
		return false, err
	}
	command, err := tx.Exec(ctx, `DELETE FROM reactions WHERE org_id = $1 AND message_id = $2 AND actor_id = $3 AND emoji = $4`, user.OrgID, messageID, user.ActorID, emoji)
	if err != nil {
		return false, fmt.Errorf("delete reaction: %w", err)
	}
	removed := command.RowsAffected() == 1
	var seq int64
	if removed {
		seq, err = nextSequence(ctx, tx, user.OrgID)
		if err != nil {
			return false, err
		}
		payload := map[string]any{"message_id": messageID, "actor_id": user.ActorID, "emoji": emoji}
		if err := insertEventData(ctx, tx, user, message.ChatID, messageID, seq, "reaction.removed", nil, payload); err != nil {
			return false, err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return false, fmt.Errorf("commit delete reaction: %w", err)
	}
	if removed {
		s.notifyAfterCommit(user.OrgID, seq)
	}
	return removed, nil
}

func (s *Service) PutPin(ctx context.Context, user identity.User, messageID string) (Pin, bool, error) {
	if err := validateUUID("message_id", messageID); err != nil {
		return Pin{}, false, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Pin{}, false, fmt.Errorf("begin pin message: %w", err)
	}
	defer tx.Rollback(ctx)
	if err := lockOrganization(ctx, tx, user.OrgID); err != nil {
		return Pin{}, false, err
	}
	message, kind, role, err := lockMessage(ctx, tx, user, messageID)
	if err != nil {
		return Pin{}, false, err
	}
	if message.DeletedAt != nil {
		return Pin{}, false, ErrNotFound
	}
	if !can(user, kind, role, authz.ChatManage) {
		return Pin{}, false, ErrForbidden
	}
	result := Pin{MessageID: messageID, PinnedBy: user.ActorID}
	err = tx.QueryRow(ctx, `
		INSERT INTO message_pins (org_id, message_id, pinned_by)
		VALUES ($1, $2, $3)
		ON CONFLICT (message_id) DO NOTHING
		RETURNING pinned_at`, user.OrgID, messageID, user.ActorID).Scan(&result.PinnedAt)
	created := err == nil
	if errors.Is(err, pgx.ErrNoRows) {
		err = tx.QueryRow(ctx, `SELECT pinned_by, pinned_at FROM message_pins WHERE message_id = $1`, messageID).Scan(&result.PinnedBy, &result.PinnedAt)
	}
	if err != nil {
		return Pin{}, false, fmt.Errorf("upsert message pin: %w", err)
	}
	var seq int64
	if created {
		seq, err = nextSequence(ctx, tx, user.OrgID)
		if err != nil {
			return Pin{}, false, err
		}
		if err := insertEventData(ctx, tx, user, message.ChatID, messageID, seq, "message.pinned", nil, result); err != nil {
			return Pin{}, false, err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return Pin{}, false, fmt.Errorf("commit pin message: %w", err)
	}
	if created {
		s.notifyAfterCommit(user.OrgID, seq)
	}
	return result, created, nil
}

func (s *Service) DeletePin(ctx context.Context, user identity.User, messageID string) (bool, error) {
	if err := validateUUID("message_id", messageID); err != nil {
		return false, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return false, fmt.Errorf("begin unpin message: %w", err)
	}
	defer tx.Rollback(ctx)
	if err := lockOrganization(ctx, tx, user.OrgID); err != nil {
		return false, err
	}
	message, kind, role, err := lockMessage(ctx, tx, user, messageID)
	if err != nil {
		return false, err
	}
	if !can(user, kind, role, authz.ChatManage) {
		return false, ErrForbidden
	}
	command, err := tx.Exec(ctx, `DELETE FROM message_pins WHERE org_id = $1 AND message_id = $2`, user.OrgID, messageID)
	if err != nil {
		return false, fmt.Errorf("delete message pin: %w", err)
	}
	removed := command.RowsAffected() == 1
	var seq int64
	if removed {
		seq, err = nextSequence(ctx, tx, user.OrgID)
		if err != nil {
			return false, err
		}
		payload := map[string]any{"message_id": messageID}
		if err := insertEventData(ctx, tx, user, message.ChatID, messageID, seq, "message.unpinned", nil, payload); err != nil {
			return false, err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return false, fmt.Errorf("commit unpin message: %w", err)
	}
	if removed {
		s.notifyAfterCommit(user.OrgID, seq)
	}
	return removed, nil
}

func (s *Service) ListPins(ctx context.Context, user identity.User, chatID string) ([]Pin, error) {
	if err := validateUUID("chat_id", chatID); err != nil {
		return nil, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return nil, fmt.Errorf("begin list message pins: %w", err)
	}
	defer tx.Rollback(ctx)
	if _, _, err := requireMembership(ctx, tx, user, chatID); err != nil {
		return nil, err
	}
	rows, err := tx.Query(ctx, `
		SELECT mp.message_id, mp.pinned_by, mp.pinned_at
		FROM message_pins mp
		JOIN messages m ON m.org_id = mp.org_id AND m.id = mp.message_id
		WHERE mp.org_id = $1 AND m.chat_id = $2 AND m.deleted_at IS NULL
		ORDER BY mp.pinned_at DESC, mp.message_id`, user.OrgID, chatID)
	if err != nil {
		return nil, fmt.Errorf("list message pins: %w", err)
	}
	defer rows.Close()
	result := make([]Pin, 0)
	for rows.Next() {
		var pin Pin
		if err := rows.Scan(&pin.MessageID, &pin.PinnedBy, &pin.PinnedAt); err != nil {
			return nil, fmt.Errorf("scan message pin: %w", err)
		}
		result = append(result, pin)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate message pins: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, fmt.Errorf("commit list message pins: %w", err)
	}
	return result, nil
}

func (s *Service) Forward(ctx context.Context, user identity.User, sourceMessageID string, input ForwardInput) (Message, bool, error) {
	if err := validateUUID("message_id", sourceMessageID); err != nil {
		return Message{}, false, err
	}
	if err := validateUUID("chat_id", input.ChatID); err != nil {
		return Message{}, false, err
	}
	if err := validateUUID("client_msg_id", input.ClientMsgID); err != nil {
		return Message{}, false, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Message{}, false, fmt.Errorf("begin forward message: %w", err)
	}
	defer tx.Rollback(ctx)
	if err := lockOrganization(ctx, tx, user.OrgID); err != nil {
		return Message{}, false, err
	}
	kind, role, err := requireMembership(ctx, tx, user, input.ChatID)
	if err != nil {
		return Message{}, false, err
	}
	if !can(user, kind, role, authz.MessagePublish) {
		return Message{}, false, ErrForbidden
	}
	fingerprint := forwardFingerprint(input.ChatID, sourceMessageID)
	existing, existingFingerprint, err := findByClientID(ctx, tx, user.ActorID, input.ClientMsgID)
	if err == nil {
		if existingFingerprint == fingerprint {
			return existing, false, nil
		}
		return Message{}, false, ErrIdempotencyConflict
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return Message{}, false, fmt.Errorf("find idempotent forward: %w", err)
	}
	source, _, _, err := lockMessage(ctx, tx, user, sourceMessageID)
	if err != nil {
		return Message{}, false, err
	}
	if source.DeletedAt != nil {
		return Message{}, false, ErrNotFound
	}
	attribution := source.ForwardedFrom
	if attribution == nil {
		attribution = &ForwardAttribution{CreatedAt: source.CreatedAt}
		if err := tx.QueryRow(ctx, `SELECT display_name, handle FROM actors WHERE org_id = $1 AND id = $2`, user.OrgID, source.ActorID).Scan(&attribution.AuthorName, &attribution.AuthorHandle); err != nil {
			return Message{}, false, fmt.Errorf("load forward attribution: %w", err)
		}
	}
	attributionJSON, err := json.Marshal(attribution)
	if err != nil {
		return Message{}, false, fmt.Errorf("marshal forward attribution: %w", err)
	}
	messageID, err := id.New()
	if err != nil {
		return Message{}, false, fmt.Errorf("generate forwarded message id: %w", err)
	}
	seq, err := nextSequence(ctx, tx, user.OrgID)
	if err != nil {
		return Message{}, false, err
	}
	var result Message
	err = scanMessage(tx.QueryRow(ctx, `
		INSERT INTO messages
			(id, org_id, chat_id, actor_id, client_msg_id, create_fingerprint, body, body_format, created_seq, forwarded_from)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)
		RETURNING id, chat_id, actor_id, client_msg_id, type, body, body_format, reply_to_id,
			thread_root_id, version, created_seq, created_at, edited_at, deleted_at, forwarded_from, mentioned_actor_ids`,
		messageID, user.OrgID, input.ChatID, user.ActorID, input.ClientMsgID, fingerprint[:], source.Body,
		source.BodyFormat, seq, string(attributionJSON)), &result)
	if err != nil {
		return Message{}, false, fmt.Errorf("insert forwarded message: %w", err)
	}
	if err := insertEvent(ctx, tx, user, input.ChatID, result.ID, seq, "message.created"); err != nil {
		return Message{}, false, err
	}
	if _, err := tx.Exec(ctx, `UPDATE chats SET last_message_at = $3 WHERE org_id = $1 AND id = $2`, user.OrgID, input.ChatID, result.CreatedAt); err != nil {
		return Message{}, false, fmt.Errorf("update forward destination activity: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return Message{}, false, fmt.Errorf("commit forward message: %w", err)
	}
	s.notifyAfterCommit(user.OrgID, seq)
	return result, true, nil
}

func autoFollowThread(ctx context.Context, tx pgx.Tx, user identity.User, rootID string, mentionedActorIDs []string, highWatermark int64) (int64, error) {
	var root Message
	err := scanMessage(tx.QueryRow(ctx, `
		SELECT id, chat_id, actor_id, client_msg_id, type, body, body_format, reply_to_id, thread_root_id,
			version, created_seq, created_at, edited_at, deleted_at, forwarded_from, mentioned_actor_ids
		FROM messages WHERE org_id = $1 AND id = $2`, user.OrgID, rootID), &root)
	if err != nil {
		return 0, fmt.Errorf("load thread root for auto-follow: %w", err)
	}
	actorIDs := []string{root.ActorID}
	if user.ActorID != root.ActorID {
		actorIDs = append(actorIDs, user.ActorID)
	}
	actorIDs = append(actorIDs, mentionedActorIDs...)
	seen := make(map[string]struct{}, len(actorIDs))
	for _, actorID := range actorIDs {
		if _, exists := seen[actorID]; exists {
			continue
		}
		seen[actorID] = struct{}{}
		_, created, next, err := followThread(ctx, tx, user, root, actorID, true, highWatermark)
		if err != nil {
			return 0, err
		}
		if created {
			highWatermark = next
		}
	}
	return highWatermark, nil
}

func followThread(ctx context.Context, tx pgx.Tx, user identity.User, root Message, actorID string, automatic bool, highWatermark int64) (time.Time, bool, int64, error) {
	var followedAt time.Time
	err := tx.QueryRow(ctx, `
		INSERT INTO thread_followers (org_id, thread_root_id, actor_id)
		VALUES ($1, $2, $3)
		ON CONFLICT (thread_root_id, actor_id) DO NOTHING
		RETURNING followed_at`, user.OrgID, root.ID, actorID).Scan(&followedAt)
	created := err == nil
	if errors.Is(err, pgx.ErrNoRows) {
		err = tx.QueryRow(ctx, `SELECT followed_at FROM thread_followers WHERE thread_root_id = $1 AND actor_id = $2`, root.ID, actorID).Scan(&followedAt)
	}
	if err != nil {
		return time.Time{}, false, highWatermark, fmt.Errorf("upsert thread follower: %w", err)
	}
	if !created {
		return followedAt, false, highWatermark, nil
	}
	seq, err := nextSequence(ctx, tx, user.OrgID)
	if err != nil {
		return time.Time{}, false, highWatermark, err
	}
	payload := map[string]any{"thread_root_id": root.ID, "actor_id": actorID, "followed_at": followedAt, "automatic": automatic}
	if err := insertEventData(ctx, tx, user, root.ChatID, root.ID, seq, "thread.followed", &actorID, payload); err != nil {
		return time.Time{}, false, highWatermark, err
	}
	return followedAt, true, seq, nil
}

func validateUUID(name, value string) error {
	if _, err := uuid.Parse(value); err != nil {
		return fmt.Errorf("%w: %s must be a UUID", ErrInvalid, name)
	}
	return nil
}

func validateEmoji(messageID, emoji string) (string, error) {
	if err := validateUUID("message_id", messageID); err != nil {
		return "", err
	}
	emoji = strings.TrimSpace(emoji)
	if emoji == "" || len([]byte(emoji)) > 64 || !utf8.ValidString(emoji) {
		return "", fmt.Errorf("%w: emoji must contain between 1 and 64 UTF-8 bytes", ErrInvalid)
	}
	for _, value := range emoji {
		if unicode.IsControl(value) {
			return "", fmt.Errorf("%w: emoji must not contain control characters", ErrInvalid)
		}
	}
	return emoji, nil
}

func forwardFingerprint(chatID, sourceMessageID string) [32]byte {
	return sha256.Sum256([]byte("forward\x00" + chatID + "\x00" + sourceMessageID))
}
