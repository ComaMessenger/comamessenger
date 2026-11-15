package poll

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/comamessenger/comamessenger/core/internal/identity"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// WaitingSQL lists the open polls with a due date the reader ($actor in
// $org) may vote in and has not voted in, readable by them now (decision 14:
// polls without a due date never wait): columns message_id, chat_id, due_at,
// created_at (of the message). It is the rule of «Ждут вас» and the counters.
func WaitingSQL(org, actor string) string {
	return strings.NewReplacer("$org", org, "$actor", actor).Replace(`
	SELECT p.message_id, p.chat_id, p.due_at, m.created_at
	FROM message_polls p
	JOIN messages m ON m.org_id = p.org_id AND m.id = p.message_id AND m.deleted_at IS NULL
	JOIN chats c ON c.org_id = p.org_id AND c.id = p.chat_id AND c.archived_at IS NULL
	JOIN chat_members vcm ON vcm.org_id = p.org_id AND vcm.chat_id = p.chat_id AND vcm.actor_id = $actor
	JOIN actors va ON va.org_id = p.org_id AND va.id = vcm.actor_id AND va.type = 'user' AND va.status = 'active' AND va.deleted_at IS NULL
	WHERE p.org_id = $org AND p.status = 'open' AND p.due_at IS NOT NULL
	  AND NOT EXISTS (SELECT 1 FROM message_poll_voters wv WHERE wv.message_id = p.message_id AND wv.actor_id = $actor)`)
}

// ChatWaiting is the reader's waiting polls in one chat.
type ChatWaiting struct {
	Count int64
	Hot   int64
}

// WaitingByChat counts the reader's waiting polls per chat with the rule of
// «Ждут вас»; Hot counts those due within 24 hours of now.
func WaitingByChat(ctx context.Context, q querier, user identity.User, now time.Time) (map[string]ChatWaiting, error) {
	rows, err := q.Query(ctx, `
		SELECT w.chat_id, count(*), count(*) FILTER (WHERE w.due_at < $3)
		FROM (`+WaitingSQL("$1", "$2")+`) w
		GROUP BY w.chat_id`, user.OrgID, user.ActorID, now.Add(HotWithin))
	if err != nil {
		return nil, fmt.Errorf("count waiting polls: %w", err)
	}
	defer rows.Close()
	result := map[string]ChatWaiting{}
	for rows.Next() {
		var chatID string
		var item ChatWaiting
		if err := rows.Scan(&chatID, &item.Count, &item.Hot); err != nil {
			return nil, fmt.Errorf("scan waiting polls: %w", err)
		}
		result[chatID] = item
	}
	return result, rows.Err()
}

// VotersOptions are the parameters of listPollVoters.
type VotersOptions struct {
	Filter string
	Cursor *string
	Limit  int
}

// Voter is PollVoter.
type Voter struct {
	ActorID string     `json:"actor_id"`
	VotedAt *time.Time `json:"voted_at"`
	InChat  bool       `json:"in_chat"`
}

type VoterPage struct {
	Items      []Voter `json:"items"`
	NextCursor *string `json:"next_cursor"`
}

type voterCursor struct {
	Filter string `json:"f"`
	At     int64  `json:"t,omitempty"`
	Name   string `json:"n,omitempty"`
	ID     string `json:"i"`
}

func encodeVoterCursor(c voterCursor) string {
	raw, _ := json.Marshal(c)
	return base64.RawURLEncoding.EncodeToString(raw)
}

func decodeVoterCursor(value, filter string) (voterCursor, error) {
	raw, err := base64.RawURLEncoding.DecodeString(value)
	var c voterCursor
	if err != nil || json.Unmarshal(raw, &c) != nil || c.Filter != filter || uuid.Validate(c.ID) != nil {
		return voterCursor{}, invalid("cursor", "cursor is malformed")
	}
	return c, nil
}

