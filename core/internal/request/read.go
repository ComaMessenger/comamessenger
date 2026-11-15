package request

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/comamessenger/comamessenger/core/internal/identity"
	"github.com/comamessenger/comamessenger/core/internal/permission"
	"github.com/jackc/pgx/v5"
)

// Summaries loads the shared part of the requests among messageIDs, one
// query for the whole batch. Messages that are not requests are absent from
// the result. The denominator of «N из M» is computed now: recipients who
// answered plus those without an answer who are still active members.
func Summaries(ctx context.Context, q querier, orgID string, messageIDs []string) (map[string]*Summary, error) {
	result := make(map[string]*Summary, len(messageIDs))
	if len(messageIDs) == 0 {
		return result, nil
	}
	rows, err := q.Query(ctx, `
		SELECT r.message_id, r.status, r.closed_reason, r.answer_preset, r.custom_options, r.allow_comment,
			r.due_at, r.auto_remind_at, r.audience_kind, r.audience_label, r.answered_count, r.version,
			r.audience_department_id, r.audience_position_id,
			(SELECT count(*) FROM message_request_recipients rr `+recipientInChat+`
			 WHERE rr.message_id = r.message_id AND rr.answered_at IS NULL)
		FROM message_requests r
		WHERE r.org_id = $1 AND r.message_id = ANY($2::uuid[])`, orgID, messageIDs)
	if err != nil {
		return nil, fmt.Errorf("load requests: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var messageID string
		var item Summary
		var options []string
		if err := rows.Scan(&messageID, &item.Status, &item.ClosedReason, &item.Answer.Preset, &options, &item.AllowComment,
			&item.DueAt, &item.AutoRemindAt, &item.Audience.Kind, &item.Audience.Label, &item.AnsweredCount, &item.Version,
			&item.Audience.DepartmentID, &item.Audience.PositionID,
			&item.WaitingCount); err != nil {
			return nil, fmt.Errorf("scan request: %w", err)
		}
		if item.Answer.Preset == PresetCustom {
			item.Answer.Options = options
		}
		item.Audience.Count = item.AnsweredCount + item.WaitingCount
		result[messageID] = &item
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate requests: %w", err)
	}
	return result, nil
}

// viewerRow is everything Viewers needs about one request and one reader.
type viewerRow struct {
	messageID, authorID, status string
	dueAt, lastRemind           *time.Time
	preset                      string
	options, remindCount        int
	deleted, archived           bool
	member                      bool
	chatRole                    string
	recipient                   bool
	answer                      *ViewerAnswer
	waiting                     int
}

// Viewers computes the reader's view of the requests among messageIDs:
// two queries for the whole batch (the view and, for those who may see it,
// the tally). Access is derived from the current membership and chat role
// of user on every call; nothing about it is stored. Only active people get
// a view: agents read requests as plain text (wave 1), even as chat admins.
func Viewers(ctx context.Context, q querier, user identity.User, now time.Time, limits Limits, messageIDs []string) (map[string]*Viewer, error) {
	result := make(map[string]*Viewer, len(messageIDs))
	if len(messageIDs) == 0 {
		return result, nil
	}
	rows, err := q.Query(ctx, `
		SELECT r.message_id, r.author_id, r.status, r.due_at, r.last_manual_remind_at, r.answer_preset,
			cardinality(r.custom_options), r.manual_remind_count,
			m.deleted_at IS NOT NULL, c.archived_at IS NOT NULL,
			cm.actor_id IS NOT NULL, COALESCE(cm.role, ''),
			mine.actor_id IS NOT NULL, mine.option_index, mine.comment, mine.answered_at, COALESCE(mine.answered_late, false),
			COALESCE(mine.version, 0),
			CASE WHEN r.author_id = $3 THEN
				(SELECT count(*) FROM message_request_recipients rr `+recipientInChat+`
				 WHERE rr.message_id = r.message_id AND rr.answered_at IS NULL)
			ELSE 0 END
		FROM message_requests r
		JOIN messages m ON m.org_id = r.org_id AND m.id = r.message_id
		JOIN chats c ON c.org_id = r.org_id AND c.id = r.chat_id
		LEFT JOIN chat_members cm ON cm.org_id = r.org_id AND cm.chat_id = r.chat_id AND cm.actor_id = $3
		JOIN actors viewer ON viewer.org_id = r.org_id AND viewer.id = $3 AND viewer.type = 'user'
			AND viewer.status = 'active' AND viewer.deleted_at IS NULL
		LEFT JOIN message_request_recipients mine ON mine.message_id = r.message_id AND mine.actor_id = $3
		WHERE r.org_id = $1 AND r.message_id = ANY($2::uuid[])`, user.OrgID, messageIDs, user.ActorID)
	if err != nil {
		return nil, fmt.Errorf("load request viewers: %w", err)
	}
	defer rows.Close()
	items := make([]viewerRow, 0, len(messageIDs))
	for rows.Next() {
		var row viewerRow
		var option *int16
		var comment *string
		var answeredAt *time.Time
		var late bool
		var version int
		if err := rows.Scan(&row.messageID, &row.authorID, &row.status, &row.dueAt, &row.lastRemind, &row.preset,
			&row.options, &row.remindCount, &row.deleted, &row.archived, &row.member, &row.chatRole,
			&row.recipient, &option, &comment, &answeredAt, &late, &version, &row.waiting); err != nil {
			return nil, fmt.Errorf("scan request viewer: %w", err)
		}
		row.options = OptionCount(row.preset, row.options)
		if option != nil && answeredAt != nil {
			row.answer = &ViewerAnswer{Option: int(*option), AnsweredAt: *answeredAt, Late: late, Version: version}
			if comment != nil {
				row.answer.Comment = *comment
			}
		}
		items = append(items, row)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate request viewers: %w", err)
	}
	rows.Close()
	tallyIDs := make([]string, 0)
	for _, row := range items {
		viewer := buildViewer(row, user, now, limits)
		result[row.messageID] = &viewer
		if viewer.CanViewAnswers {
			tallyIDs = append(tallyIDs, row.messageID)
		}
	}
	if len(tallyIDs) > 0 {
		tallies, err := loadTallies(ctx, q, user.OrgID, tallyIDs)
		if err != nil {
			return nil, err
		}
		for _, row := range items {
			if viewer := result[row.messageID]; viewer.CanViewAnswers {
				viewer.Tally = tallyOf(tallies[row.messageID], row.options)
			}
		}
	}
	return result, nil
}

// canModerate: a chat owner or admin, or a workspace moderator with
// chats.moderate, while a member of the chat.
func canModerate(user identity.User, member bool, chatRole string) bool {
	if !member {
		return false
	}
	return chatRole == "owner" || chatRole == "admin" || permission.Allows(user.OrgRole, user.Permissions, permission.ChatsModerate)
}

func buildViewer(row viewerRow, user identity.User, now time.Time, limits Limits) Viewer {
	viewer := Viewer{Role: "observer", Answer: nil}
	isAuthor := row.authorID == user.ActorID
	switch {
	case isAuthor:
		viewer.Role = "author"
	case row.recipient:
		viewer.Role = "recipient"
		viewer.Answer = row.answer
	}
	live := row.member && !row.deleted && !row.archived
	open := live && row.status == "open"
	beforeDue := row.dueAt == nil || now.Before(*row.dueAt)
	viewer.CanAnswer = open && row.recipient
	viewer.CanChange = open && row.recipient && row.answer != nil && beforeDue
	viewer.CanViewAnswers = !row.deleted && !row.archived && (isAuthor && row.member || canModerate(user, row.member, row.chatRole))
	viewer.CanClose = open && (isAuthor || canModerate(user, row.member, row.chatRole))
	if isAuthor && open && row.remindCount < limits.ManualRemindMax {
		next := time.Time{}
		if row.lastRemind != nil {
			next = row.lastRemind.Add(limits.ManualRemindInterval)
		}
		if now.Before(next) {
			viewer.NextRemindAt = &next
		} else {
			viewer.CanRemind = row.waiting > 0
		}
	}
	return viewer
}

// loadTallies counts answers per option, all recipients who answered
// included (also those who left since: their answer counts).
func loadTallies(ctx context.Context, q querier, orgID string, messageIDs []string) (map[string]map[int]int, error) {
	rows, err := q.Query(ctx, `
		SELECT message_id, option_index, count(*) FROM message_request_recipients
		WHERE org_id = $1 AND message_id = ANY($2::uuid[]) AND answered_at IS NOT NULL
		GROUP BY message_id, option_index`, orgID, messageIDs)
	if err != nil {
		return nil, fmt.Errorf("load request tallies: %w", err)
	}
	defer rows.Close()
	result := map[string]map[int]int{}
	for rows.Next() {
		var messageID string
		var option int16
		var count int
		if err := rows.Scan(&messageID, &option, &count); err != nil {
			return nil, fmt.Errorf("scan request tally: %w", err)
		}
		if result[messageID] == nil {
			result[messageID] = map[int]int{}
		}
		result[messageID][int(option)] = count
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate request tallies: %w", err)
	}
	return result, nil
}

func tallyOf(counts map[int]int, options int) []int {
	tally := make([]int, options)
	for index := range tally {
		tally[index] = counts[index]
	}
	return tally
}

// visibleRequest is the reading rule of a request `r` for the reader $viewer:
// the message is not deleted, the chat is not archived and the reader is an
// active member of it now. It joins `m`, `c` and `vcm` for the caller.
const visibleRequest = `
	JOIN messages m ON m.org_id = r.org_id AND m.id = r.message_id AND m.deleted_at IS NULL
	JOIN chats c ON c.org_id = r.org_id AND c.id = r.chat_id AND c.archived_at IS NULL
	JOIN chat_members vcm ON vcm.org_id = r.org_id AND vcm.chat_id = r.chat_id AND vcm.actor_id = $viewer
	JOIN actors va ON va.org_id = r.org_id AND va.id = vcm.actor_id AND va.status = 'active' AND va.deleted_at IS NULL`

func visible(viewerParam string) string {
	return strings.ReplaceAll(visibleRequest, "$viewer", viewerParam)
}

// VisibleRecipientSQL is the rule of «Ждут вас» for a recipient row `rr`
// and its request `r`: open, readable by the recipient now (see
// visibleRequest). It joins `m` and `c`.
const VisibleRecipientSQL = `
	JOIN message_requests r ON r.org_id = rr.org_id AND r.message_id = rr.message_id AND r.status = 'open'
	JOIN messages m ON m.org_id = r.org_id AND m.id = r.message_id AND m.deleted_at IS NULL
	JOIN chats c ON c.org_id = r.org_id AND c.id = r.chat_id AND c.archived_at IS NULL
	JOIN chat_members vcm ON vcm.org_id = rr.org_id AND vcm.chat_id = rr.chat_id AND vcm.actor_id = rr.actor_id
	JOIN actors va ON va.org_id = rr.org_id AND va.id = rr.actor_id AND va.status = 'active' AND va.deleted_at IS NULL`

// Get returns the request of a message and the reader's view of it. Someone
// who cannot read the message gets ErrNotFound.
func (s *Service) Get(ctx context.Context, user identity.User, messageID string) (State, error) {
	if err := validUUID("message_id", messageID); err != nil {
		return State{}, err
	}
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{AccessMode: pgx.ReadOnly, IsoLevel: pgx.RepeatableRead})
	if err != nil {
		return State{}, fmt.Errorf("begin get request: %w", err)
	}
	defer tx.Rollback(ctx)
	var exists bool
	if err := tx.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM message_requests r `+visible("$3")+`
		WHERE r.org_id = $1 AND r.message_id = $2)`, user.OrgID, messageID, user.ActorID).Scan(&exists); err != nil {
		return State{}, fmt.Errorf("find request: %w", err)
	}
	if !exists {
		return State{}, ErrNotFound
	}
	state, err := s.stateTx(ctx, tx, user, messageID)
	if err != nil {
		return State{}, err
	}
	return state, tx.Commit(ctx)
}

func (s *Service) stateTx(ctx context.Context, q querier, user identity.User, messageID string) (State, error) {
	summaries, err := Summaries(ctx, q, user.OrgID, []string{messageID})
	if err != nil {
		return State{}, err
	}
	viewers, err := Viewers(ctx, q, user, s.Now(), s.limits, []string{messageID})
	if err != nil {
		return State{}, err
	}
	summary, viewer := summaries[messageID], viewers[messageID]
	if summary == nil || viewer == nil {
		return State{}, ErrNotFound
	}
	return State{Request: *summary, Viewer: *viewer}, nil
}

// AnswerItem is one recipient in listRequestAnswers.
type AnswerItem struct {
	ActorID    string     `json:"actor_id"`
	State      string     `json:"state"`
	Option     *int       `json:"option"`
	Comment    string     `json:"comment"`
	AnsweredAt *time.Time `json:"answered_at"`
	Late       bool       `json:"late"`
	Read       bool       `json:"read"`
}

type AnswerCounts struct {
	Waiting int   `json:"waiting"`
	Options []int `json:"options"`
}

type AnswerPage struct {
	Items      []AnswerItem `json:"items"`
	Counts     AnswerCounts `json:"counts"`
	NextCursor *string      `json:"next_cursor"`
}

type AnswerListOptions struct {
	Filter string
	Cursor *string
	Limit  int
}

// answersCursor orders recipients: waiting first (group 0, by actor), then
// answered (group 1), latest answer first.
type answersCursor struct {
	group   int
	at      time.Time
	actorID string
}

func encodeAnswersCursor(c answersCursor) string {
	raw := strconv.Itoa(c.group) + "." + strconv.FormatInt(c.at.UnixMicro(), 10) + "." + c.actorID
	return base64.RawURLEncoding.EncodeToString([]byte(raw))
}

func decodeAnswersCursor(value string) (answersCursor, error) {
	raw, err := base64.RawURLEncoding.DecodeString(value)
	parts := strings.SplitN(string(raw), ".", 3)
	if err != nil || len(parts) != 3 {
		return answersCursor{}, invalid("cursor", "cursor is malformed")
	}
	group, groupErr := strconv.Atoi(parts[0])
	micros, timeErr := strconv.ParseInt(parts[1], 10, 64)
	if groupErr != nil || timeErr != nil || (group != 0 && group != 1) || validUUID("cursor", parts[2]) != nil {
		return answersCursor{}, invalid("cursor", "cursor is malformed")
	}
	return answersCursor{group: group, at: time.UnixMicro(micros).UTC(), actorID: parts[2]}, nil
}

// Answers lists who answered what. Only the author and, while they hold the
// role, a chat owner or admin or a moderator with chats.moderate, all of
// them active members of the chat: checked on every call.
func (s *Service) Answers(ctx context.Context, user identity.User, messageID string, options AnswerListOptions) (AnswerPage, error) {
	if err := validUUID("message_id", messageID); err != nil {
		return AnswerPage{}, err
	}
	filterOption := -1
	switch {
	case options.Filter == "" || options.Filter == "waiting":
	case strings.HasPrefix(options.Filter, "option:") && len(options.Filter) == len("option:")+1 && options.Filter[7] >= '0' && options.Filter[7] <= '3':
		filterOption = int(options.Filter[7] - '0')
	default:
		return AnswerPage{}, invalid("filter", "filter must be waiting or option:<0-3>")
	}
	limit := options.Limit
	if limit == 0 {
		limit = 50
	}
	if limit < 1 || limit > 100 {
		return AnswerPage{}, invalid("limit", "limit must be between 1 and 100")
	}
	var cursor *answersCursor
	if options.Cursor != nil {
		decoded, err := decodeAnswersCursor(*options.Cursor)
		if err != nil {
			return AnswerPage{}, err
		}
		cursor = &decoded
	}
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{AccessMode: pgx.ReadOnly, IsoLevel: pgx.RepeatableRead})
	if err != nil {
		return AnswerPage{}, fmt.Errorf("begin list request answers: %w", err)
	}
	defer tx.Rollback(ctx)
	var authorID, preset, chatRole string
	var customCount int
	var createdSeq int64
	err = tx.QueryRow(ctx, `
		SELECT r.author_id, vcm.role, r.answer_preset, cardinality(r.custom_options), m.created_seq
		FROM message_requests r `+visible("$3")+`
		WHERE r.org_id = $1 AND r.message_id = $2`, user.OrgID, messageID, user.ActorID).Scan(&authorID, &chatRole, &preset, &customCount, &createdSeq)
	if errors.Is(err, pgx.ErrNoRows) {
		return AnswerPage{}, ErrNotFound
	}
	if err != nil {
		return AnswerPage{}, fmt.Errorf("authorize request answers: %w", err)
	}
	if authorID != user.ActorID && !canModerate(user, true, chatRole) {
		return AnswerPage{}, ErrForbidden
	}
	optionCount := OptionCount(preset, customCount)
	if filterOption >= optionCount {
		return AnswerPage{}, invalid("filter", "the request has no such option")
	}

	// Recipients still in the chat, and those who answered and left since.
	// One who left without answering is not asked any more.
	const listedFrom = `
		FROM message_request_recipients rr
		LEFT JOIN chat_members rcm ON rcm.org_id = rr.org_id AND rcm.chat_id = rr.chat_id AND rcm.actor_id = rr.actor_id
		LEFT JOIN actors ra ON ra.org_id = rr.org_id AND ra.id = rr.actor_id AND ra.status = 'active' AND ra.deleted_at IS NULL`
	const listedWhere = `
		WHERE rr.org_id = $1 AND rr.message_id = $2
		  AND (rr.answered_at IS NOT NULL OR (rcm.actor_id IS NOT NULL AND ra.id IS NOT NULL))`
	page := AnswerPage{Items: []AnswerItem{}, Counts: AnswerCounts{Options: make([]int, optionCount)}}
	countRows, err := tx.Query(ctx, `SELECT rr.option_index, count(*) `+listedFrom+listedWhere+` GROUP BY rr.option_index`, user.OrgID, messageID)
	if err != nil {
		return AnswerPage{}, fmt.Errorf("count request answers: %w", err)
	}
	for countRows.Next() {
		var option *int16
		var count int
		if err := countRows.Scan(&option, &count); err != nil {
			countRows.Close()
			return AnswerPage{}, fmt.Errorf("scan request answer count: %w", err)
		}
		if option == nil {
			page.Counts.Waiting = count
		} else if int(*option) < optionCount {
			page.Counts.Options[*option] = count
		}
	}
	countRows.Close()
	if err := countRows.Err(); err != nil {
		return AnswerPage{}, fmt.Errorf("iterate request answer counts: %w", err)
	}

	var cursorGroup *int
	var cursorAt *time.Time
	var cursorActor *string
	if cursor != nil {
		cursorGroup, cursorAt, cursorActor = &cursor.group, &cursor.at, &cursor.actorID
	}
	rows, err := tx.Query(ctx, `
		SELECT rr.actor_id, rr.option_index, rr.comment, rr.answered_at, rr.answered_late,
			rcm.actor_id IS NOT NULL AND ra.id IS NOT NULL,
			COALESCE(cr.last_read_seq, 0) >= $3
		`+listedFrom+`
		LEFT JOIN chat_reads cr ON cr.org_id = rr.org_id AND cr.chat_id = rr.chat_id AND cr.actor_id = rr.actor_id
		`+listedWhere+`
		  AND ($4::text = '' OR ($4 = 'waiting' AND rr.answered_at IS NULL) OR ($4 = 'option' AND rr.option_index = $5))
		  AND ($6::int IS NULL
			OR (CASE WHEN rr.answered_at IS NULL THEN 0 ELSE 1 END) > $6
			OR ((CASE WHEN rr.answered_at IS NULL THEN 0 ELSE 1 END) = $6
				AND (COALESCE(rr.answered_at, 'epoch'::timestamptz) < $7
					OR (COALESCE(rr.answered_at, 'epoch'::timestamptz) = $7 AND rr.actor_id > $8::uuid))))
		ORDER BY (CASE WHEN rr.answered_at IS NULL THEN 0 ELSE 1 END), COALESCE(rr.answered_at, 'epoch'::timestamptz) DESC, rr.actor_id
		LIMIT $9`,
		user.OrgID, messageID, createdSeq, filterParam(options.Filter), filterOption,
		cursorGroup, cursorAt, cursorActor, limit+1)
	if err != nil {
		return AnswerPage{}, fmt.Errorf("list request answers: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var item AnswerItem
		var option *int16
		var member bool
		if err := rows.Scan(&item.ActorID, &option, &item.Comment, &item.AnsweredAt, &item.Late, &member, &item.Read); err != nil {
			return AnswerPage{}, fmt.Errorf("scan request answer: %w", err)
		}
		switch {
		case item.AnsweredAt == nil:
			item.State = "waiting"
		case member:
			item.State = "answered"
		default:
			item.State = "left"
		}
		if option != nil {
			value := int(*option)
			item.Option = &value
		}
		page.Items = append(page.Items, item)
	}
	if err := rows.Err(); err != nil {
		return AnswerPage{}, fmt.Errorf("iterate request answers: %w", err)
	}
	if len(page.Items) > limit {
		page.Items = page.Items[:limit]
		last := page.Items[limit-1]
		next := answersCursor{actorID: last.ActorID, at: time.Unix(0, 0).UTC()}
		if last.AnsweredAt != nil {
			next.group, next.at = 1, *last.AnsweredAt
		}
		value := encodeAnswersCursor(next)
		page.NextCursor = &value
	}
	return page, tx.Commit(ctx)
}

func filterParam(filter string) string {
	if strings.HasPrefix(filter, "option:") {
		return "option"
	}
	return filter
}

// ChatWaiting is how many requests of one chat wait for the person's answer.
type ChatWaiting struct {
	Count     int64
	NextDueAt *time.Time
}

// WaitingByChat counts the requests waiting for the person's answer per
// chat, with the access rule of «Ждут вас».
func WaitingByChat(ctx context.Context, q querier, user identity.User) (map[string]ChatWaiting, error) {
	rows, err := q.Query(ctx, `
		SELECT rr.chat_id, count(*), min(r.due_at)
		FROM message_request_recipients rr `+VisibleRecipientSQL+`
		WHERE rr.org_id = $1 AND rr.actor_id = $2 AND rr.answered_at IS NULL AND rr.request_open
		GROUP BY rr.chat_id`, user.OrgID, user.ActorID)
	if err != nil {
		return nil, fmt.Errorf("count waiting requests: %w", err)
	}
	defer rows.Close()
	result := map[string]ChatWaiting{}
	for rows.Next() {
		var chatID string
		var item ChatWaiting
		if err := rows.Scan(&chatID, &item.Count, &item.NextDueAt); err != nil {
			return nil, fmt.Errorf("scan waiting requests: %w", err)
		}
		result[chatID] = item
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate waiting requests: %w", err)
	}
	return result, nil
}
