package task

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/comamessenger/comamessenger/core/internal/identity"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// VisibleSQL is the reading rule of a task `t` for the reader $viewer: the
// message is not deleted, the chat is not archived and the reader is an
// active person who is a member of it now. It joins `m` and `c`.
func VisibleSQL(viewer string) string {
	return strings.ReplaceAll(`
	JOIN messages m ON m.org_id = t.org_id AND m.id = t.message_id AND m.deleted_at IS NULL
	JOIN chats c ON c.org_id = t.org_id AND c.id = t.chat_id AND c.archived_at IS NULL
	JOIN chat_members vcm ON vcm.org_id = t.org_id AND vcm.chat_id = t.chat_id AND vcm.actor_id = $viewer
	JOIN actors va ON va.org_id = t.org_id AND va.id = vcm.actor_id AND va.type = 'user' AND va.status = 'active' AND va.deleted_at IS NULL`,
		"$viewer", viewer)
}

// RoleSQL is the reader's role in an active task `t`: responsible,
// assignee of an open item, or candidate of a queue nobody has taken, in
// this order; NULL when none applies.
func RoleSQL(viewer string) string {
	return strings.ReplaceAll(`CASE
		WHEN t.assignee_id = $viewer THEN 'responsible'
		WHEN EXISTS (SELECT 1 FROM message_task_items ri WHERE ri.message_id = t.message_id AND ri.assignee_id = $viewer AND ri.done_at IS NULL) THEN 'item'
		WHEN t.assignee_id IS NULL AND t.assignee_kind <> 'person'
			AND EXISTS (SELECT 1 FROM message_task_candidates rc WHERE rc.message_id = t.message_id AND rc.actor_id = $viewer) THEN 'candidate'
	END`, "$viewer", viewer)
}

// MineSQL lists the active tasks the reader ($actor in $org) is concerned
// with, readable by them now: columns message_id, chat_id, due_at,
// created_at (of the message) and role. It is the rule of «Ждут вас», the
// counters and the slot.
func MineSQL(org, actor string) string {
	return strings.NewReplacer("$org", org, "$actor", actor).Replace(`
	SELECT t.message_id, t.chat_id, t.due_at, m.created_at, ` + RoleSQL("$actor") + ` AS role
	FROM (
		SELECT message_id FROM message_tasks WHERE org_id = $org AND assignee_id = $actor AND status IN ('open', 'in_progress')
		UNION
		SELECT message_id FROM message_task_items WHERE org_id = $org AND assignee_id = $actor AND done_at IS NULL
		UNION
		SELECT mc.message_id FROM message_task_candidates mc
		JOIN message_tasks mt ON mt.message_id = mc.message_id AND mt.assignee_id IS NULL AND mt.status IN ('open', 'in_progress')
		WHERE mc.org_id = $org AND mc.actor_id = $actor
	) mine
	JOIN message_tasks t ON t.message_id = mine.message_id AND t.org_id = $org AND t.status IN ('open', 'in_progress')
	` + VisibleSQL("$actor") + `
	WHERE ` + RoleSQL("$actor") + ` IS NOT NULL`)
}

// ChatMine is the reader's open tasks in one chat.
type ChatMine struct {
	Count     int64
	Hot       int64
	NextDueAt *time.Time
}

// MineByChat counts the reader's open tasks per chat with the rule of
// «Ждут вас»; Hot counts those overdue or due within 24 hours of now.
func MineByChat(ctx context.Context, q querier, user identity.User, now time.Time) (map[string]ChatMine, error) {
	rows, err := q.Query(ctx, `
		SELECT mine.chat_id, count(*), count(*) FILTER (WHERE mine.due_at < $3), min(mine.due_at)
		FROM (`+MineSQL("$1", "$2")+`) mine
		GROUP BY mine.chat_id`, user.OrgID, user.ActorID, now.Add(HotWithin))
	if err != nil {
		return nil, fmt.Errorf("count my tasks: %w", err)
	}
	defer rows.Close()
	result := map[string]ChatMine{}
	for rows.Next() {
		var chatID string
		var item ChatMine
		if err := rows.Scan(&chatID, &item.Count, &item.Hot, &item.NextDueAt); err != nil {
			return nil, fmt.Errorf("scan my tasks: %w", err)
		}
		result[chatID] = item
	}
	return result, rows.Err()
}

