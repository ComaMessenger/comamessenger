package poll

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/comamessenger/comamessenger/core/internal/identity"
	"github.com/comamessenger/comamessenger/core/internal/permission"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Lock order of every write here, the same as message deletion:
//
//	organization → messages row → message_polls row → the voter's rows
//
// The organization row comes first, so a vote, the closing job, a message
// deletion and a membership change never wait for each other in opposite
// orders. Counts change only under the lock of the message_polls row.

// Jobs schedules and cancels the River job that closes a poll at its due
// date, inside the caller's transaction. A job that runs after its poll
// changed finds nothing to do, so a missing cancellation is never harmful.
type Jobs interface {
	ScheduleTx(ctx context.Context, tx pgx.Tx, messageID string, at time.Time) (int64, error)
	CancelTx(ctx context.Context, tx pgx.Tx, jobID int64) error
}

// KindClose is the River job kind of closing a poll at its due date.
const KindClose = "message_poll.close"

type Service struct {
	pool        *pgxpool.Pool
	afterCommit func(orgID string, highWatermark int64)
	jobs        Jobs
	limits      Limits
	now         func() time.Time
}

func NewService(pool *pgxpool.Pool, afterCommit func(string, int64)) *Service {
	return &Service{pool: pool, afterCommit: afterCommit, limits: DefaultLimits(), now: time.Now}
}

func (s *Service) SetJobs(jobs Jobs)             { s.jobs = jobs }
func (s *Service) SetLimits(limits Limits)       { s.limits = limits }
func (s *Service) SetClock(now func() time.Time) { s.now = now }
func (s *Service) Limits() Limits                { return s.limits }
func (s *Service) Now() time.Time                { return s.now().UTC().Truncate(time.Microsecond) }

func (s *Service) notify(orgID string, seq int64) {
	if s.afterCommit != nil && seq > 0 {
		s.afterCommit(orgID, seq)
	}
}

type querier interface {
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
	Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error)
}

// activePerson: the actor `alias` is an active person (not an agent).
func activePerson(alias string) string {
	return alias + `.type = 'user' AND ` + alias + `.status = 'active' AND ` + alias + `.deleted_at IS NULL`
}

// memberCountSQL is M of «N из M» for the poll `p`. An ordinary poll: its
// voters (those who have left included) plus the active people of the chat
// who have not voted (decision 16). An anonymous poll: the active people of
// the chat now, never fewer than N. There a voter who leaves lowers M
// exactly like someone who has not voted, so a change of M never tells
// whether the person who left had voted.
const memberCountSQL = `(CASE WHEN p.anonymous THEN GREATEST(p.voter_count, (SELECT count(*) FROM chat_members acm
	JOIN actors aca ON aca.org_id = acm.org_id AND aca.id = acm.actor_id AND aca.type = 'user' AND aca.status = 'active' AND aca.deleted_at IS NULL
	WHERE acm.org_id = p.org_id AND acm.chat_id = p.chat_id))
	ELSE p.voter_count + (SELECT count(*) FROM chat_members mcm
	JOIN actors mca ON mca.org_id = mcm.org_id AND mca.id = mcm.actor_id AND mca.type = 'user' AND mca.status = 'active' AND mca.deleted_at IS NULL
	WHERE mcm.org_id = p.org_id AND mcm.chat_id = p.chat_id
	  AND NOT EXISTS (SELECT 1 FROM message_poll_voters mv WHERE mv.message_id = p.message_id AND mv.actor_id = mcm.actor_id)) END)::int`

// record is a poll row with its message and chat.
type record struct {
	OrgID, MessageID, ChatID, AuthorID string
	Question                           string
	Options                            []string
	Multiple, Anonymous                bool
	DueAt                              *time.Time
	CloseJobID                         *int64
	Status                             string
	ClosedReason                       *string
	ClosedAt                           *time.Time
	Counts                             []int
	VoterCount, MemberCount            int
	LastRemindAt                       *time.Time
	RemindCount                        int
	Version                            int
	MessageDeleted, ChatArchived       bool
}

const recordColumns = `p.org_id, p.message_id, p.chat_id, p.author_id, p.question, p.options, p.multiple, p.anonymous,
	p.due_at, p.close_job_id, p.status, p.closed_reason, p.closed_at, p.option_counts, p.voter_count, ` + memberCountSQL + `,
	p.last_remind_at, p.remind_count, p.version, m.deleted_at IS NOT NULL, c.archived_at IS NOT NULL`

