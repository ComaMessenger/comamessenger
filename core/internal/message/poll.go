package message

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/comamessenger/comamessenger/core/internal/id"
	"github.com/comamessenger/comamessenger/core/internal/identity"
	"github.com/comamessenger/comamessenger/core/internal/poll"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// Polls («Опрос») are messages of type poll. This file is the glue between
// the ordinary send path and package poll: a poll is written by createTx
// like any message, with the poll row after it, in the same transaction.
// Votes, closing and reminders run in package poll, which answers with the
// poll state rather than the message.

// SetPolls enables poll messages; without it CreatePoll fails with
// poll.ErrUnavailable.
func (s *Service) SetPolls(polls *poll.Service) { s.polls = polls }

// Polls returns the poll service, nil when polls are off.
func (s *Service) Polls() *poll.Service { return s.polls }

// pollCreation travels with CreateInput through createTx.
type pollCreation struct {
	plan poll.Plan
}

// CreatePollInput is createPoll.
type CreatePollInput struct {
	ClientMsgID string     `json:"client_msg_id"`
	Question    string     `json:"question"`
	Options     []string   `json:"options"`
	Multiple    *bool      `json:"multiple"`
	Anonymous   *bool      `json:"anonymous"`
	DueAt       *time.Time `json:"due_at"`
}

// CreatePoll sends a poll message. People only: agents and API keys are
// refused. Polls go to the main feed of the chat, never into a thread. A
// replay with the same client_msg_id and content returns the original
// message with created false.
func (s *Service) CreatePoll(ctx context.Context, user identity.User, chatID string, input CreatePollInput) (Message, bool, error) {
	if s.polls == nil {
		return Message{}, false, poll.ErrUnavailable
	}
	if input.Multiple == nil {
		return Message{}, false, &poll.InvalidError{Field: "multiple", Message: "multiple is required"}
	}
	if input.Anonymous == nil {
		return Message{}, false, &poll.InvalidError{Field: "anonymous", Message: "anonymous is required"}
	}
	spec := poll.CreateSpec{Question: input.Question, Options: input.Options, Multiple: *input.Multiple, Anonymous: *input.Anonymous, DueAt: input.DueAt}
	plan, err := poll.Normalize(spec, s.polls.Now())
	if errors.Is(err, poll.ErrInvalid) {
		// A replay that arrives after its due date went stale is checked
		// against the moment it was first accepted.
		var createdAt time.Time
		if lookupErr := s.pool.QueryRow(ctx, `SELECT created_at FROM messages WHERE actor_id = $1 AND client_msg_id = $2 AND type = 'poll'`,
			user.ActorID, input.ClientMsgID).Scan(&createdAt); lookupErr == nil {
			plan, err = poll.Normalize(spec, createdAt)
		}
	}
	if err != nil {
		return Message{}, false, err
	}
	// An archived chat answers 409 chat_archived to its members; createTx
	// itself treats it as not found.
	if uuid.Validate(chatID) == nil {
		var archived bool
		if err := s.pool.QueryRow(ctx, `
			SELECT c.archived_at IS NOT NULL FROM chats c
			JOIN chat_members cm ON cm.org_id = c.org_id AND cm.chat_id = c.id AND cm.actor_id = $3
			WHERE c.org_id = $1 AND c.id = $2`, user.OrgID, chatID, user.ActorID).Scan(&archived); err == nil && archived {
			return Message{}, false, poll.ErrChatArchived
		}
	}
	draft := CreateInput{
		ClientMsgID: input.ClientMsgID, Body: poll.Body(plan.Question, plan.Options), BodyFormat: "plain",
		poll: &pollCreation{plan: plan},
	}
	if err := s.validateCreate(chatID, &draft); err != nil {
		return Message{}, false, err
	}
	draft.links = PrepareLinks(draft.Body, draft.BodyFormat)
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Message{}, false, fmt.Errorf("begin create poll: %w", err)
	}
	defer tx.Rollback(ctx)
	result, created, highWatermark, err := s.createTx(ctx, tx, user, chatID, draft, nil, false)
	if err != nil {
		return Message{}, false, err
	}
	if err := s.hydrateRequestViewers(ctx, tx, user, []*Message{&result}); err != nil {
		return Message{}, false, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Message{}, false, fmt.Errorf("commit create poll: %w", err)
	}
	if created {
		s.notifyAfterCommit(user.OrgID, highWatermark)
	}
	return result, created, nil
}

// preparePollTx runs inside createTx under the organization lock, before
// the message is written.
func (s *Service) preparePollTx(ctx context.Context, tx pgx.Tx, user identity.User, chatID string, input CreateInput) (poll.Prepared, error) {
	if input.ThreadRootID != nil || input.ReplyToID != nil || len(input.FileIDs) > 0 || input.Blocks != nil || input.Silent || len(input.MentionedActorIDs) > 0 || len(input.MentionedDepartmentIDs) > 0 {
		return poll.Prepared{}, invalid("a poll is a plain message of the main feed")
	}
	return s.polls.PrepareTx(ctx, tx, user, chatID, input.poll.plan)
}

