package eventlog

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/comamessenger/comamessenger/core/internal/identity"
	"github.com/comamessenger/comamessenger/core/internal/message"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

var ErrOrganizationNotFound = errors.New("event organization not found")

type Frame struct {
	Op         string          `json:"op"`
	Seq        int64           `json:"seq"`
	Type       string          `json:"type"`
	OccurredAt time.Time       `json:"occurred_at"`
	ActorID    string          `json:"actor_id"`
	ChatID     *string         `json:"chat_id,omitempty"`
	SubjectID  string          `json:"subject_id"`
	Data       json.RawMessage `json:"data"`
}

// messageContentTypes are the chat events about one message (subject_id):
// the message itself, its reactions and pins. An agent that only writes to
// the chat receives them for its own messages only — the rule of message.Get
// and message.ListReactions. Chat, member, thread-follow, read-mark and draft
// events carry no message content and stay as they are.
const messageContentTypes = `('message.created', 'message.updated', 'message.deleted', 'reaction.added', 'reaction.removed', 'message.pinned', 'message.unpinned')`

type Bounds struct {
	CurrentSeq     int64
	MinRetainedSeq int64
}

type LiveEvent struct {
	Frame             Frame
	RecipientActorIDs []string
	ExcludeSessionID  *string
}

type Store struct {
	pool *pgxpool.Pool
}

func NewStore(pool *pgxpool.Pool) *Store { return &Store{pool: pool} }

// snapshot opens a read-only transaction in which an event batch and the
// fields completing its messages are read from one consistent view.
func (s *Store) snapshot(ctx context.Context) (pgx.Tx, error) {
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return nil, fmt.Errorf("begin event snapshot: %w", err)
	}
	return tx, nil
}

func (s *Store) Current(ctx context.Context, orgID string) (int64, error) {
	var current int64
	if err := s.pool.QueryRow(ctx, `SELECT event_seq FROM organizations WHERE id = $1`, orgID).Scan(&current); errors.Is(err, pgx.ErrNoRows) {
		return 0, ErrOrganizationNotFound
	} else if err != nil {
		return 0, fmt.Errorf("read event high watermark: %w", err)
	}
	return current, nil
}

func (s *Store) Bounds(ctx context.Context, orgID string) (Bounds, error) {
	var result Bounds
	err := s.pool.QueryRow(ctx, `
		SELECT o.event_seq, COALESCE((SELECT GREATEST(min(e.seq) - 1, 0) FROM events e WHERE e.org_id = o.id), o.event_seq)
		FROM organizations o WHERE o.id = $1`, orgID).Scan(&result.CurrentSeq, &result.MinRetainedSeq)
	if errors.Is(err, pgx.ErrNoRows) {
		return Bounds{}, ErrOrganizationNotFound
	}
	if err != nil {
		return Bounds{}, fmt.Errorf("read event bounds: %w", err)
	}
	return result, nil
}

