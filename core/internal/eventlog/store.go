package eventlog

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/comamessenger/comamessenger/core/internal/identity"
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

type Bounds struct {
	CurrentSeq     int64
	MinRetainedSeq int64
}

type Store struct {
	pool *pgxpool.Pool
}

func NewStore(pool *pgxpool.Pool) *Store { return &Store{pool: pool} }

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
// and message hydration happen in the same statement against current membership.
func (s *Store) Replay(ctx context.Context, user identity.User, afterSeq, throughSeq int64, limit int) ([]Frame, error) {
	if throughSeq <= afterSeq || limit < 1 {
		return []Frame{}, nil
	}
	rows, err := s.pool.Query(ctx, `
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
						'forwarded_from', m.forwarded_from
					)
				ELSE e.data
			END
		FROM events e
		LEFT JOIN messages m ON m.org_id = e.org_id AND m.id = e.subject_id
		WHERE e.org_id = $1 AND e.seq > $2 AND e.seq <= $3
		  AND (e.audience_actor_id IS NULL OR e.audience_actor_id = $4)
		  AND (
			e.chat_id IS NULL OR EXISTS (
				SELECT 1
				FROM chat_members cm
				JOIN actors recipient ON recipient.org_id = cm.org_id AND recipient.id = cm.actor_id
				JOIN chats c ON c.org_id = cm.org_id AND c.id = cm.chat_id
				WHERE cm.org_id = e.org_id AND cm.chat_id = e.chat_id AND cm.actor_id = $4
				  AND recipient.status = 'active' AND recipient.deleted_at IS NULL
				  AND c.archived_at IS NULL
			)
		  )
		ORDER BY e.seq
		LIMIT $5`, user.OrgID, afterSeq, throughSeq, user.ActorID, limit)
	if err != nil {
		return nil, fmt.Errorf("replay visible events: %w", err)
	}
	defer rows.Close()
	result := make([]Frame, 0)
	for rows.Next() {
		frame := Frame{Op: "event"}
		if err := rows.Scan(&frame.Seq, &frame.Type, &frame.OccurredAt, &frame.ActorID, &frame.ChatID, &frame.SubjectID, &frame.Data); err != nil {
			return nil, fmt.Errorf("scan visible event: %w", err)
		}
		result = append(result, frame)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate visible events: %w", err)
	}
	return result, nil
}
