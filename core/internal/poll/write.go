package poll

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"time"

	"github.com/comamessenger/comamessenger/core/internal/authz"
	"github.com/comamessenger/comamessenger/core/internal/identity"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// action is a locked poll with the reader's standing and own vote.
type action struct {
	r   record
	who standing
	own mine
}

// begin opens an action: the organization lock, then the poll (message row
// first), then the reader as stored now. Someone who is not an active
// member gets 404, except the author and voters, who get not_member: they
// know the poll exists.
func (s *Service) begin(ctx context.Context, tx pgx.Tx, user identity.User, messageID string) (action, error) {
	if uuid.Validate(messageID) != nil {
		return action{}, ErrNotFound
	}
	if err := lockOrganization(ctx, tx, user.OrgID); err != nil {
		return action{}, err
	}
	r, err := lockPoll(ctx, tx, user.OrgID, messageID)
	if err != nil {
		return action{}, err
	}
	if r.MessageDeleted {
		return action{}, ErrNotFound
	}
	who, err := readStanding(ctx, tx, user, r.ChatID)
	if err != nil {
		return action{}, err
	}
	own, err := readMine(ctx, tx, user.OrgID, user.ActorID, []string{messageID})
	if err != nil {
		return action{}, err
	}
	if !who.Member {
		if who.Person && (r.AuthorID == user.ActorID || own[messageID].Voted) {
			return action{}, ErrNotMember
		}
		return action{}, ErrNotFound
	}
	return action{r: r, who: who, own: own[messageID]}, nil
}

// state is the poll and the viewer of user after an action, in tx.
func (s *Service) state(ctx context.Context, tx pgx.Tx, user identity.User, messageID string) (State, error) {
	records, err := loadRecords(ctx, tx, user.OrgID, []string{messageID})
	if err != nil {
		return State{}, err
	}
	r, ok := records[messageID]
	if !ok || r.MessageDeleted {
		return State{}, ErrNotFound
	}
	viewers, err := viewersOf(ctx, tx, user, s.Now(), s.limits, records)
	if err != nil {
		return State{}, err
	}
	viewer := viewers[messageID]
	if viewer == nil {
		viewer = &Viewer{}
	}
	return State{Poll: r.public(), Viewer: viewer}, nil
}

// write runs fn in a transaction, commits and wakes realtime.
func (s *Service) write(ctx context.Context, user identity.User, fn func(pgx.Tx) (int64, error)) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("begin poll write: %w", err)
	}
	defer tx.Rollback(ctx)
	seq, err := fn(tx)
	if err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("commit poll write: %w", err)
	}
	s.notify(user.OrgID, seq)
	return nil
}

// Get is getPoll: the poll and the reader's view, to an active member of
// the chat, the chat not archived and the message not deleted.
func (s *Service) Get(ctx context.Context, user identity.User, messageID string) (State, error) {
	if uuid.Validate(messageID) != nil {
		return State{}, ErrNotFound
	}
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{AccessMode: pgx.ReadOnly, IsoLevel: pgx.RepeatableRead})
	if err != nil {
		return State{}, fmt.Errorf("begin get poll: %w", err)
	}
	defer tx.Rollback(ctx)
	if err := visible(ctx, tx, user, messageID); err != nil {
		return State{}, err
	}
	result, err := s.state(ctx, tx, user, messageID)
	if err != nil {
		return State{}, err
	}
	return result, tx.Commit(ctx)
}

// visible is the reading rule of a poll: the message is not deleted, the
// chat is not archived, the reader is an active person who is a member of
// it now. ErrNotFound otherwise, also for a message that is not a poll.
func visible(ctx context.Context, q querier, user identity.User, messageID string) error {
	var ok bool
	err := q.QueryRow(ctx, `
		SELECT true FROM message_polls p
		JOIN messages m ON m.org_id = p.org_id AND m.id = p.message_id AND m.deleted_at IS NULL
		JOIN chats c ON c.org_id = p.org_id AND c.id = p.chat_id AND c.archived_at IS NULL
		JOIN chat_members vcm ON vcm.org_id = p.org_id AND vcm.chat_id = p.chat_id AND vcm.actor_id = $3
		JOIN actors va ON va.org_id = p.org_id AND va.id = vcm.actor_id AND `+activePerson("va")+`
		WHERE p.org_id = $1 AND p.message_id = $2`, user.OrgID, messageID, user.ActorID).Scan(&ok)
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrNotFound
	}
	if err != nil {
		return fmt.Errorf("find poll: %w", err)
	}
	return nil
}