// Cursor is a position in an ordered task list: (rank, key, message id),
// ascending. Open lists: rank 0 has a due date (key = due date), rank 1 has
// none (key = minus the creation time). Closed lists: rank 0, key = minus
// the status change time.
type Cursor struct {
	Rank      int
	Key       int64
	MessageID string
}

func EncodeCursor(c Cursor) string {
	return base64.RawURLEncoding.EncodeToString([]byte(strconv.Itoa(c.Rank) + "." + strconv.FormatInt(c.Key, 10) + "." + c.MessageID))
}

func DecodeCursor(value string) (Cursor, error) {
	raw, err := base64.RawURLEncoding.DecodeString(value)
	parts := strings.SplitN(string(raw), ".", 3)
	if err != nil || len(parts) != 3 {
		return Cursor{}, invalid("cursor", "cursor is malformed")
	}
	rank, rankErr := strconv.Atoi(parts[0])
	key, keyErr := strconv.ParseInt(parts[1], 10, 64)
	if rankErr != nil || keyErr != nil || (rank != 0 && rank != 1) || uuid.Validate(parts[2]) != nil {
		return Cursor{}, invalid("cursor", "cursor is malformed")
	}
	return Cursor{Rank: rank, Key: key, MessageID: parts[2]}, nil
}

// OpenRank and OpenKey order active items: due date first, earliest first;
// then without one, newest first. due and created are SQL expressions.
func OpenRank(due string) string { return `(CASE WHEN ` + due + ` IS NULL THEN 1 ELSE 0 END)` }
func OpenKey(due, created string) string {
	return `((CASE WHEN ` + due + ` IS NULL THEN -extract(epoch FROM ` + created + `) ELSE extract(epoch FROM ` + due + `) END) * 1000000)::bigint`
}

const closedKey = `(-extract(epoch FROM t.status_changed_at) * 1000000)::bigint`

// Row is one task of a list: its message and why the reader sees it.
type Row struct {
	MessageID string
	Role      string
}

// Page is one page of task message ids, in order.
type Page struct {
	Rows       []Row
	NextCursor *string
}

func limitOf(value int) (int, error) {
	if value == 0 {
		return 50, nil
	}
	if value < 1 || value > 100 {
		return 0, invalid("limit", "limit must be between 1 and 100")
	}
	return value, nil
}

func cursorArgs(value *string) (*int, *int64, *string, error) {
	if value == nil {
		return nil, nil, nil, nil
	}
	decoded, err := DecodeCursor(*value)
	if err != nil {
		return nil, nil, nil, err
	}
	return &decoded.Rank, &decoded.Key, &decoded.MessageID, nil
}

// scanPage reads rows (rank, key, message_id, role) with one row too many
// and cuts the page.
func scanPage(rows pgx.Rows, limit int) (Page, error) {
	defer rows.Close()
	type position struct {
		rank int
		key  int64
	}
	page := Page{Rows: []Row{}}
	positions := []position{}
	for rows.Next() {
		var pos position
		var row Row
		var role *string
		if err := rows.Scan(&pos.rank, &pos.key, &row.MessageID, &role); err != nil {
			return Page{}, fmt.Errorf("scan task list: %w", err)
		}
		if role != nil {
			row.Role = *role
		}
		page.Rows = append(page.Rows, row)
		positions = append(positions, pos)
	}
	if err := rows.Err(); err != nil {
		return Page{}, fmt.Errorf("iterate task list: %w", err)
	}
	if len(page.Rows) > limit {
		page.Rows = page.Rows[:limit]
		last := positions[limit-1]
		value := EncodeCursor(Cursor{Rank: last.rank, Key: last.key, MessageID: page.Rows[limit-1].MessageID})
		page.NextCursor = &value
	}
	return page, nil
}

// ChatCounts is ChatTaskCounts.
type ChatCounts struct {
	Open    int64 `json:"open"`
	Mine    int64 `json:"mine"`
	MineHot int64 `json:"mine_hot"`
}

// ChatListOptions are the parameters of listChatTasks.
type ChatListOptions struct {
	State  string
	Cursor *string
	Limit  int
}

