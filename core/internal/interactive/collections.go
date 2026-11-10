package interactive

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/comamessenger/comamessenger/core/internal/chat"
	"github.com/comamessenger/comamessenger/core/internal/identity"
	"github.com/comamessenger/comamessenger/core/internal/message"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

type StartCollectionInput struct {
	MessageID          string     `json:"message_id"`
	Response           string     `json:"response"`
	Match              []string   `json:"match"`
	ExpectedActorIDs   []string   `json:"expected_actor_ids"`
	ExpectAllMembers   bool       `json:"expect_all_members"`
	DeadlineAt         *time.Time `json:"deadline_at"`
	DeadlineInSeconds  int        `json:"deadline_in_seconds"`
	RemindEverySeconds int        `json:"remind_every_seconds"`
	MaxReminders       int        `json:"max_reminders"`
	ReminderChannel    string     `json:"reminder_channel"`
	ReminderText       string     `json:"reminder_text"`
	ReportChatID       string     `json:"report_chat_id"`
	ReportInThread     bool       `json:"report_in_thread"`
	Note               string     `json:"note"`
}

type CollectionResponse struct {
	ActorID     string    `json:"actor_id"`
	Value       string    `json:"value"`
	RespondedAt time.Time `json:"responded_at"`
}

type Collection struct {
	ID                  string               `json:"id"`
	AgentID             string               `json:"agent_id"`
	ChatID              string               `json:"chat_id"`
	MessageID           string               `json:"message_id"`
	Response            string               `json:"response"`
	Match               []string             `json:"match"`
	ExpectedActorIDs    []string             `json:"expected_actor_ids"`
	Responded           []CollectionResponse `json:"responded"`
	PendingActorIDs     []string             `json:"pending_actor_ids"`
	DeadlineAt          time.Time            `json:"deadline_at"`
	RemindEverySeconds  *int                 `json:"remind_every_seconds"`
	MaxReminders        int                  `json:"max_reminders"`
	ReminderChannel     string               `json:"reminder_channel"`
	RemindersSent       int                  `json:"reminders_sent"`
	NextReminderAt      *time.Time           `json:"next_reminder_at"`
	RemindersCanceledAt *time.Time           `json:"reminders_canceled_at"`
	ReportChatID        string               `json:"report_chat_id"`
	ReportThreadRootID  *string              `json:"report_thread_root_id"`
	Note                string               `json:"note"`
	Status              string               `json:"status"`
	CancelReason        string               `json:"cancel_reason,omitempty"`
	ReportRunID         *string              `json:"report_run_id"`
	CreatedAt           time.Time            `json:"created_at"`
	ClosedAt            *time.Time           `json:"closed_at"`

	orgID        string
	runID        *string
	reminderText string
	targetRoot   *string
	targetAt     time.Time
}

const collectionSelect = `SELECT c.id, c.org_id, c.agent_id, c.run_id, c.chat_id, c.message_id, c.response_kind, c.match_values, c.expected_actor_ids,
	c.deadline_at, c.remind_every_seconds, c.max_reminders, c.reminder_channel, c.reminder_text, c.next_reminder_at, c.reminders_canceled_at,
	c.report_chat_id, c.report_thread_root_id, c.note, c.status, c.cancel_reason, c.report_run_id, c.created_at, c.closed_at,
	m.thread_root_id, m.created_at,
	(SELECT count(*) FROM agent_reminders r WHERE r.collection_id=c.id)
	FROM agent_collections c JOIN messages m ON m.org_id=c.org_id AND m.id=c.message_id`

func scanCollection(row pgx.Row) (Collection, error) {
	var result Collection
	err := row.Scan(&result.ID, &result.orgID, &result.AgentID, &result.runID, &result.ChatID, &result.MessageID, &result.Response, &result.Match, &result.ExpectedActorIDs,
		&result.DeadlineAt, &result.RemindEverySeconds, &result.MaxReminders, &result.ReminderChannel, &result.reminderText, &result.NextReminderAt, &result.RemindersCanceledAt,
		&result.ReportChatID, &result.ReportThreadRootID, &result.Note, &result.Status, &result.CancelReason, &result.ReportRunID, &result.CreatedAt, &result.ClosedAt,
		&result.targetRoot, &result.targetAt, &result.RemindersSent)
	return result, err
}

type querier interface {
	Query(context.Context, string, ...any) (pgx.Rows, error)
	QueryRow(context.Context, string, ...any) pgx.Row
}