// VoteInput is votePoll.
type VoteInput struct {
	Options         []int `json:"options"`
	ExpectedVersion *int  `json:"expected_version"`
}

// normalizeChoice checks the chosen options against the poll and returns
// them sorted. The error never names the chosen options.
func normalizeChoice(r record, options []int) ([]int, error) {
	if len(options) == 0 || len(options) > MaxOptions {
		return nil, invalid("options", "choose at least one option")
	}
	if !r.Multiple && len(options) != 1 {
		return nil, invalid("options", "this poll takes exactly one option")
	}
	result := append([]int{}, options...)
	slices.Sort(result)
	for index, option := range result {
		if option < 0 || option >= len(r.Options) {
			return nil, invalid("options", "an option index is out of range")
		}
		if index > 0 && result[index-1] == option {
			return nil, invalid("options", "options must not repeat")
		}
	}
	return result, nil
}

// Vote is votePoll. An ordinary vote sets or replaces the choice; an
// anonymous one is accepted once and only adds to the counts, without
// storing who chose what.
func (s *Service) Vote(ctx context.Context, user identity.User, messageID string, input VoteInput) (State, error) {
	var result State
	err := s.write(ctx, user, func(tx pgx.Tx) (int64, error) {
		a, err := s.begin(ctx, tx, user, messageID)
		if err != nil {
			return 0, err
		}
		r := a.r
		switch {
		case r.ChatArchived:
			return 0, ErrChatArchived
		case r.Status != StatusOpen:
			return 0, ErrClosed
		case r.Anonymous && a.own.Voted:
			return 0, ErrVoteFinal
		case input.ExpectedVersion != nil && *input.ExpectedVersion != r.Version:
			return 0, ErrVersionConflict
		}
		choice, err := normalizeChoice(r, input.Options)
		if err != nil {
			return 0, err
		}
		var last int64
		if !(a.own.Voted && slices.Equal(a.own.Options, choice)) {
			if last, err = s.applyVote(ctx, tx, &r, user.ActorID, a.own, choice); err != nil {
				return 0, err
			}
		}
		result, err = s.state(ctx, tx, user, messageID)
		return last, err
	})
	return result, err
}

// applyVote changes the counts of a locked poll by one person's vote.
func (s *Service) applyVote(ctx context.Context, tx pgx.Tx, r *record, actorID string, own mine, choice []int) (int64, error) {
	now := s.Now()
	delta := make([]int32, len(r.Options))
	for _, option := range choice {
		delta[option]++
	}
	if own.Voted {
		for _, option := range own.Options {
			delta[option]--
		}
		if _, err := tx.Exec(ctx, `DELETE FROM message_poll_votes WHERE message_id = $1 AND actor_id = $2`, r.MessageID, actorID); err != nil {
			return 0, fmt.Errorf("replace poll vote: %w", err)
		}
		if _, err := tx.Exec(ctx, `UPDATE message_poll_voters SET voted_at = $3 WHERE message_id = $1 AND actor_id = $2`, r.MessageID, actorID, now); err != nil {
			return 0, fmt.Errorf("update poll voter: %w", err)
		}
	} else if _, err := tx.Exec(ctx, `INSERT INTO message_poll_voters (org_id, message_id, actor_id, voted_at) VALUES ($1, $2, $3, $4)`,
		r.OrgID, r.MessageID, actorID, now); err != nil {
		return 0, fmt.Errorf("record poll voter: %w", err)
	}
	if !r.Anonymous {
		if _, err := tx.Exec(ctx, `
			INSERT INTO message_poll_votes (org_id, message_id, actor_id, option_index, voted_at)
			SELECT $1, $2, $3, choice, $5 FROM unnest($4::smallint[]) AS choice`, r.OrgID, r.MessageID, actorID, choice, now); err != nil {
			return 0, fmt.Errorf("record poll vote: %w", err)
		}
	}
	added := 0
	if !own.Voted {
		added = 1
	}
	if _, err := tx.Exec(ctx, `
		UPDATE message_polls SET version = version + 1, voter_count = voter_count + $3,
			option_counts = ARRAY(SELECT c + d FROM unnest(option_counts, $2::int[]) WITH ORDINALITY AS x(c, d, i) ORDER BY i)
		WHERE message_id = $1`, r.MessageID, delta, added); err != nil {
		return 0, fmt.Errorf("count poll vote: %w", err)
	}
	if err := refresh(ctx, tx, r); err != nil {
		return 0, err
	}
	if _, err := emitUpdated(ctx, tx, *r); err != nil {
		return 0, err
	}
	return emitVote(ctx, tx, *r, actorID, choice)
}