// ListChat lists the tasks of a chat for a member (ErrNotMember otherwise).
// An archived chat lists nothing: its tasks are hidden from the slot.
func ListChat(ctx context.Context, q querier, user identity.User, chatID string, options ChatListOptions, now time.Time) (Page, ChatCounts, error) {
	if uuid.Validate(chatID) != nil {
		return Page{}, ChatCounts{}, ErrNotMember
	}
	if options.State == "" {
		options.State = StatusOpen
	}
	if options.State != StatusOpen && options.State != StatusDone && options.State != StatusCanceled {
		return Page{}, ChatCounts{}, invalid("state", "state must be open, done or canceled")
	}
	limit, err := limitOf(options.Limit)
	if err != nil {
		return Page{}, ChatCounts{}, err
	}
	rank, key, cursorID, err := cursorArgs(options.Cursor)
	if err != nil {
		return Page{}, ChatCounts{}, err
	}
	var member bool
	if err := q.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM chat_members cm
		JOIN actors a ON a.org_id = cm.org_id AND a.id = cm.actor_id AND a.type = 'user' AND a.status = 'active' AND a.deleted_at IS NULL
		WHERE cm.org_id = $1 AND cm.chat_id = $2 AND cm.actor_id = $3)`, user.OrgID, chatID, user.ActorID).Scan(&member); err != nil {
		return Page{}, ChatCounts{}, fmt.Errorf("check task chat membership: %w", err)
	}
	if !member {
		return Page{}, ChatCounts{}, ErrNotMember
	}
	counts := ChatCounts{}
	if err := q.QueryRow(ctx, `
		SELECT
			(SELECT count(*) FROM message_tasks t `+VisibleSQL("$3")+`
			 WHERE t.org_id = $1 AND t.chat_id = $2 AND t.status IN ('open', 'in_progress')),
			count(*), count(*) FILTER (WHERE mine.due_at < $4)
		FROM (`+MineSQL("$1", "$3")+`) mine WHERE mine.chat_id = $2`,
		user.OrgID, chatID, user.ActorID, now.Add(HotWithin)).Scan(&counts.Open, &counts.Mine, &counts.MineHot); err != nil {
		return Page{}, ChatCounts{}, fmt.Errorf("count chat tasks: %w", err)
	}
	rankExpr, keyExpr := OpenRank("t.due_at"), OpenKey("t.due_at", "m.created_at")
	statusFilter := `t.status IN ('open', 'in_progress')`
	if options.State != StatusOpen {
		rankExpr, keyExpr, statusFilter = `0`, closedKey, `t.status = $8`
	}
	rows, err := q.Query(ctx, `
		SELECT `+rankExpr+`, `+keyExpr+`, t.message_id, NULL::text
		FROM message_tasks t `+VisibleSQL("$3")+`
		WHERE t.org_id = $1 AND t.chat_id = $2 AND `+statusFilter+`
		  AND ($4::int IS NULL OR (`+rankExpr+`, `+keyExpr+`, t.message_id) > ($4::int, $5::bigint, $6::uuid))
		  AND $8::text IS NOT NULL
		ORDER BY 1, 2, t.message_id
		LIMIT $7`, user.OrgID, chatID, user.ActorID, rank, key, cursorID, limit+1, options.State)
	if err != nil {
		return Page{}, ChatCounts{}, fmt.Errorf("list chat tasks: %w", err)
	}
	page, err := scanPage(rows, limit)
	return page, counts, err
}

// MineListOptions are the parameters of listMyTasks.
type MineListOptions struct {
	Role   string
	State  string
	Cursor *string
	Limit  int
}

// ClosedWindow is how far back «Готово за 7 дней» reaches.
const ClosedWindow = 7 * 24 * time.Hour

// ListMine lists the reader's tasks from all chats they can read now.
func ListMine(ctx context.Context, q querier, user identity.User, options MineListOptions, now time.Time) (Page, error) {
	if options.Role == "" {
		options.Role = "assigned"
	}
	if options.State == "" {
		options.State = StatusOpen
	}
	if options.Role != "assigned" && options.Role != "authored" {
		return Page{}, invalid("role", "role must be assigned or authored")
	}
	if options.State != StatusOpen && options.State != StatusDone {
		return Page{}, invalid("state", "state must be open or done")
	}
	limit, err := limitOf(options.Limit)
	if err != nil {
		return Page{}, err
	}
	rank, key, cursorID, err := cursorArgs(options.Cursor)
	if err != nil {
		return Page{}, err
	}
	var query string
	switch {
	case options.Role == "assigned" && options.State == StatusOpen:
		query = `
		SELECT ` + OpenRank("mine.due_at") + `, ` + OpenKey("mine.due_at", "mine.created_at") + `, mine.message_id, mine.role
		FROM (` + MineSQL("$1", "$2") + `) mine
		WHERE ($3::int IS NULL OR (` + OpenRank("mine.due_at") + `, ` + OpenKey("mine.due_at", "mine.created_at") + `, mine.message_id) > ($3::int, $4::bigint, $5::uuid))
		  AND $7::timestamptz IS NOT NULL
		ORDER BY 1, 2, mine.message_id LIMIT $6`
	case options.Role == "assigned":
		query = `
		SELECT 0, ` + closedKey + `, t.message_id,
			CASE WHEN t.assignee_id = $2 THEN 'responsible' ELSE 'item' END
		FROM message_tasks t ` + VisibleSQL("$2") + `
		WHERE t.org_id = $1 AND t.status IN ('done', 'canceled') AND t.status_changed_at > $7
		  AND (t.assignee_id = $2 OR EXISTS (SELECT 1 FROM message_task_items i WHERE i.message_id = t.message_id AND i.assignee_id = $2))
		  AND ($3::int IS NULL OR (0, ` + closedKey + `, t.message_id) > ($3::int, $4::bigint, $5::uuid))
		ORDER BY 1, 2, t.message_id LIMIT $6`
	case options.State == StatusOpen:
		query = `
		SELECT ` + OpenRank("t.due_at") + `, ` + OpenKey("t.due_at", "m.created_at") + `, t.message_id, 'author'
		FROM message_tasks t ` + VisibleSQL("$2") + `
		WHERE t.org_id = $1 AND t.author_id = $2 AND t.status IN ('open', 'in_progress')
		  AND ($3::int IS NULL OR (` + OpenRank("t.due_at") + `, ` + OpenKey("t.due_at", "m.created_at") + `, t.message_id) > ($3::int, $4::bigint, $5::uuid))
		  AND $7::timestamptz IS NOT NULL
		ORDER BY 1, 2, t.message_id LIMIT $6`
	default:
		query = `
		SELECT 0, ` + closedKey + `, t.message_id, 'author'
		FROM message_tasks t ` + VisibleSQL("$2") + `
		WHERE t.org_id = $1 AND t.author_id = $2 AND t.status IN ('done', 'canceled') AND t.status_changed_at > $7
		  AND ($3::int IS NULL OR (0, ` + closedKey + `, t.message_id) > ($3::int, $4::bigint, $5::uuid))
		ORDER BY 1, 2, t.message_id LIMIT $6`
	}
	rows, err := q.Query(ctx, query, user.OrgID, user.ActorID, rank, key, cursorID, limit+1, now.Add(-ClosedWindow))
	if err != nil {
		return Page{}, fmt.Errorf("list my tasks: %w", err)
	}
	return scanPage(rows, limit)
}

// Get checks that the reader may read the task message: an active member
// of its chat, the chat not archived (as message.Get), the message not
// deleted. ErrNotFound otherwise, also for a
// message that is not a task.
func Get(ctx context.Context, q querier, user identity.User, messageID string) error {
	if uuid.Validate(messageID) != nil {
		return ErrNotFound
	}
	var ok bool
	err := q.QueryRow(ctx, `
		SELECT true FROM message_tasks t
		JOIN messages m ON m.org_id = t.org_id AND m.id = t.message_id AND m.deleted_at IS NULL
		JOIN chats c ON c.org_id = t.org_id AND c.id = t.chat_id AND c.archived_at IS NULL
		JOIN chat_members vcm ON vcm.org_id = t.org_id AND vcm.chat_id = t.chat_id AND vcm.actor_id = $3
		JOIN actors va ON va.org_id = t.org_id AND va.id = vcm.actor_id AND va.status = 'active' AND va.deleted_at IS NULL
		WHERE t.org_id = $1 AND t.message_id = $2
		  AND NOT EXISTS (SELECT 1 FROM agents writer WHERE writer.org_id = t.org_id AND writer.actor_id = $3
			AND t.chat_id = ANY(COALESCE(writer.write_only_chat_ids, '{}'::uuid[])) AND m.actor_id <> $3)`,
		user.OrgID, messageID, user.ActorID).Scan(&ok)
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrNotFound
	}
	if err != nil {
		return fmt.Errorf("find task: %w", err)
	}
	return nil
}