// hydratePolls fills Poll on messages of type poll, one query per batch.
// Called by hydrateFiles, so every reader of messages, realtime frames
// included, gets it. MessagePoll is the same for everyone and never carries
// the counts of an open poll.
func hydratePolls(ctx context.Context, tx pgx.Tx, orgID string, messages []Message) error {
	ids := make([]string, 0)
	for index := range messages {
		messages[index].Poll = nil
		messages[index].PollViewer = nil
		if messages[index].Type == "poll" {
			ids = append(ids, messages[index].ID)
		}
	}
	if len(ids) == 0 {
		return nil
	}
	polls, err := poll.Load(ctx, tx, orgID, ids)
	if err != nil {
		return err
	}
	for index := range messages {
		if item, ok := polls[messages[index].ID]; ok {
			messages[index].Poll = item
		}
	}
	return nil
}

// hydratePollViewers fills PollViewer for the reading person: REST only,
// never in realtime frames. Agents get neither the poll nor a viewer (see
// hideTasksFromAgents, which runs first).
func (s *Service) hydratePollViewers(ctx context.Context, tx pgx.Tx, user identity.User, messages []*Message) error {
	if s.polls == nil {
		return nil
	}
	ids := make([]string, 0)
	for _, item := range messages {
		item.PollViewer = nil
		if item.Type == "poll" && item.Poll != nil {
			ids = append(ids, item.ID)
		}
	}
	if len(ids) == 0 {
		return nil
	}
	viewers, err := poll.Viewers(ctx, tx, user, s.polls.Now(), s.polls.Limits(), ids)
	if err != nil {
		return err
	}
	for _, item := range messages {
		if viewer, ok := viewers[item.ID]; ok {
			item.PollViewer = viewer
		}
	}
	return nil
}

// UpdatePoll is updatePoll: the author edits the question of an open poll
// (decision 12 of phase 6.7). The body is rebuilt from the new question and
// the options, which never change, as an edit of the message (a revision,
// edited_at, message.updated); poll.updated carries the new poll version.
func (s *Service) UpdatePoll(ctx context.Context, user identity.User, messageID string, input poll.EditInput) (Message, error) {
	if s.polls == nil {
		return Message{}, poll.ErrUnavailable
	}
	question, err := poll.NormalizeEdit(input)
	if err != nil {
		return Message{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Message{}, fmt.Errorf("begin update poll: %w", err)
	}
	defer tx.Rollback(ctx)
	options, changed, err := s.polls.EditTx(ctx, tx, user, messageID, question, *input.ExpectedVersion)
	if err != nil {
		return Message{}, err
	}
	var last int64
	if changed {
		if last, err = s.rewritePollBody(ctx, tx, user, messageID, poll.Body(question, options)); err != nil {
			return Message{}, err
		}
		seq, err := poll.EmitUpdatedTx(ctx, tx, user.OrgID, messageID)
		if err != nil {
			return Message{}, err
		}
		last = max(last, seq)
	}
	result, err := s.loadMessage(ctx, tx, user, messageID)
	if err != nil {
		return Message{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Message{}, fmt.Errorf("commit update poll: %w", err)
	}
	if last > 0 {
		s.notifyAfterCommit(user.OrgID, last)
	}
	return result, nil
}

// rewritePollBody puts the rebuilt body into the poll message, as an edit by
// user: a revision, a new message version, edited_at, message.updated.
func (s *Service) rewritePollBody(ctx context.Context, tx pgx.Tx, user identity.User, messageID, body string) (int64, error) {
	var current Message
	if err := scanMessage(tx.QueryRow(ctx, `
		SELECT id, chat_id, actor_id, client_msg_id, type, body, body_format, reply_to_id,
			thread_root_id, version, created_seq, created_at, edited_at, deleted_at, forwarded_from, mentioned_actor_ids, blocks
		FROM messages WHERE org_id = $1 AND id = $2`, user.OrgID, messageID), &current); err != nil {
		return 0, fmt.Errorf("read poll message: %w", err)
	}
	links := PrepareLinks(body, "plain")
	revisionID, err := id.New()
	if err != nil {
		return 0, fmt.Errorf("generate revision id: %w", err)
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO message_revisions (id, org_id, message_id, version, body, body_format, edited_by, mentioned_actor_ids)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`, revisionID, user.OrgID, messageID, current.Version,
		current.Body, current.BodyFormat, user.ActorID, current.MentionedActorIDs); err != nil {
		return 0, fmt.Errorf("insert poll revision: %w", err)
	}
	seq, err := nextSequence(ctx, tx, user.OrgID)
	if err != nil {
		return 0, err
	}
	var result Message
	if err := scanMessage(tx.QueryRow(ctx, `
		UPDATE messages SET body = $3, body_format = 'plain', version = version + 1, edited_at = now()
		WHERE org_id = $1 AND id = $2
		RETURNING id, chat_id, actor_id, client_msg_id, type, body, body_format, reply_to_id,
			thread_root_id, version, created_seq, created_at, edited_at, deleted_at, forwarded_from, mentioned_actor_ids, blocks`,
		user.OrgID, messageID, body), &result); err != nil {
		return 0, fmt.Errorf("rewrite poll body: %w", err)
	}
	if err := insertEvent(ctx, tx, user, result.ChatID, result.ID, seq, "message.updated"); err != nil {
		return 0, err
	}
	if err := syncMessageLinks(ctx, tx, user.OrgID, result, true, links); err != nil {
		return 0, err
	}
	return seq, nil
}