// Retract is retractPollVote («Отменить голос») of an ordinary poll.
func (s *Service) Retract(ctx context.Context, user identity.User, messageID string) error {
	return s.write(ctx, user, func(tx pgx.Tx) (int64, error) {
		a, err := s.begin(ctx, tx, user, messageID)
		if err != nil {
			return 0, err
		}
		r := a.r
		switch {
		case r.Anonymous:
			return 0, ErrVoteFinal
		case r.ChatArchived:
			return 0, ErrChatArchived
		case r.Status != StatusOpen:
			return 0, ErrClosed
		case !a.own.Voted:
			return 0, nil
		}
		delta := make([]int32, len(r.Options))
		for _, option := range a.own.Options {
			delta[option]--
		}
		if _, err := tx.Exec(ctx, `DELETE FROM message_poll_voters WHERE message_id = $1 AND actor_id = $2`, messageID, user.ActorID); err != nil {
			return 0, fmt.Errorf("retract poll vote: %w", err)
		}
		if _, err := tx.Exec(ctx, `
			UPDATE message_polls SET version = version + 1, voter_count = voter_count - 1,
				option_counts = ARRAY(SELECT c + d FROM unnest(option_counts, $2::int[]) WITH ORDINALITY AS x(c, d, i) ORDER BY i)
			WHERE message_id = $1`, messageID, delta); err != nil {
			return 0, fmt.Errorf("uncount poll vote: %w", err)
		}
		if err := refresh(ctx, tx, &r); err != nil {
			return 0, err
		}
		if _, err := emitUpdated(ctx, tx, r); err != nil {
			return 0, err
		}
		return emitVote(ctx, tx, r, user.ActorID, []int{})
	})
}

// Close is closePoll: the author or a chat admin closes the poll for good.
// Closing a closed poll changes nothing. No push is sent.
func (s *Service) Close(ctx context.Context, user identity.User, messageID string) (State, error) {
	var result State
	err := s.write(ctx, user, func(tx pgx.Tx) (int64, error) {
		a, err := s.begin(ctx, tx, user, messageID)
		if err != nil {
			return 0, err
		}
		r := a.r
		author := r.AuthorID == user.ActorID
		if !author && !a.who.Admin() {
			return 0, ErrForbidden
		}
		if r.ChatArchived {
			return 0, ErrChatArchived
		}
		var last int64
		if r.Status == StatusOpen {
			reason := ReasonModerator
			if author {
				reason = ReasonAuthor
			}
			if last, err = s.closeTx(ctx, tx, &r, reason, &user.ActorID, s.Now()); err != nil {
				return 0, err
			}
		}
		result, err = s.state(ctx, tx, user, messageID)
		return last, err
	})
	return result, err
}

// RemindResult is PollRemindResult.
type RemindResult struct {
	Reminded     int        `json:"reminded"`
	NextRemindAt *time.Time `json:"next_remind_at"`
}