// StartCollection registers who is expected to answer a message and how. The
// server, not the agent, decides afterwards who has responded.
func (s *Service) StartCollection(ctx context.Context, agent identity.User, runID string, input StartCollectionInput) (Collection, error) {
	if uuid.Validate(runID) != nil || uuid.Validate(input.MessageID) != nil {
		return Collection{}, fmt.Errorf("%w: run_id and message_id must be UUIDs", ErrInvalid)
	}
	now := s.now().UTC()
	var deadline time.Time
	switch {
	case input.DeadlineAt != nil && input.DeadlineInSeconds == 0:
		deadline = input.DeadlineAt.UTC()
	case input.DeadlineAt == nil && input.DeadlineInSeconds > 0:
		deadline = now.Add(time.Duration(input.DeadlineInSeconds) * time.Second)
	default:
		return Collection{}, fmt.Errorf("%w: exactly one of deadline_at or deadline_in_seconds is required", ErrInvalid)
	}
	if deadline.Before(now.Add(time.Minute)) || deadline.After(now.Add(s.limits.MaxCollectionDuration)) {
		return Collection{}, fmt.Errorf("%w: deadline must be between one minute and %s from now", ErrInvalid, s.limits.MaxCollectionDuration)
	}
	if input.Response != "reaction" && input.Response != "action" && input.Response != "reply" {
		return Collection{}, fmt.Errorf("%w: response must be reaction, action or reply", ErrInvalid)
	}
	if input.Response == "reply" && len(input.Match) > 0 {
		return Collection{}, fmt.Errorf("%w: match is not supported for replies", ErrInvalid)
	}
	if len(input.Match) > 20 {
		return Collection{}, fmt.Errorf("%w: match may contain at most 20 values", ErrInvalid)
	}
	match := make([]string, 0, len(input.Match))
	for _, value := range input.Match {
		value = strings.TrimSpace(value)
		if value == "" || len(value) > 64 {
			return Collection{}, fmt.Errorf("%w: match values must be 1-64 bytes", ErrInvalid)
		}
		match = append(match, value)
	}
	if input.ReminderChannel == "" {
		input.ReminderChannel = "thread"
	}
	if input.ReminderChannel != "thread" && input.ReminderChannel != "direct" {
		return Collection{}, fmt.Errorf("%w: reminder_channel must be thread or direct", ErrInvalid)
	}
	input.ReminderText = strings.TrimSpace(input.ReminderText)
	input.Note = strings.TrimSpace(input.Note)
	var remindEvery *int
	var nextReminder *time.Time
	if input.RemindEverySeconds > 0 {
		if input.RemindEverySeconds < 300 || input.RemindEverySeconds > 604800 {
			return Collection{}, fmt.Errorf("%w: remind_every_seconds must be between 300 and 604800", ErrInvalid)
		}
		if input.ReminderText == "" || len([]rune(input.ReminderText)) > 2000 {
			return Collection{}, fmt.Errorf("%w: reminder_text of 1-2000 characters is required with reminders", ErrInvalid)
		}
		if input.MaxReminders == 0 {
			input.MaxReminders = 1
		}
		if input.MaxReminders < 1 || input.MaxReminders > 5 {
			return Collection{}, fmt.Errorf("%w: max_reminders must be between 1 and 5", ErrInvalid)
		}
		remindEvery = &input.RemindEverySeconds
		next := now.Add(time.Duration(input.RemindEverySeconds) * time.Second)
		nextReminder = &next
	} else if input.MaxReminders != 0 || input.ReminderText != "" {
		return Collection{}, fmt.Errorf("%w: reminders require remind_every_seconds", ErrInvalid)
	}
	if len([]rune(input.Note)) > 2000 {
		return Collection{}, fmt.Errorf("%w: note is too long", ErrInvalid)
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Collection{}, err
	}
	defer tx.Rollback(ctx)
	run, err := loadRun(ctx, tx, agent, runID)
	if err != nil {
		return Collection{}, err
	}
	var chatID, authorID string
	var threadRootID *string
	var blocks *message.Blocks
	target, err := s.messages.Get(ctx, agent, input.MessageID)
	if errors.Is(err, message.ErrNotFound) {
		return Collection{}, ErrNotFound
	}
	if err != nil {
		return Collection{}, err
	}
	if target.DeletedAt != nil {
		return Collection{}, ErrNotFound
	}
	chatID, authorID, threadRootID, blocks = target.ChatID, target.ActorID, target.ThreadRootID, target.Blocks
	if input.Response == "action" {
		if authorID != agent.ActorID || blocks == nil || len(blocks.Actions) == 0 {
			return Collection{}, fmt.Errorf("%w: action responses require the agent's own card with actions", ErrInvalid)
		}
		known := map[string]bool{}
		for _, action := range blocks.Actions {
			known[action.ID] = true
		}
		for _, value := range match {
			if !known[value] {
				return Collection{}, fmt.Errorf("%w: match contains an unknown action id", ErrInvalid)
			}
		}
	}
	expected, err := s.resolveExpected(ctx, tx, agent.OrgID, chatID, authorID, input)
	if err != nil {
		return Collection{}, err
	}
	reportChatID := input.ReportChatID
	if reportChatID == "" {
		reportChatID = chatID
	}
	if uuid.Validate(reportChatID) != nil {
		return Collection{}, fmt.Errorf("%w: report_chat_id must be a UUID", ErrInvalid)
	}
	if member, err := agentMember(ctx, tx, agent.OrgID, agent.ActorID, reportChatID); err != nil {
		return Collection{}, err
	} else if !member {
		return Collection{}, ErrForbidden
	}
	var reportRoot *string
	if input.ReportInThread {
		if reportChatID != chatID {
			return Collection{}, fmt.Errorf("%w: report_in_thread requires the report chat to be the message chat", ErrInvalid)
		}
		root := input.MessageID
		if threadRootID != nil {
			root = *threadRootID
		}
		reportRoot = &root
	}
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, "agent-collections/"+agent.ActorID); err != nil {
		return Collection{}, err
	}
	var open int
	if err := tx.QueryRow(ctx, `SELECT count(*) FROM agent_collections WHERE org_id=$1 AND agent_id=$2 AND status='open'`, agent.OrgID, agent.ActorID).Scan(&open); err != nil {
		return Collection{}, err
	}
	if open >= s.limits.MaxOpenCollectionsPerAgent {
		return Collection{}, fmt.Errorf("%w: at most %d open collections per agent", ErrLimit, s.limits.MaxOpenCollectionsPerAgent)
	}
	collectionID := uuid.Must(uuid.NewV7()).String()
	if _, err := tx.Exec(ctx, `INSERT INTO agent_collections(id,org_id,agent_id,agent_version,run_id,chat_id,message_id,response_kind,match_values,expected_actor_ids,
			deadline_at,remind_every_seconds,max_reminders,reminder_channel,reminder_text,report_chat_id,report_thread_root_id,note,next_reminder_at)
		VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`,
		collectionID, agent.OrgID, agent.ActorID, run.AgentVersion, runID, chatID, input.MessageID, input.Response, match, expected,
		deadline, remindEvery, input.MaxReminders, input.ReminderChannel, input.ReminderText, reportChatID, reportRoot, input.Note, nextReminder); err != nil {
		return Collection{}, fmt.Errorf("start collection: %w", err)
	}
	if err := audit(ctx, tx, agent.OrgID, agent.ActorID, "agent.collection.start", "agent", agent.ActorID, map[string]any{
		"collection_id": collectionID, "run_id": runID, "message_id": input.MessageID, "expected": len(expected), "deadline_at": deadline,
	}); err != nil {
		return Collection{}, err
	}
	result, err := s.loadCollection(ctx, tx, agent.OrgID, collectionID, "")
	if err != nil {
		return Collection{}, err
	}
	return result, tx.Commit(ctx)
}

