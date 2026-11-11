package message

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/jackc/pgx/v5"
)

// EventMessage is one message.* event frame waiting for the fields the feed
// shows but the event row does not carry.
type EventMessage struct {
	// Data is the message row serialized by the event store; replaced in place.
	Data *json.RawMessage
}

// CompleteEventMessages gives realtime message frames the shape of the REST
// feed: files (metadata only, never a signed link), thread_reply_count and
// agent_provenance. A thread reply also carries thread_root_reply_count, the
// root's current count, so a client sets it instead of guessing ±1.
//
// The whole batch costs at most four queries, whatever its size: reply
// counts, files, provenance and root counts, each by ANY(ids). Every frame of
// one message gets the same values, read in the caller's snapshot.
func CompleteEventMessages(ctx context.Context, tx pgx.Tx, orgID string, items []EventMessage) error {
	if len(items) == 0 {
		return nil
	}
	decoded := make([]Message, len(items))
	unique := make([]Message, 0, len(items))
	position := make(map[string]int, len(items))
	for index, item := range items {
		if err := json.Unmarshal(*item.Data, &decoded[index]); err != nil {
			return fmt.Errorf("decode message event: %w", err)
		}
		if _, seen := position[decoded[index].ID]; !seen {
			position[decoded[index].ID] = len(unique)
			unique = append(unique, decoded[index])
		}
	}
	if err := hydrateThreadReplyCounts(ctx, tx, orgID, unique); err != nil {
		return err
	}
	if err := hydrateFiles(ctx, tx, orgID, unique); err != nil {
		return err
	}
	rootCounts, err := threadRootReplyCounts(ctx, tx, orgID, unique)
	if err != nil {
		return err
	}
	for index := range items {
		message := decoded[index]
		full := unique[position[message.ID]]
		message.ThreadReplyCount = full.ThreadReplyCount
		message.Files = full.Files
		message.AgentProvenance = full.AgentProvenance
		if message.ThreadRootID != nil {
			count := rootCounts[*message.ThreadRootID]
			message.ThreadRootReplyCount = &count
		}
		encoded, err := json.Marshal(message)
		if err != nil {
			return fmt.Errorf("encode message event: %w", err)
		}
		*items[index].Data = encoded
	}
	return nil
}

// threadRootReplyCounts counts live replies of the roots the batch's replies
// belong to, as hydrateThreadReplyCounts would show on the root: a deleted
// root shows zero.
func threadRootReplyCounts(ctx context.Context, tx pgx.Tx, orgID string, messages []Message) (map[string]int64, error) {
	roots := make([]string, 0)
	seen := make(map[string]struct{})
	for _, item := range messages {
		if item.ThreadRootID == nil {
			continue
		}
		if _, ok := seen[*item.ThreadRootID]; ok {
			continue
		}
		seen[*item.ThreadRootID] = struct{}{}
		roots = append(roots, *item.ThreadRootID)
	}
	counts := make(map[string]int64, len(roots))
	if len(roots) == 0 {
		return counts, nil
	}
	rows, err := tx.Query(ctx, `
		SELECT reply.thread_root_id, count(*)
		FROM messages reply
		JOIN messages root ON root.org_id = reply.org_id AND root.id = reply.thread_root_id
		WHERE reply.org_id = $1 AND reply.thread_root_id = ANY($2::uuid[])
		  AND reply.deleted_at IS NULL AND root.deleted_at IS NULL
		GROUP BY reply.thread_root_id`, orgID, roots)
	if err != nil {
		return nil, fmt.Errorf("load thread root reply counts: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var rootID string
		var count int64
		if err := rows.Scan(&rootID, &count); err != nil {
			return nil, fmt.Errorf("scan thread root reply count: %w", err)
		}
		counts[rootID] = count
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate thread root reply counts: %w", err)
	}
	return counts, nil
}