// Voters is listPollVoters. option:<i> needs can_view_voters: an ordinary
// poll whose results the reader may see. waiting needs can_view_waiting:
// the author or a chat admin of an ordinary poll. An anonymous poll lists
// nobody, to anybody. Access and the chat role are read on every call.
func (s *Service) Voters(ctx context.Context, user identity.User, messageID string, options VotersOptions) (VoterPage, error) {
	option := -1
	switch {
	case options.Filter == "waiting":
	case strings.HasPrefix(options.Filter, "option:") && len(options.Filter) == len("option:")+1:
		value, err := strconv.Atoi(strings.TrimPrefix(options.Filter, "option:"))
		if err != nil || value < 0 || value > 9 {
			return VoterPage{}, invalid("filter", "filter must be option:<0-9> or waiting")
		}
		option = value
	default:
		return VoterPage{}, invalid("filter", "filter must be option:<0-9> or waiting")
	}
	limit := options.Limit
	if limit == 0 {
		limit = 50
	}
	if limit < 1 || limit > 100 {
		return VoterPage{}, invalid("limit", "limit must be between 1 and 100")
	}
	var cursor *voterCursor
	if options.Cursor != nil {
		decoded, err := decodeVoterCursor(*options.Cursor, options.Filter)
		if err != nil {
			return VoterPage{}, err
		}
		cursor = &decoded
	}
	if uuid.Validate(messageID) != nil {
		return VoterPage{}, ErrNotFound
	}
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{AccessMode: pgx.ReadOnly, IsoLevel: pgx.RepeatableRead})
	if err != nil {
		return VoterPage{}, fmt.Errorf("begin poll voters: %w", err)
	}
	defer tx.Rollback(ctx)
	if err := visible(ctx, tx, user, messageID); err != nil {
		return VoterPage{}, err
	}
	state, err := s.state(ctx, tx, user, messageID)
	if err != nil {
		return VoterPage{}, err
	}
	page := VoterPage{Items: []Voter{}}
	var rows pgx.Rows
	if option >= 0 {
		if !state.Viewer.CanViewVoters || state.Poll.Anonymous {
			return VoterPage{}, ErrForbidden
		}
		if option >= len(state.Poll.Options) {
			return VoterPage{}, invalid("filter", "the option does not exist")
		}
		var at *int64
		var after *string
		if cursor != nil {
			at, after = &cursor.At, &cursor.ID
		}
		rows, err = tx.Query(ctx, `
			SELECT v.actor_id, v.voted_at, EXISTS (SELECT 1 FROM chat_members cm
				JOIN actors a ON a.org_id = cm.org_id AND a.id = cm.actor_id AND `+activePerson("a")+`
				WHERE cm.org_id = v.org_id AND cm.chat_id = $5 AND cm.actor_id = v.actor_id), ''
			FROM message_poll_voters v
			JOIN message_polls p ON p.message_id = v.message_id AND NOT p.anonymous
			WHERE v.org_id = $1 AND v.message_id = $2
			  AND EXISTS (SELECT 1 FROM message_poll_votes o WHERE o.message_id = v.message_id AND o.actor_id = v.actor_id AND o.option_index = $3)
			  AND ($6::bigint IS NULL OR (-(extract(epoch FROM v.voted_at) * 1000000)::bigint, v.actor_id) > ($6::bigint, $7::uuid))
			ORDER BY -(extract(epoch FROM v.voted_at) * 1000000)::bigint, v.actor_id
			LIMIT $4`, user.OrgID, messageID, option, limit+1, chatOf(ctx, tx, user.OrgID, messageID), at, after)
	} else {
		if !state.Viewer.CanViewWaiting || state.Poll.Anonymous {
			return VoterPage{}, ErrForbidden
		}
		var name, after *string
		if cursor != nil {
			name, after = &cursor.Name, &cursor.ID
		}
		rows, err = tx.Query(ctx, `
			SELECT cm.actor_id, NULL::timestamptz, true, a.display_name
			FROM chat_members cm
			JOIN actors a ON a.org_id = cm.org_id AND a.id = cm.actor_id AND `+activePerson("a")+`
			JOIN message_polls p ON p.org_id = cm.org_id AND p.chat_id = cm.chat_id AND p.message_id = $2 AND NOT p.anonymous
			WHERE cm.org_id = $1
			  AND NOT EXISTS (SELECT 1 FROM message_poll_voters v WHERE v.message_id = p.message_id AND v.actor_id = cm.actor_id)
			  AND ($4::text IS NULL OR (a.display_name, cm.actor_id) > ($4::text, $5::uuid))
			ORDER BY a.display_name, cm.actor_id
			LIMIT $3`, user.OrgID, messageID, limit+1, name, after)
	}
	if err != nil {
		return VoterPage{}, fmt.Errorf("list poll voters: %w", err)
	}
	names := []string{}
	for rows.Next() {
		var item Voter
		var name string
		if err := rows.Scan(&item.ActorID, &item.VotedAt, &item.InChat, &name); err != nil {
			rows.Close()
			return VoterPage{}, fmt.Errorf("scan poll voter: %w", err)
		}
		page.Items = append(page.Items, item)
		names = append(names, name)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return VoterPage{}, fmt.Errorf("iterate poll voters: %w", err)
	}
	if len(page.Items) > limit {
		page.Items = page.Items[:limit]
		last := page.Items[limit-1]
		next := voterCursor{Filter: options.Filter, ID: last.ActorID}
		if option >= 0 && last.VotedAt != nil {
			next.At = -last.VotedAt.UnixMicro()
		} else {
			next.Name = names[limit-1]
		}
		value := encodeVoterCursor(next)
		page.NextCursor = &value
	}
	return page, tx.Commit(ctx)
}

func chatOf(ctx context.Context, q querier, orgID, messageID string) string {
	var chatID string
	_ = q.QueryRow(ctx, `SELECT chat_id FROM message_polls WHERE org_id = $1 AND message_id = $2`, orgID, messageID).Scan(&chatID)
	return chatID
}