func (s *Service) resolveExpected(ctx context.Context, tx pgx.Tx, orgID, chatID, authorID string, input StartCollectionInput) ([]string, error) {
	if input.ExpectAllMembers == (len(input.ExpectedActorIDs) > 0) {
		return nil, fmt.Errorf("%w: use either expected_actor_ids or expect_all_members", ErrInvalid)
	}
	if len(input.ExpectedActorIDs) > 500 {
		return nil, fmt.Errorf("%w: at most 500 expected participants", ErrInvalid)
	}
	for _, actorID := range input.ExpectedActorIDs {
		if uuid.Validate(actorID) != nil {
			return nil, fmt.Errorf("%w: expected_actor_ids must contain UUIDs", ErrInvalid)
		}
	}
	rows, err := tx.Query(ctx, `SELECT cm.actor_id FROM chat_members cm JOIN actors a ON a.org_id=cm.org_id AND a.id=cm.actor_id
		WHERE cm.org_id=$1 AND cm.chat_id=$2 AND a.type='user' AND a.status='active' AND a.deleted_at IS NULL
		AND (($3::boolean AND cm.actor_id<>$4) OR cm.actor_id=ANY($5::uuid[]))
		ORDER BY cm.actor_id LIMIT 501`, orgID, chatID, input.ExpectAllMembers, authorID, input.ExpectedActorIDs)
	if err != nil {
		return nil, err
	}
	expected, err := pgx.CollectRows(rows, pgx.RowTo[string])
	if err != nil {
		return nil, err
	}
	if len(expected) > 500 {
		return nil, fmt.Errorf("%w: the chat has more than 500 members to wait for", ErrInvalid)
	}
	if !input.ExpectAllMembers && len(expected) != len(uniqueStrings(input.ExpectedActorIDs)) {
		return nil, fmt.Errorf("%w: expected participants must be active human chat members", ErrInvalid)
	}
	if len(expected) == 0 {
		return nil, fmt.Errorf("%w: there is nobody to wait for", ErrInvalid)
	}
	return expected, nil
}