func scanRecord(row pgx.Row, r *record) error {
	var counts []int32
	if err := row.Scan(&r.OrgID, &r.MessageID, &r.ChatID, &r.AuthorID, &r.Question, &r.Options, &r.Multiple, &r.Anonymous,
		&r.DueAt, &r.CloseJobID, &r.Status, &r.ClosedReason, &r.ClosedAt, &counts, &r.VoterCount, &r.MemberCount,
		&r.LastRemindAt, &r.RemindCount, &r.Version, &r.MessageDeleted, &r.ChatArchived); err != nil {
		return err
	}
	r.Counts = make([]int, len(counts))
	for index, count := range counts {
		r.Counts[index] = int(count)
	}
	return nil
}

// public is the MessagePoll of r: never the counts of an open poll.
func (r record) public() *Poll {
	result := &Poll{
		Question: r.Question, Options: append([]string{}, r.Options...), Multiple: r.Multiple, Anonymous: r.Anonymous,
		DueAt: r.DueAt, Status: r.Status, ClosedReason: r.ClosedReason, ClosedAt: r.ClosedAt,
		VoterCount: r.VoterCount, MemberCount: r.MemberCount, Version: r.Version,
	}
	if r.Status == StatusClosed {
		result.FinalCounts = append([]int{}, r.Counts...)
	}
	return result
}