// Remind is «Напомнить не ответившим»: the author reminds the active people
// of the chat who have not voted, in an anonymous poll too, without
// learning who they are. A person gets at most DailyRemindersPerPerson
// such pushes a day from all polls; above it the reminder is recorded as an
// event without a push.
func (s *Service) Remind(ctx context.Context, user identity.User, messageID string) (RemindResult, error) {
	var result RemindResult
	err := s.write(ctx, user, func(tx pgx.Tx) (int64, error) {
		a, err := s.begin(ctx, tx, user, messageID)
		if err != nil {
			return 0, err
		}
		r := a.r
		now := s.Now()
		switch {
		case r.AuthorID != user.ActorID:
			return 0, ErrForbidden
		case r.ChatArchived:
			return 0, ErrChatArchived
		}
		if err := requirePublish(ctx, tx, user, r.ChatID); err != nil {
			return 0, err
		}
		switch {
		case r.Status != StatusOpen:
			return 0, ErrClosed
		case r.RemindCount >= s.limits.RemindMax:
			return 0, ErrLimitReached
		}
		if r.LastRemindAt != nil {
			if next := r.LastRemindAt.Add(s.limits.RemindInterval); now.Before(next) {
				return 0, &RemindTooSoonError{RetryAfter: next.Sub(now)}
			}
		}
		rows, err := tx.Query(ctx, `
			SELECT cm.actor_id, (SELECT count(*) FROM message_poll_reminders log
				WHERE log.org_id = $1 AND log.actor_id = cm.actor_id AND log.sent_at > $4::timestamptz - interval '24 hours') < $5
			FROM chat_members cm
			JOIN actors a ON a.org_id = cm.org_id AND a.id = cm.actor_id AND `+activePerson("a")+`
			WHERE cm.org_id = $1 AND cm.chat_id = $2 AND cm.actor_id <> $3
			  AND NOT EXISTS (SELECT 1 FROM message_poll_voters v WHERE v.message_id = $6 AND v.actor_id = cm.actor_id)
			ORDER BY cm.actor_id`, r.OrgID, r.ChatID, user.ActorID, now, s.limits.DailyRemindersPerPerson, messageID)
		if err != nil {
			return 0, fmt.Errorf("find poll reminder targets: %w", err)
		}
		type target struct {
			actorID string
			push    bool
		}
		targets, err := pgx.CollectRows(rows, func(row pgx.CollectableRow) (target, error) {
			var item target
			err := row.Scan(&item.actorID, &item.push)
			return item, err
		})
		if err != nil {
			return 0, fmt.Errorf("collect poll reminder targets: %w", err)
		}
		// Nobody to remind: the attempt is not spent.
		if len(targets) == 0 {
			if r.RemindCount < s.limits.RemindMax && r.LastRemindAt != nil {
				if next := r.LastRemindAt.Add(s.limits.RemindInterval); now.Before(next) {
					result.NextRemindAt = &next
				}
			}
			return 0, nil
		}
		// Over the daily limit a person gets nothing, not even an event: a
		// large chat must not turn reminders into a flood of events.
		pushed := []string{}
		var last int64
		for _, item := range targets {
			if !item.push {
				continue
			}
			if last, err = emitNotified(ctx, tx, r, "reminded", &user.ActorID, item.actorID, true); err != nil {
				return 0, err
			}
			pushed = append(pushed, item.actorID)
		}
		if len(pushed) > 0 {
			if _, err := tx.Exec(ctx, `
				WITH expired AS (
					DELETE FROM message_poll_reminders
					WHERE org_id = $1 AND actor_id = ANY($2::uuid[]) AND sent_at <= $3::timestamptz - interval '24 hours'
				)
				INSERT INTO message_poll_reminders (org_id, actor_id, message_id, sent_at)
				SELECT $1, target, $4, $3 FROM unnest($2::uuid[]) AS target`, r.OrgID, pushed, now, messageID); err != nil {
				return 0, fmt.Errorf("log poll reminders: %w", err)
			}
		}
		var count int
		if err := tx.QueryRow(ctx, `UPDATE message_polls SET last_remind_at = $2, remind_count = remind_count + 1 WHERE message_id = $1 RETURNING remind_count`,
			messageID, now).Scan(&count); err != nil {
			return 0, fmt.Errorf("record poll reminder: %w", err)
		}
		result.Reminded = len(targets)
		if count < s.limits.RemindMax {
			next := now.Add(s.limits.RemindInterval)
			result.NextRemindAt = &next
		}
		return last, nil
	})
	return result, err
}