func uniqueStrings(values []string) []string {
	seen := make(map[string]struct{}, len(values))
	result := make([]string, 0, len(values))
	for _, value := range values {
		if _, ok := seen[value]; !ok {
			seen[value] = struct{}{}
			result = append(result, value)
		}
	}
	return result
}

// GetCollection returns an agent's own collection with freshly counted
// responses.
func (s *Service) GetCollection(ctx context.Context, agent identity.User, collectionID string) (Collection, error) {
	if uuid.Validate(collectionID) != nil {
		return Collection{}, fmt.Errorf("%w: collection_id must be a UUID", ErrInvalid)
	}
	return s.loadCollection(ctx, s.pool, agent.OrgID, collectionID, agent.ActorID)
}

func (s *Service) loadCollection(ctx context.Context, q querier, orgID, collectionID, agentID string) (Collection, error) {
	result, err := scanCollection(q.QueryRow(ctx, collectionSelect+` WHERE c.org_id=$1 AND c.id=$2 AND ($3='' OR c.agent_id::text=$3)`, orgID, collectionID, agentID))
	if errors.Is(err, pgx.ErrNoRows) {
		return Collection{}, ErrNotFound
	}
	if err != nil {
		return Collection{}, err
	}
	if err := countResponses(ctx, q, &result); err != nil {
		return Collection{}, err
	}
	return result, nil
}

// countResponses evaluates the collection against current reactions, button
// presses or thread replies of the expected participants.
func countResponses(ctx context.Context, q querier, collection *Collection) error {
	var query string
	args := []any{collection.orgID, collection.MessageID, collection.ExpectedActorIDs, collection.Match}
	switch collection.Response {
	case "reaction":
		query = `SELECT actor_id, min(emoji), min(created_at) FROM reactions
			WHERE org_id=$1 AND message_id=$2 AND actor_id=ANY($3::uuid[]) AND (cardinality($4::text[])=0 OR emoji=ANY($4::text[]))
			GROUP BY actor_id`
	case "action":
		query = `SELECT actor_id, min(action_id), min(created_at) FROM message_action_responses
			WHERE org_id=$1 AND message_id=$2 AND actor_id=ANY($3::uuid[]) AND (cardinality($4::text[])=0 OR action_id=ANY($4::text[]))
			GROUP BY actor_id`
	case "reply":
		root := collection.MessageID
		if collection.targetRoot != nil {
			root = *collection.targetRoot
		}
		query = `SELECT actor_id, (array_agg(id::text ORDER BY created_seq))[1], min(created_at) FROM messages
			WHERE org_id=$1 AND actor_id=ANY($3::uuid[]) AND deleted_at IS NULL AND id<>$2 AND created_at>=$6
			AND cardinality($4::text[])>=0 AND (reply_to_id=$2 OR thread_root_id=$5::uuid)
			GROUP BY actor_id`
		args = append(args, root, collection.targetAt)
	default:
		return fmt.Errorf("unsupported collection response kind %q", collection.Response)
	}
	rows, err := q.Query(ctx, query, args...)
	if err != nil {
		return fmt.Errorf("count collection responses: %w", err)
	}
	defer rows.Close()
	collection.Responded = make([]CollectionResponse, 0)
	responded := map[string]bool{}
	for rows.Next() {
		var item CollectionResponse
		if err := rows.Scan(&item.ActorID, &item.Value, &item.RespondedAt); err != nil {
			return err
		}
		responded[item.ActorID] = true
		collection.Responded = append(collection.Responded, item)
	}
	if err := rows.Err(); err != nil {
		return err
	}
	sort.Slice(collection.Responded, func(i, j int) bool {
		return collection.Responded[i].RespondedAt.Before(collection.Responded[j].RespondedAt)
	})
	collection.PendingActorIDs = make([]string, 0)
	for _, actorID := range collection.ExpectedActorIDs {
		if !responded[actorID] {
			collection.PendingActorIDs = append(collection.PendingActorIDs, actorID)
		}
	}
	return nil
}