// Replay returns at most limit visible events in (afterSeq, throughSeq]. Filtering
// and message hydration happen in one snapshot against current membership;
// message frames get the REST feed's shape (message.CompleteEventMessages).
func (s *Store) Replay(ctx context.Context, user identity.User, sessionID string, afterSeq, throughSeq int64, limit int) ([]Frame, error) {
	if throughSeq <= afterSeq || limit < 1 {
		return []Frame{}, nil
	}
	tx, err := s.snapshot(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	rows, err := tx.Query(ctx, `
		SELECT e.seq, e.type, e.occurred_at, e.actor_id, e.chat_id, e.subject_id,
			CASE
				WHEN e.type IN ('message.created', 'message.updated', 'message.deleted') AND m.id IS NOT NULL THEN
					jsonb_build_object(
						'id', m.id,
						'chat_id', m.chat_id,
						'actor_id', m.actor_id,
						'client_msg_id', m.client_msg_id,
						'type', m.type,
						'body', m.body,
						'body_format', m.body_format,
						'reply_to_id', m.reply_to_id,
						'thread_root_id', m.thread_root_id,
						'version', m.version,
						'created_seq', m.created_seq,
						'created_at', m.created_at,
						'edited_at', m.edited_at,
						'deleted_at', m.deleted_at,
						'forwarded_from', m.forwarded_from,
						'mentioned_actor_ids', m.mentioned_actor_ids
					) || CASE WHEN m.blocks IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('blocks', m.blocks) END
					  || CASE WHEN m.silent AND e.type = 'message.created' THEN jsonb_build_object('silent', true) ELSE '{}'::jsonb END
				ELSE e.data
			END,
			e.type IN ('message.created', 'message.updated', 'message.deleted') AND m.id IS NOT NULL
		FROM events e
		LEFT JOIN messages m ON m.org_id = e.org_id AND m.id = e.subject_id
		WHERE e.org_id = $1 AND e.seq > $2 AND e.seq <= $3
		  AND (e.audience_actor_id IS NULL OR e.audience_actor_id = $4)
		  AND (e.exclude_session_id IS NULL OR NULLIF($5, '') IS NULL OR e.exclude_session_id <> NULLIF($5, '')::uuid)
		  AND (
			e.chat_id IS NULL OR EXISTS (
				SELECT 1
				FROM chat_members cm
				JOIN actors recipient ON recipient.org_id = cm.org_id AND recipient.id = cm.actor_id
				JOIN chats c ON c.org_id = cm.org_id AND c.id = cm.chat_id
				WHERE cm.org_id = e.org_id AND cm.chat_id = e.chat_id AND cm.actor_id = $4
				  AND recipient.status = 'active' AND recipient.deleted_at IS NULL
				  AND (c.archived_at IS NULL OR e.type = 'chat.archived')
			)
		  )
		  -- As in message.Get: in a chat it only writes to, an agent sees its
		  -- own messages and what happens to them, nothing else.
		  AND NOT (
			e.type IN `+messageContentTypes+`
			AND (m.actor_id IS NULL OR m.actor_id <> $4)
			AND EXISTS (
				SELECT 1 FROM agents writer
				WHERE writer.actor_id = $4 AND writer.org_id = e.org_id AND e.chat_id = ANY(COALESCE(writer.write_only_chat_ids, '{}'::uuid[]))
			)
		  )
		ORDER BY e.seq
		LIMIT $6`, user.OrgID, afterSeq, throughSeq, user.ActorID, sessionID, limit)
	if err != nil {
		return nil, fmt.Errorf("replay visible events: %w", err)
	}
	defer rows.Close()
	result := make([]Frame, 0)
	hydrated := make([]int, 0)
	for rows.Next() {
		frame := Frame{Op: "event"}
		var isMessage bool
		if err := rows.Scan(&frame.Seq, &frame.Type, &frame.OccurredAt, &frame.ActorID, &frame.ChatID, &frame.SubjectID, &frame.Data, &isMessage); err != nil {
			return nil, fmt.Errorf("scan visible event: %w", err)
		}
		if isMessage {
			hydrated = append(hydrated, len(result))
		}
		result = append(result, frame)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate visible events: %w", err)
	}
	rows.Close()
	items := make([]message.EventMessage, len(hydrated))
	for index, position := range hydrated {
		items[index] = message.EventMessage{Data: &result[position].Data}
	}
	if err := message.CompleteEventMessages(ctx, tx, user.OrgID, items); err != nil {
		return nil, fmt.Errorf("complete replayed message events: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, fmt.Errorf("finish event snapshot: %w", err)
	}
	return result, nil
}

// Live reads and hydrates each durable event once, resolving its currently
// authorized recipients in the same PostgreSQL snapshot. The realtime hub can
// then fan the immutable serialized frame out without per-session SQL.
func (s *Store) Live(ctx context.Context, orgID string, afterSeq, throughSeq int64, limit int) ([]LiveEvent, error) {
	if throughSeq <= afterSeq || limit < 1 {
		return []LiveEvent{}, nil
	}
	tx, err := s.snapshot(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	rows, err := tx.Query(ctx, `
		SELECT e.seq, e.type, e.occurred_at, e.actor_id, e.chat_id, e.subject_id,
			CASE
				WHEN e.type IN ('message.created', 'message.updated', 'message.deleted') AND m.id IS NOT NULL THEN
					jsonb_build_object(
						'id', m.id,
						'chat_id', m.chat_id,
						'actor_id', m.actor_id,
						'client_msg_id', m.client_msg_id,
						'type', m.type,
						'body', m.body,
						'body_format', m.body_format,
						'reply_to_id', m.reply_to_id,
						'thread_root_id', m.thread_root_id,
						'version', m.version,
						'created_seq', m.created_seq,
						'created_at', m.created_at,
						'edited_at', m.edited_at,
						'deleted_at', m.deleted_at,
						'forwarded_from', m.forwarded_from,
						'mentioned_actor_ids', m.mentioned_actor_ids
					) || CASE WHEN m.blocks IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('blocks', m.blocks) END
					  || CASE WHEN m.silent AND e.type = 'message.created' THEN jsonb_build_object('silent', true) ELSE '{}'::jsonb END
				ELSE e.data
			END,
			e.type IN ('message.created', 'message.updated', 'message.deleted') AND m.id IS NOT NULL,
			e.exclude_session_id,
			COALESCE(recipients.actor_ids, '{}'::uuid[])
		FROM events e
		LEFT JOIN messages m ON m.org_id = e.org_id AND m.id = e.subject_id
		LEFT JOIN LATERAL (
			SELECT array_agg(recipient.id ORDER BY recipient.id) AS actor_ids
			FROM actors recipient
			LEFT JOIN agents writer ON writer.actor_id = recipient.id AND writer.org_id = recipient.org_id
			WHERE recipient.org_id = e.org_id
			  AND recipient.status = 'active' AND recipient.deleted_at IS NULL
			  -- As in message.Get: in a chat it only writes to, an agent gets
			  -- its own messages and what happens to them, nothing else.
			  AND NOT (
				e.type IN `+messageContentTypes+`
				AND e.chat_id = ANY(COALESCE(writer.write_only_chat_ids, '{}'::uuid[]))
				AND (m.actor_id IS NULL OR m.actor_id <> recipient.id)
			  )
			  AND (e.audience_actor_id IS NULL OR recipient.id = e.audience_actor_id)
			  AND (
				e.chat_id IS NULL OR EXISTS (
					SELECT 1 FROM chat_members cm
					JOIN chats c ON c.org_id = cm.org_id AND c.id = cm.chat_id
					WHERE cm.org_id = e.org_id AND cm.chat_id = e.chat_id
					  AND cm.actor_id = recipient.id
					  AND (c.archived_at IS NULL OR e.type = 'chat.archived')
				)
			  )
		) recipients ON true
		WHERE e.org_id = $1 AND e.seq > $2 AND e.seq <= $3
		ORDER BY e.seq
		LIMIT $4`, orgID, afterSeq, throughSeq, limit)
	if err != nil {
		return nil, fmt.Errorf("read live event batch: %w", err)
	}
	defer rows.Close()
	result := make([]LiveEvent, 0, limit)
	hydrated := make([]int, 0)
	for rows.Next() {
		item := LiveEvent{Frame: Frame{Op: "event"}}
		var isMessage bool
		if err := rows.Scan(&item.Frame.Seq, &item.Frame.Type, &item.Frame.OccurredAt, &item.Frame.ActorID,
			&item.Frame.ChatID, &item.Frame.SubjectID, &item.Frame.Data, &isMessage, &item.ExcludeSessionID,
			&item.RecipientActorIDs); err != nil {
			return nil, fmt.Errorf("scan live event: %w", err)
		}
		// A message nobody may receive is not worth completing.
		if isMessage && len(item.RecipientActorIDs) > 0 {
			hydrated = append(hydrated, len(result))
		}
		result = append(result, item)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate live events: %w", err)
	}
	rows.Close()
	items := make([]message.EventMessage, len(hydrated))
	for index, position := range hydrated {
		items[index] = message.EventMessage{Data: &result[position].Frame.Data}
	}
	if err := message.CompleteEventMessages(ctx, tx, orgID, items); err != nil {
		return nil, fmt.Errorf("complete live message events: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, fmt.Errorf("finish event snapshot: %w", err)
	}
	return result, nil
}