// EditInput is updatePoll.
type EditInput struct {
	Question        string `json:"question"`
	ExpectedVersion *int   `json:"expected_version"`
}

// NormalizeEdit checks an edit without touching the database and returns
// the trimmed question.
func NormalizeEdit(input EditInput) (string, error) {
	if input.ExpectedVersion == nil || *input.ExpectedVersion < 1 {
		return "", invalid("expected_version", "expected_version is required")
	}
	return NormalizeQuestion(input.Question)
}

// EditTx stores the question the author edited (decision 12: the options,
// the flags and the due date never change) and returns the options to
// rebuild the body with; changed is false for the same question. Only the
// author while an active member, only an open poll — the result of a closed
// one answers the question as it was asked. The caller then rewrites the
// message and calls EmitUpdatedTx.
func (s *Service) EditTx(ctx context.Context, tx pgx.Tx, user identity.User, messageID, question string, expectedVersion int) ([]string, bool, error) {
	a, err := s.begin(ctx, tx, user, messageID)
	if err != nil {
		return nil, false, err
	}
	r := a.r
	switch {
	case r.AuthorID != user.ActorID:
		return nil, false, ErrForbidden
	case r.ChatArchived:
		return nil, false, ErrChatArchived
	}
	if err := requirePublish(ctx, tx, user, r.ChatID); err != nil {
		return nil, false, err
	}
	switch {
	case r.Status != StatusOpen:
		return nil, false, ErrClosed
	case expectedVersion != r.Version:
		return nil, false, ErrVersionConflict
	case question == r.Question:
		return r.Options, false, nil
	}
	if _, err := tx.Exec(ctx, `UPDATE message_polls SET question = $2, version = version + 1 WHERE message_id = $1`, messageID, question); err != nil {
		return nil, false, fmt.Errorf("edit poll question: %w", err)
	}
	return r.Options, true, nil
}

// EmitUpdatedTx writes poll.updated with the poll as it is now in tx.
func EmitUpdatedTx(ctx context.Context, tx pgx.Tx, orgID, messageID string) (int64, error) {
	records, err := loadRecords(ctx, tx, orgID, []string{messageID})
	if err != nil {
		return 0, err
	}
	r, ok := records[messageID]
	if !ok {
		return 0, ErrNotFound
	}
	return emitUpdated(ctx, tx, r)
}

// requirePublish: the author still may write to the chat (authz
// message.publish from the stored workspace and chat roles): in a channel
// an author demoted to a member no longer edits the question or reminds.
func requirePublish(ctx context.Context, tx pgx.Tx, user identity.User, chatID string) error {
	var kind, orgRole, chatRole string
	err := tx.QueryRow(ctx, `
		SELECT c.kind, a.org_role, cm.role FROM chats c
		JOIN chat_members cm ON cm.org_id = c.org_id AND cm.chat_id = c.id AND cm.actor_id = $3
		JOIN actors a ON a.org_id = c.org_id AND a.id = cm.actor_id
		WHERE c.org_id = $1 AND c.id = $2`, user.OrgID, chatID, user.ActorID).Scan(&kind, &orgRole, &chatRole)
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrForbidden
	}
	if err != nil {
		return fmt.Errorf("check poll author rights: %w", err)
	}
	if !authz.Can(authz.Context{Active: true, OrgRole: authz.Role(orgRole), ChatKind: authz.ChatKind(kind), ChatMember: true, ChatRole: authz.Role(chatRole)}, authz.MessagePublish) {
		return ErrForbidden
	}
	return nil
}