// ProcessCollections closes finished or expired collections, wakes the agent
// with the result and sends due reminders.
func (s *Service) ProcessCollections(ctx context.Context) error {
	// Only collections with something due: a reminder, the deadline, or a
	// recount of answers at most once a minute.
	now := s.now().UTC()
	rows, err := s.pool.Query(ctx, `SELECT id FROM agent_collections WHERE status='open'
		AND (deadline_at<=$1 OR next_reminder_at<=$1 OR checked_at IS NULL OR checked_at<=$1-interval '1 minute')
		ORDER BY COALESCE(next_reminder_at, deadline_at) LIMIT 200`, now)
	if err != nil {
		return err
	}
	open, err := pgx.CollectRows(rows, pgx.RowTo[string])
	if err != nil {
		return err
	}
	for _, collectionID := range open {
		if err := s.processCollection(ctx, collectionID); err != nil {
			s.logger.Error("agent collection processing failed", "collection_id", collectionID, "error", err)
		}
	}
	return nil
}

func (s *Service) processCollection(ctx context.Context, collectionID string) error {
	now := s.now().UTC()
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	var orgID string
	err = tx.QueryRow(ctx, `SELECT org_id FROM agent_collections WHERE id=$1 AND status='open' FOR UPDATE SKIP LOCKED`, collectionID).Scan(&orgID)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	collection, err := s.loadCollection(ctx, tx, orgID, collectionID, "")
	if err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `UPDATE agent_collections SET checked_at=$2 WHERE id=$1`, collectionID, now); err != nil {
		return err
	}
	var enabled bool
	var deleted bool
	if err := tx.QueryRow(ctx, `SELECT enabled, deleted_at IS NOT NULL FROM agents WHERE org_id=$1 AND actor_id=$2`, orgID, collection.AgentID).Scan(&enabled, &deleted); err != nil {
		return err
	}
	if deleted {
		_, err := tx.Exec(ctx, `UPDATE agent_collections SET status='canceled', cancel_reason='agent_deleted', next_reminder_at=NULL, closed_at=now() WHERE id=$1`, collectionID)
		if err != nil {
			return err
		}
		return tx.Commit(ctx)
	}
	closing := ""
	switch {
	case len(collection.PendingActorIDs) == 0:
		closing = "completed"
	case !now.Before(collection.DeadlineAt):
		closing = "expired"
	}
	if closing != "" {
		return s.closeCollection(ctx, tx, collection, closing)
	}
	if collection.NextReminderAt == nil || now.Before(*collection.NextReminderAt) {
		return tx.Commit(ctx)
	}
	if !enabled {
		// Pausing an agent cancels its reminders; the collection keeps
		// counting so get_collection stays truthful after resume.
		if _, err := tx.Exec(ctx, `UPDATE agent_collections SET next_reminder_at=NULL, reminders_canceled_at=now() WHERE id=$1`, collectionID); err != nil {
			return err
		}
		return tx.Commit(ctx)
	}
	next, err := s.sendReminders(ctx, tx, collection, now)
	if err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `UPDATE agent_collections SET next_reminder_at=$2 WHERE id=$1`, collectionID, next); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (s *Service) closeCollection(ctx context.Context, tx pgx.Tx, collection Collection, status string) error {
	collection.Status = status
	reportChat := collection.ReportChatID
	depth := 0
	if collection.runID != nil {
		if err := tx.QueryRow(ctx, `SELECT chain_depth FROM agent_runs WHERE id=$1`, *collection.runID).Scan(&depth); err != nil && !errors.Is(err, pgx.ErrNoRows) {
			return err
		}
	}
	runID, _, err := enqueueRun(ctx, tx, runRequest{
		OrgID: collection.orgID, AgentID: collection.AgentID, ChatID: reportChat, ThreadRootID: collection.ReportThreadRootID,
		ClientRunID: stableID("collection-report", collection.ID), ChainDepth: depth + 1,
		Input: map[string]any{
			"trigger_type": "collection", "reason": status, "collection_id": collection.ID, "message_id": collection.MessageID,
			"chat_id": reportChat, "thread_root_id": collection.ReportThreadRootID, "note": collection.Note,
			"response": collection.Response, "expected_actor_ids": collection.ExpectedActorIDs,
			"responded": collection.Responded, "pending_actor_ids": collection.PendingActorIDs, "deadline_at": collection.DeadlineAt,
		},
	})
	if err != nil {
		return err
	}
	var reportRunID *string
	if runID != "" {
		reportRunID = &runID
	}
	if _, err := tx.Exec(ctx, `UPDATE agent_collections SET status=$2, next_reminder_at=NULL, report_run_id=$3, closed_at=now() WHERE id=$1`, collection.ID, status, reportRunID); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// sendReminders delivers one reminder round and returns when the next round is
// due. People inside quiet hours are deferred to the end of their window;
// people over a per-collection or daily cap are skipped.
func (s *Service) sendReminders(ctx context.Context, tx pgx.Tx, collection Collection, now time.Time) (*time.Time, error) {
	if collection.runID == nil || collection.RemindEverySeconds == nil {
		return nil, nil
	}
	// The agent must still be in the chat; otherwise the round cannot be
	// delivered and retrying it every tick only repeats the failure.
	if member, err := agentMember(ctx, tx, collection.orgID, collection.AgentID, collection.ChatID); err != nil {
		return nil, err
	} else if !member {
		if _, err := tx.Exec(ctx, `UPDATE agent_collections SET reminders_canceled_at=COALESCE(reminders_canceled_at,now()) WHERE id=$1`, collection.ID); err != nil {
			return nil, err
		}
		return nil, nil
	}
	// Only people who are still members of the chat are reminded.
	rows, err := tx.Query(ctx, `SELECT a.id, a.timezone,
			(SELECT count(*) FROM agent_reminders r WHERE r.collection_id=$2 AND r.actor_id=a.id),
			(SELECT count(*) FROM agent_reminders r WHERE r.org_id=a.org_id AND r.actor_id=a.id AND r.sent_at>$4)
		FROM actors a JOIN chat_members cm ON cm.org_id=a.org_id AND cm.actor_id=a.id AND cm.chat_id=$5
		WHERE a.org_id=$1 AND a.id=ANY($3::uuid[]) AND a.status='active' AND a.deleted_at IS NULL AND NOT EXISTS (SELECT 1 FROM agents sys WHERE sys.org_id = a.org_id AND sys.actor_id = a.id AND sys.system_role IS NOT NULL) ORDER BY a.id`,
		collection.orgID, collection.ID, collection.PendingActorIDs, now.Add(-24*time.Hour), collection.ChatID)
	if err != nil {
		return nil, err
	}
	type candidate struct {
		actorID, timezone string
		sent, daily       int
	}
	candidates, err := pgx.CollectRows(rows, func(row pgx.CollectableRow) (candidate, error) {
		var item candidate
		err := row.Scan(&item.actorID, &item.timezone, &item.sent, &item.daily)
		return item, err
	})
	if err != nil {
		return nil, err
	}
	next := now.Add(time.Duration(*collection.RemindEverySeconds) * time.Second)
	eligible := make([]string, 0, len(candidates))
	remaining := false
	for _, item := range candidates {
		if item.sent >= collection.MaxReminders {
			continue
		}
		if item.daily >= s.limits.MaxRemindersPerPersonPerDay {
			remaining = true
			continue
		}
		if quiet, ends := s.inQuietHours(now, item.timezone); quiet {
			remaining = true
			if ends.Before(next) {
				next = ends
			}
			continue
		}
		eligible = append(eligible, item.actorID)
		if item.sent+1 < collection.MaxReminders {
			remaining = true
		}
	}
	if len(eligible) > 0 {
		agent := identity.User{ActorID: collection.AgentID, OrgID: collection.orgID, OrgRole: "member"}
		// The executor decided on direct reminders when the collection was
		// started; limits and quiet hours still apply to every delivery.
		ctx := message.WithApprovedWrite(ctx)
		round := strconv.FormatInt(collection.NextReminderAt.Unix(), 10)
		source := &message.Blocks{Version: message.BlocksVersion, Sources: []message.Source{{Kind: "message", MessageID: collection.MessageID}}}
		messageIDs := map[string]*string{}
		if collection.ReminderChannel == "direct" {
			for _, actorID := range eligible {
				sent, err := s.deliverDirect(ctx, agent, *collection.runID, actorID, stableID("reminder", collection.ID, round, actorID), collection.reminderText, "plain", source)
				if err != nil {
					s.logger.Warn("agent reminder delivery failed", "collection_id", collection.ID, "actor_id", actorID, "error", err)
					continue
				}
				messageIDs[actorID] = &sent.ID
			}
		} else {
			root := collection.MessageID
			if collection.targetRoot != nil {
				root = *collection.targetRoot
			}
			sent, _, err := s.messages.CreateForAgentRun(ctx, agent, collection.ChatID, message.CreateInput{
				ClientMsgID: stableID("reminder", collection.ID, round), Body: collection.reminderText, BodyFormat: "plain",
				ThreadRootID: &root, ReplyToID: &collection.MessageID, MentionedActorIDs: eligible,
			}, message.AgentProvenance{RunID: *collection.runID})
			if err != nil {
				// A failed round is postponed by one interval instead of being
				// retried every tick until the deadline.
				s.logger.Warn("agent thread reminder failed", "collection_id", collection.ID, "error", err)
				if next.After(collection.DeadlineAt) {
					return nil, nil
				}
				return &next, nil
			}
			for _, actorID := range eligible {
				messageIDs[actorID] = &sent.ID
			}
		}
		for _, actorID := range eligible {
			if messageIDs[actorID] == nil {
				continue
			}
			if _, err := tx.Exec(ctx, `INSERT INTO agent_reminders(id,org_id,collection_id,actor_id,message_id) VALUES($1,$2,$3,$4,$5)`,
				uuid.Must(uuid.NewV7()).String(), collection.orgID, collection.ID, actorID, messageIDs[actorID]); err != nil {
				return nil, err
			}
		}
	}
	if !remaining {
		return nil, nil
	}
	if next.After(collection.DeadlineAt) {
		return nil, nil
	}
	return &next, nil
}

// DirectMessageInput is the payload of send_direct_message.
type DirectMessageInput struct {
	ActorID     string `json:"actor_id"`
	ClientMsgID string `json:"client_msg_id"`
	Body        string `json:"body"`
	BodyFormat  string `json:"body_format"`
}

// SendDirectMessage delivers an agent message to one person in their direct
// chat with the agent. The person must already share a chat with the agent,
// and the per-person daily cap applies.
func (s *Service) SendDirectMessage(ctx context.Context, agent identity.User, runID string, input DirectMessageInput) (message.Message, error) {
	if uuid.Validate(input.ActorID) != nil || uuid.Validate(input.ClientMsgID) != nil || uuid.Validate(runID) != nil {
		return message.Message{}, fmt.Errorf("%w: actor_id, client_msg_id and run_id must be UUIDs", ErrInvalid)
	}
	if input.ActorID == agent.ActorID {
		return message.Message{}, fmt.Errorf("%w: an agent cannot message itself", ErrInvalid)
	}
	var shared bool
	var sentToday int
	err := s.pool.QueryRow(ctx, `SELECT
		EXISTS(SELECT 1 FROM chat_members mine JOIN chat_members theirs ON theirs.org_id=mine.org_id AND theirs.chat_id=mine.chat_id
			JOIN chats c ON c.org_id=mine.org_id AND c.id=mine.chat_id AND c.archived_at IS NULL
			JOIN actors a ON a.org_id=theirs.org_id AND a.id=theirs.actor_id AND a.type='user' AND a.status='active' AND a.deleted_at IS NULL
			WHERE mine.org_id=$1 AND mine.actor_id=$2 AND theirs.actor_id=$3),
		(SELECT count(*) FROM messages m JOIN chats c ON c.org_id=m.org_id AND c.id=m.chat_id AND c.kind='direct'
			WHERE m.org_id=$1 AND m.actor_id=$2 AND m.created_at>$4 AND c.direct_pair_key=$5)`,
		agent.OrgID, agent.ActorID, input.ActorID, s.now().UTC().Add(-24*time.Hour), pairKey(agent.ActorID, input.ActorID)).Scan(&shared, &sentToday)
	if err != nil {
		return message.Message{}, err
	}
	if !shared {
		return message.Message{}, ErrForbidden
	}
	if sentToday >= s.limits.MaxDirectMessagesPerPersonPerDay {
		return message.Message{}, fmt.Errorf("%w: daily direct message limit for this person", ErrLimit)
	}
	return s.deliverDirect(ctx, agent, runID, input.ActorID, input.ClientMsgID, input.Body, input.BodyFormat, nil)
}

func pairKey(left, right string) string {
	if right < left {
		left, right = right, left
	}
	return left + ":" + right
}

func (s *Service) deliverDirect(ctx context.Context, agent identity.User, runID, actorID, clientMsgID, body, bodyFormat string, blocks *message.Blocks) (message.Message, error) {
	if s.chats == nil {
		return message.Message{}, fmt.Errorf("direct chats are unavailable")
	}
	direct, err := s.chats.Create(ctx, agent, chat.CreateInput{Kind: "direct", Visibility: "private", MemberIDs: []string{actorID}})
	if err != nil {
		return message.Message{}, fmt.Errorf("open direct chat: %w", err)
	}
	created, _, err := s.messages.CreateForAgentRun(ctx, agent, direct.ID, message.CreateInput{
		ClientMsgID: clientMsgID, Body: body, BodyFormat: bodyFormat, Blocks: blocks,
	}, message.AgentProvenance{RunID: runID})
	return created, err
}

// CollectionSummary is the observer view of a response collection: counts,
// not the people, so the activity feed never widens who sees whom answered.
type CollectionSummary struct {
	ID             string     `json:"id"`
	AgentID        string     `json:"agent_id"`
	ChatID         string     `json:"chat_id"`
	MessageID      string     `json:"message_id"`
	Response       string     `json:"response"`
	Status         string     `json:"status"`
	ExpectedCount  int        `json:"expected_count"`
	RespondedCount int        `json:"responded_count"`
	RemindersSent  int        `json:"reminders_sent"`
	DeadlineAt     time.Time  `json:"deadline_at"`
	NextReminderAt *time.Time `json:"next_reminder_at"`
	Note           string     `json:"note"`
	CancelReason   string     `json:"cancel_reason"`
	CreatedAt      time.Time  `json:"created_at"`
	ClosedAt       *time.Time `json:"closed_at"`
}

// ListCollections returns the newest collections of the organization for the
// agent activity view. The caller authorizes the observer; responses are
// counted against the current reactions, presses and replies.
func (s *Service) ListCollections(ctx context.Context, orgID, agentID, status string) ([]CollectionSummary, error) {
	if status == "all" {
		status = ""
	}
	if status != "" && status != "open" && status != "completed" && status != "expired" && status != "canceled" {
		return nil, fmt.Errorf("%w: unsupported status", ErrInvalid)
	}
	if agentID != "" && uuid.Validate(agentID) != nil {
		return nil, fmt.Errorf("%w: agent_id must be a UUID", ErrInvalid)
	}
	rows, err := s.pool.Query(ctx, collectionSelect+` WHERE c.org_id=$1 AND ($2='' OR c.agent_id::text=$2) AND ($3='' OR c.status=$3) ORDER BY c.created_at DESC LIMIT 50`, orgID, agentID, status)
	if err != nil {
		return nil, err
	}
	collections := make([]Collection, 0)
	for rows.Next() {
		item, err := scanCollection(rows)
		if err != nil {
			rows.Close()
			return nil, err
		}
		collections = append(collections, item)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	result := make([]CollectionSummary, 0, len(collections))
	for index := range collections {
		item := &collections[index]
		if err := countResponses(ctx, s.pool, item); err != nil {
			return nil, err
		}
		result = append(result, CollectionSummary{
			ID: item.ID, AgentID: item.AgentID, ChatID: item.ChatID, MessageID: item.MessageID, Response: item.Response,
			Status: item.Status, ExpectedCount: len(item.ExpectedActorIDs), RespondedCount: len(item.Responded),
			RemindersSent: item.RemindersSent, DeadlineAt: item.DeadlineAt, NextReminderAt: item.NextReminderAt,
			Note: item.Note, CancelReason: item.CancelReason, CreatedAt: item.CreatedAt, ClosedAt: item.ClosedAt,
		})
	}
	return result, nil
}