// loadRecords reads the polls among messageIDs. Messages that are not polls
// are absent.
func loadRecords(ctx context.Context, q querier, orgID string, messageIDs []string) (map[string]record, error) {
	result := make(map[string]record, len(messageIDs))
	if len(messageIDs) == 0 {
		return result, nil
	}
	rows, err := q.Query(ctx, `
		SELECT `+recordColumns+`
		FROM message_polls p
		JOIN messages m ON m.org_id = p.org_id AND m.id = p.message_id
		JOIN chats c ON c.org_id = p.org_id AND c.id = p.chat_id
		WHERE p.org_id = $1 AND p.message_id = ANY($2::uuid[])`, orgID, messageIDs)
	if err != nil {
		return nil, fmt.Errorf("load polls: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var r record
		if err := scanRecord(rows, &r); err != nil {
			return nil, fmt.Errorf("scan poll: %w", err)
		}
		result[r.MessageID] = r
	}
	return result, rows.Err()
}

// Load builds the MessagePoll of the polls among messageIDs, one query for
// the whole batch. The poll of a deleted message is absent: a deleted
// message has nothing left to show.
func Load(ctx context.Context, q querier, orgID string, messageIDs []string) (map[string]*Poll, error) {
	records, err := loadRecords(ctx, q, orgID, messageIDs)
	if err != nil {
		return nil, err
	}
	result := make(map[string]*Poll, len(records))
	for messageID, r := range records {
		if !r.MessageDeleted {
			result[messageID] = r.public()
		}
	}
	return result, nil
}

// lockPoll takes the message row and then the poll row, the order of
// message deletion. The caller holds the organization lock.
func lockPoll(ctx context.Context, tx pgx.Tx, orgID, messageID string) (record, error) {
	var exists bool
	if err := tx.QueryRow(ctx, `SELECT true FROM messages WHERE org_id = $1 AND id = $2 AND type = 'poll' FOR NO KEY UPDATE`, orgID, messageID).Scan(&exists); errors.Is(err, pgx.ErrNoRows) {
		return record{}, ErrNotFound
	} else if err != nil {
		return record{}, fmt.Errorf("lock poll message: %w", err)
	}
	var r record
	err := scanRecord(tx.QueryRow(ctx, `
		SELECT `+recordColumns+`
		FROM message_polls p
		JOIN messages m ON m.org_id = p.org_id AND m.id = p.message_id
		JOIN chats c ON c.org_id = p.org_id AND c.id = p.chat_id
		WHERE p.org_id = $1 AND p.message_id = $2
		FOR UPDATE OF p`, orgID, messageID), &r)
	if errors.Is(err, pgx.ErrNoRows) {
		return record{}, ErrNotFound
	}
	if err != nil {
		return record{}, fmt.Errorf("lock poll: %w", err)
	}
	return r, nil
}

// refresh rereads the counters of a locked poll after a change.
func refresh(ctx context.Context, tx pgx.Tx, r *record) error {
	var counts []int32
	if err := tx.QueryRow(ctx, `SELECT p.option_counts, p.voter_count, `+memberCountSQL+`, p.version, p.status, p.closed_reason, p.closed_at
		FROM message_polls p WHERE p.message_id = $1`, r.MessageID).Scan(&counts, &r.VoterCount, &r.MemberCount, &r.Version,
		&r.Status, &r.ClosedReason, &r.ClosedAt); err != nil {
		return fmt.Errorf("reread poll: %w", err)
	}
	r.Counts = make([]int, len(counts))
	for index, count := range counts {
		r.Counts[index] = int(count)
	}
	return nil
}

// standing is the reader's place in the chat of a poll, read from the
// database on every read and action (never from the session).
type standing struct {
	ActorID   string
	Person    bool   // an active person (not an agent)
	Member    bool   // an active person who is a member of the chat now
	ChatRole  string // chat_members.role; "" for non-members
	Moderator bool   // chats.moderate from the stored role and grants
}

// Admin is a chat owner or admin, or a moderator in the chat.
func (s standing) Admin() bool {
	return s.Member && (s.ChatRole == "owner" || s.ChatRole == "admin" || s.Moderator)
}

func storedCodes(role string, stored []string) []permission.Code {
	granted := make([]permission.Code, len(stored))
	for index, code := range stored {
		granted[index] = permission.Code(code)
	}
	return permission.Effective(role, granted)
}

// readStandings reads the reader's standing in chats.
func readStandings(ctx context.Context, q querier, user identity.User, chatIDs []string) (map[string]standing, error) {
	result := make(map[string]standing, len(chatIDs))
	var orgRole string
	var stored []string
	err := q.QueryRow(ctx, `
		SELECT a.org_role, ARRAY(SELECT permission FROM actor_permissions WHERE org_id = a.org_id AND actor_id = a.id)
		FROM actors a WHERE a.org_id = $1 AND a.id = $2 AND `+activePerson("a"), user.OrgID, user.ActorID).Scan(&orgRole, &stored)
	if errors.Is(err, pgx.ErrNoRows) {
		for _, chatID := range chatIDs {
			result[chatID] = standing{ActorID: user.ActorID}
		}
		return result, nil
	}
	if err != nil {
		return nil, fmt.Errorf("read poll reader: %w", err)
	}
	moderator := permission.Allows(orgRole, storedCodes(orgRole, stored), permission.ChatsModerate)
	for _, chatID := range chatIDs {
		result[chatID] = standing{ActorID: user.ActorID, Person: true, Moderator: moderator}
	}
	if len(chatIDs) == 0 {
		return result, nil
	}
	rows, err := q.Query(ctx, `SELECT chat_id, role FROM chat_members WHERE org_id = $1 AND actor_id = $2 AND chat_id = ANY($3::uuid[])`,
		user.OrgID, user.ActorID, chatIDs)
	if err != nil {
		return nil, fmt.Errorf("read poll reader chats: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var chatID, role string
		if err := rows.Scan(&chatID, &role); err != nil {
			return nil, fmt.Errorf("scan poll reader chat: %w", err)
		}
		item := result[chatID]
		item.Member, item.ChatRole = true, role
		result[chatID] = item
	}
	return result, rows.Err()
}

func readStanding(ctx context.Context, q querier, user identity.User, chatID string) (standing, error) {
	standings, err := readStandings(ctx, q, user, []string{chatID})
	if err != nil {
		return standing{}, err
	}
	return standings[chatID], nil
}

// mine is the reader's own vote: whether they voted and, in an ordinary
// poll, their choice. In an anonymous poll there is no choice to read.
type mine struct {
	Voted   bool
	Options []int
}

func readMine(ctx context.Context, q querier, orgID, actorID string, messageIDs []string) (map[string]mine, error) {
	result := map[string]mine{}
	if len(messageIDs) == 0 {
		return result, nil
	}
	rows, err := q.Query(ctx, `
		SELECT v.message_id, ARRAY(SELECT o.option_index::int FROM message_poll_votes o
			WHERE o.message_id = v.message_id AND o.actor_id = v.actor_id ORDER BY o.option_index)
		FROM message_poll_voters v
		WHERE v.org_id = $1 AND v.actor_id = $2 AND v.message_id = ANY($3::uuid[])`, orgID, actorID, messageIDs)
	if err != nil {
		return nil, fmt.Errorf("read own poll votes: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var messageID string
		var options []int32
		if err := rows.Scan(&messageID, &options); err != nil {
			return nil, fmt.Errorf("scan own poll vote: %w", err)
		}
		item := mine{Voted: true, Options: make([]int, len(options))}
		for index, option := range options {
			item.Options[index] = int(option)
		}
		result[messageID] = item
	}
	return result, rows.Err()
}

// waitingOthers: polls among messageIDs where an active person of the chat
// other than the author has not voted, so «Напомнить» has someone to remind.
func waitingOthers(ctx context.Context, q querier, orgID string, messageIDs []string) (map[string]bool, error) {
	result := map[string]bool{}
	if len(messageIDs) == 0 {
		return result, nil
	}
	rows, err := q.Query(ctx, `
		SELECT p.message_id FROM message_polls p
		WHERE p.org_id = $1 AND p.message_id = ANY($2::uuid[]) AND EXISTS (
			SELECT 1 FROM chat_members cm
			JOIN actors a ON a.org_id = cm.org_id AND a.id = cm.actor_id AND `+activePerson("a")+`
			WHERE cm.org_id = p.org_id AND cm.chat_id = p.chat_id AND cm.actor_id <> p.author_id
			  AND NOT EXISTS (SELECT 1 FROM message_poll_voters v WHERE v.message_id = p.message_id AND v.actor_id = cm.actor_id))`,
		orgID, messageIDs)
	if err != nil {
		return nil, fmt.Errorf("find polls waiting for others: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var messageID string
		if err := rows.Scan(&messageID); err != nil {
			return nil, fmt.Errorf("scan poll waiting for others: %w", err)
		}
		result[messageID] = true
	}
	return result, rows.Err()
}

// viewerOf is decision 7 and 8 of phase 6.7 for one reader: results after
// the reader's own vote, to the author always and to everyone once closed;
// who voted for what only where results are visible and the poll is not
// anonymous.
func viewerOf(r record, who standing, own mine, othersWaiting bool, now time.Time, limits Limits) *Viewer {
	result := &Viewer{}
	if !who.Member || r.MessageDeleted {
		return result
	}
	open := r.Status == StatusOpen
	live := open && !r.ChatArchived
	author := r.AuthorID == who.ActorID
	result.Voted = own.Voted
	if own.Voted && !r.Anonymous {
		result.MyOptions = append([]int{}, own.Options...)
	}
	result.CanVote = live && (!r.Anonymous || !own.Voted)
	result.CanChange = live && !r.Anonymous && own.Voted
	result.CanViewResults = own.Voted || author || !open
	result.CanViewVoters = result.CanViewResults && !r.Anonymous
	result.CanViewWaiting = (author || who.Admin()) && !r.Anonymous
	result.CanClose = live && (author || who.Admin())
	if author && live && r.RemindCount < limits.RemindMax {
		next := time.Time{}
		if r.LastRemindAt != nil {
			next = r.LastRemindAt.Add(limits.RemindInterval)
		}
		if now.Before(next) {
			result.NextRemindAt = &next
		} else {
			result.CanRemind = othersWaiting
		}
	}
	if result.CanViewResults {
		result.Counts = append([]int{}, r.Counts...)
	}
	return result
}

// Viewers computes the PollViewer of user for the polls among messageIDs:
// four queries for the whole batch. Agents get none.
func Viewers(ctx context.Context, q querier, user identity.User, now time.Time, limits Limits, messageIDs []string) (map[string]*Viewer, error) {
	records, err := loadRecords(ctx, q, user.OrgID, messageIDs)
	if err != nil || len(records) == 0 {
		return map[string]*Viewer{}, err
	}
	return viewersOf(ctx, q, user, now, limits, records)
}

func viewersOf(ctx context.Context, q querier, user identity.User, now time.Time, limits Limits, records map[string]record) (map[string]*Viewer, error) {
	result := make(map[string]*Viewer, len(records))
	chats, ids := []string{}, []string{}
	seen := map[string]bool{}
	for messageID, r := range records {
		ids = append(ids, messageID)
		if !seen[r.ChatID] {
			seen[r.ChatID] = true
			chats = append(chats, r.ChatID)
		}
	}
	standings, err := readStandings(ctx, q, user, chats)
	if err != nil {
		return nil, err
	}
	own, err := readMine(ctx, q, user.OrgID, user.ActorID, ids)
	if err != nil {
		return nil, err
	}
	authored := []string{}
	for messageID, r := range records {
		if r.AuthorID == user.ActorID {
			authored = append(authored, messageID)
		}
	}
	others, err := waitingOthers(ctx, q, user.OrgID, authored)
	if err != nil {
		return nil, err
	}
	for messageID, r := range records {
		who := standings[r.ChatID]
		if !who.Person {
			continue
		}
		result[messageID] = viewerOf(r, who, own[messageID], others[messageID], now, limits)
	}
	return result, nil
}

// Prepared is the poll part of a message being created.
type Prepared struct{ plan Plan }

// PrepareTx runs inside the send transaction under the organization lock,
// before the message is written: polls are sent by people, within the open
// polls limits of the chat and of the author.
func (s *Service) PrepareTx(ctx context.Context, tx pgx.Tx, user identity.User, chatID string, plan Plan) (Prepared, error) {
	var person bool
	if err := tx.QueryRow(ctx, `SELECT type = 'user' FROM actors WHERE org_id = $1 AND id = $2`, user.OrgID, user.ActorID).Scan(&person); err != nil {
		return Prepared{}, fmt.Errorf("check poll author: %w", err)
	}
	if !person {
		return Prepared{}, ErrForbidden
	}
	var openInChat, openByAuthor int
	if err := tx.QueryRow(ctx, `
		SELECT
			(SELECT count(*) FROM message_polls WHERE org_id = $1 AND chat_id = $2 AND status = 'open'),
			(SELECT count(*) FROM message_polls WHERE org_id = $1 AND author_id = $3 AND status = 'open')`,
		user.OrgID, chatID, user.ActorID).Scan(&openInChat, &openByAuthor); err != nil {
		return Prepared{}, fmt.Errorf("count open polls: %w", err)
	}
	if openInChat >= s.limits.OpenPerChat || openByAuthor >= s.limits.OpenPerAuthor {
		return Prepared{}, ErrLimitReached
	}
	return Prepared{plan: plan}, nil
}

// InsertTx stores the poll of a just inserted message and schedules its
// closing at the due date.
func (s *Service) InsertTx(ctx context.Context, tx pgx.Tx, user identity.User, chatID, messageID string, prepared Prepared) error {
	plan := prepared.plan
	counts := make([]int32, len(plan.Options))
	if _, err := tx.Exec(ctx, `
		INSERT INTO message_polls (org_id, message_id, chat_id, author_id, question, options, multiple, anonymous, due_at, option_counts, created_at)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
		user.OrgID, messageID, chatID, user.ActorID, plan.Question, plan.Options, plan.Multiple, plan.Anonymous, plan.DueAt, counts, s.Now()); err != nil {
		return fmt.Errorf("insert poll: %w", err)
	}
	if s.jobs != nil && plan.DueAt != nil {
		jobID, err := s.jobs.ScheduleTx(ctx, tx, messageID, *plan.DueAt)
		if err != nil {
			return fmt.Errorf("schedule poll closing: %w", err)
		}
		if _, err := tx.Exec(ctx, `UPDATE message_polls SET close_job_id = $2 WHERE message_id = $1`, messageID, jobID); err != nil {
			return fmt.Errorf("record poll job: %w", err)
		}
	}
	return nil
}

func (s *Service) cancelJob(ctx context.Context, tx pgx.Tx, r record) error {
	if s == nil || s.jobs == nil || r.CloseJobID == nil {
		return nil
	}
	if err := s.jobs.CancelTx(ctx, tx, *r.CloseJobID); err != nil {
		return fmt.Errorf("cancel poll job: %w", err)
	}
	return nil
}

// closeTx closes a locked open poll for good and writes poll.updated with
// the final counts.
func (s *Service) closeTx(ctx context.Context, tx pgx.Tx, r *record, reason string, by *string, now time.Time) (int64, error) {
	if err := s.cancelJob(ctx, tx, *r); err != nil {
		return 0, err
	}
	if _, err := tx.Exec(ctx, `
		UPDATE message_polls SET status = 'closed', closed_reason = $2, closed_by = $3, closed_at = $4, close_job_id = NULL, version = version + 1
		WHERE message_id = $1`, r.MessageID, reason, by, now); err != nil {
		return 0, fmt.Errorf("close poll: %w", err)
	}
	if err := refresh(ctx, tx, r); err != nil {
		return 0, err
	}
	return emitUpdated(ctx, tx, *r)
}

// OnMessageDeletedTx closes the poll of a message deleted in tx and wipes
// its texts: like the body of a deleted message, the question and the
// options are gone. The counts stay, the closing job is cancelled. The
// caller holds the organization lock and the message row
// (message.Service.Delete), the order every poll write follows. A message
// that is not a poll is left alone. service may be nil (tools without
// jobs): a stale job then finds a closed poll.
func OnMessageDeletedTx(ctx context.Context, tx pgx.Tx, service *Service, user identity.User, messageID string) error {
	r, err := lockPoll(ctx, tx, user.OrgID, messageID)
	if errors.Is(err, ErrNotFound) {
		return nil
	}
	if err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `UPDATE message_polls SET question = '', options = array_fill(''::text, ARRAY[cardinality(options)]) WHERE message_id = $1`, messageID); err != nil {
		return fmt.Errorf("wipe poll of deleted message: %w", err)
	}
	if r.Status != StatusOpen {
		return nil
	}
	now := time.Now().UTC().Truncate(time.Microsecond)
	if service != nil {
		now = service.Now()
	}
	_, err = service.closeTx(ctx, tx, &r, ReasonMessageDeleted, &user.ActorID, now)
	return err
}

// OnMembershipChangedTx writes poll.updated for every open poll of a chat
// a person (actorID) joined or left, so M of «N из M» stays live. It goes
// out for every poll, whether or not the person voted in it and whether or
// not M changed: an event only where they had not voted would tell the
// chat who voted. It runs in the transaction of the membership change,
// before its event, and returns the last sequence it used (0 for none).
func OnMembershipChangedTx(ctx context.Context, tx pgx.Tx, orgID, chatID, actorID string) (int64, error) {
	var person bool
	if err := tx.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM actors a WHERE a.org_id = $1 AND a.id = $2 AND a.type = 'user')`, orgID, actorID).Scan(&person); err != nil {
		return 0, fmt.Errorf("check poll member: %w", err)
	}
	if !person {
		return 0, nil
	}
	if err := lockOrganization(ctx, tx, orgID); err != nil {
		return 0, err
	}
	rows, err := tx.Query(ctx, `
		UPDATE message_polls p SET version = version + 1
		WHERE p.org_id = $1 AND p.chat_id = $2 AND p.status = 'open'
		  AND EXISTS (SELECT 1 FROM messages m WHERE m.org_id = p.org_id AND m.id = p.message_id AND m.deleted_at IS NULL)
		RETURNING p.message_id`, orgID, chatID)
	if err != nil {
		return 0, fmt.Errorf("bump polls of chat: %w", err)
	}
	ids, err := pgx.CollectRows(rows, pgx.RowTo[string])
	if err != nil {
		return 0, fmt.Errorf("collect polls of chat: %w", err)
	}
	records, err := loadRecords(ctx, tx, orgID, ids)
	if err != nil {
		return 0, err
	}
	var last int64
	for _, messageID := range ids {
		if r, ok := records[messageID]; ok {
			if last, err = emitUpdated(ctx, tx, r); err != nil {
				return 0, err
			}
		}
	}
	return last, nil
}

// Events. poll.updated carries only what every member may see and never
// who acted (actor_id NULL), so a vote cannot be traced to a person by its
// event. poll.vote.updated goes to the voter alone; in an anonymous poll it
// says only that they voted. poll.notified never carries texts.

type updatedEvent struct {
	MessageID    string  `json:"message_id"`
	ChatID       string  `json:"chat_id"`
	Status       string  `json:"status"`
	ClosedReason *string `json:"closed_reason"`
	VoterCount   int     `json:"voter_count"`
	MemberCount  int     `json:"member_count"`
	FinalCounts  []int   `json:"final_counts"`
	Version      int     `json:"version"`
}

type chosenEvent struct {
	MessageID string `json:"message_id"`
	ChatID    string `json:"chat_id"`
	Options   []int  `json:"options"`
	Version   int    `json:"version"`
}

type anonymousVoteEvent struct {
	MessageID string `json:"message_id"`
	ChatID    string `json:"chat_id"`
	Voted     bool   `json:"voted"`
	Version   int    `json:"version"`
}

type notifiedEvent struct {
	MessageID string `json:"message_id"`
	ChatID    string `json:"chat_id"`
	Kind      string `json:"kind"`
}

func insertEvent(ctx context.Context, tx pgx.Tx, orgID, eventType string, actorID *string, chatID, subjectID string, audience *string, payload any) (int64, error) {
	seq, err := nextSequence(ctx, tx, orgID)
	if err != nil {
		return 0, err
	}
	encoded, err := json.Marshal(payload)
	if err != nil {
		return 0, err
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO events (org_id, seq, type, actor_id, chat_id, subject_id, audience_actor_id, data)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)`, orgID, seq, eventType, actorID, chatID, subjectID, audience, string(encoded)); err != nil {
		return 0, fmt.Errorf("insert %s: %w", eventType, err)
	}
	return seq, nil
}

// emitUpdated writes poll.updated to the whole chat, without an actor. A
// poll closed by deleting its message carries no final counts: the card is
// gone and those who had not voted never saw them.
func emitUpdated(ctx context.Context, tx pgx.Tx, r record) (int64, error) {
	public := r.public()
	if public.ClosedReason != nil && *public.ClosedReason == ReasonMessageDeleted {
		public.FinalCounts = nil
	}
	return insertEvent(ctx, tx, r.OrgID, "poll.updated", nil, r.ChatID, r.MessageID, nil, updatedEvent{
		MessageID: r.MessageID, ChatID: r.ChatID, Status: public.Status, ClosedReason: public.ClosedReason,
		VoterCount: public.VoterCount, MemberCount: public.MemberCount, FinalCounts: public.FinalCounts, Version: public.Version,
	})
}

// emitVote writes poll.vote.updated to the voter alone: the choice of an
// ordinary poll (empty after a retraction), only «voted» in an anonymous one.
func emitVote(ctx context.Context, tx pgx.Tx, r record, actorID string, options []int) (int64, error) {
	var payload any = anonymousVoteEvent{MessageID: r.MessageID, ChatID: r.ChatID, Voted: true, Version: r.Version}
	if !r.Anonymous {
		if options == nil {
			options = []int{}
		}
		payload = chosenEvent{MessageID: r.MessageID, ChatID: r.ChatID, Options: options, Version: r.Version}
	}
	return insertEvent(ctx, tx, r.OrgID, "poll.vote.updated", &actorID, r.ChatID, r.MessageID, &actorID, payload)
}

// emitNotified writes poll.notified to one person and, with push, queues
// its push.
func emitNotified(ctx context.Context, tx pgx.Tx, r record, kind string, actorID *string, audience string, push bool) (int64, error) {
	seq, err := insertEvent(ctx, tx, r.OrgID, "poll.notified", actorID, r.ChatID, r.MessageID, &audience,
		notifiedEvent{MessageID: r.MessageID, ChatID: r.ChatID, Kind: kind})
	if err != nil {
		return 0, err
	}
	if push {
		if _, err := tx.Exec(ctx, `INSERT INTO notification_jobs (org_id, event_seq) VALUES ($1, $2) ON CONFLICT DO NOTHING`, r.OrgID, seq); err != nil {
			return 0, fmt.Errorf("enqueue poll notification: %w", err)
		}
	}
	return seq, nil
}

func nextSequence(ctx context.Context, tx pgx.Tx, orgID string) (int64, error) {
	var seq int64
	if err := tx.QueryRow(ctx, `UPDATE organizations SET event_seq = event_seq + 1 WHERE id = $1 RETURNING event_seq`, orgID).Scan(&seq); err != nil {
		return 0, fmt.Errorf("allocate event sequence: %w", err)
	}
	return seq, nil
}

// lockOrganization serializes the organization's event sequence and comes
// first in every transaction that writes events (message.lockOrganization).
func lockOrganization(ctx context.Context, tx pgx.Tx, orgID string) error {
	var seq int64
	if err := tx.QueryRow(ctx, `SELECT event_seq FROM organizations WHERE id = $1 FOR NO KEY UPDATE`, orgID).Scan(&seq); errors.Is(err, pgx.ErrNoRows) {
		return ErrNotFound
	} else if err != nil {
		return fmt.Errorf("lock organization: %w", err)
	}
	return nil
}
