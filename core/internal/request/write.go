package request

import (
	"context"
	"errors"
	"fmt"
	"time"
	"unicode/utf8"

	"github.com/comamessenger/comamessenger/core/internal/identity"
	"github.com/jackc/pgx/v5"
)

// Lock order of every write here, the same as message deletion:
//
//	organization → message_requests row → message_request_recipients row
//
// The organization row comes first (message.lockOrganization), so a request
// write and a message deletion (organization → message → request) never wait
// for each other in opposite orders. Nothing locks actors or chat rows.

// AnswerInput sets or changes the person's answer.
type AnswerInput struct {
	// Option is required: nil gets request_invalid, so an update of the
	// comment alone never overwrites the choice.
	Option *int `json:"option"`
	// Comment nil keeps the current comment; "" removes it.
	Comment *string `json:"comment"`
	// ExpectedVersion is the answer version the change is based on.
	ExpectedVersion *int `json:"expected_version"`
}

// viewerAccess is the reader's standing in the chat of a locked request.
type viewerAccess struct {
	member   bool
	chatRole string
}

func readAccess(ctx context.Context, tx pgx.Tx, user identity.User, chatID string) (viewerAccess, error) {
	var access viewerAccess
	err := tx.QueryRow(ctx, `
		SELECT cm.role FROM chat_members cm
		JOIN actors a ON a.org_id = cm.org_id AND a.id = cm.actor_id AND a.status = 'active' AND a.deleted_at IS NULL
		WHERE cm.org_id = $1 AND cm.chat_id = $2 AND cm.actor_id = $3`, user.OrgID, chatID, user.ActorID).Scan(&access.chatRole)
	if errors.Is(err, pgx.ErrNoRows) {
		return access, nil
	}
	if err != nil {
		return access, fmt.Errorf("read request chat membership: %w", err)
	}
	access.member = true
	return access, nil
}

// Answer sets or changes the person's answer. A repeat of the same answer
// changes nothing and emits nothing.
func (s *Service) Answer(ctx context.Context, user identity.User, messageID string, input AnswerInput) (State, error) {
	if err := validUUID("message_id", messageID); err != nil {
		return State{}, err
	}
	if input.Option == nil {
		return State{}, invalid("option", "option is required")
	}
	option := *input.Option
	if option < 0 || option > 3 {
		return State{}, invalid("option", "option must be between 0 and 3")
	}
	if input.Comment != nil && (utf8.RuneCountInString(*input.Comment) > MaxCommentRunes || !utf8.ValidString(*input.Comment)) {
		return State{}, invalid("comment", "comment must be at most %d characters", MaxCommentRunes)
	}
	if input.ExpectedVersion != nil && *input.ExpectedVersion < 1 {
		return State{}, invalid("expected_version", "expected_version must be positive")
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return State{}, fmt.Errorf("begin answer request: %w", err)
	}
	defer tx.Rollback(ctx)
	if err := lockOrganization(ctx, tx, user.OrgID); err != nil {
		return State{}, err
	}
	current, err := lockRequest(ctx, tx, user.OrgID, messageID)
	if err != nil {
		return State{}, err
	}
	if current.MessageDeleted {
		return State{}, ErrNotFound
	}
	access, err := readAccess(ctx, tx, user, current.ChatID)
	if err != nil {
		return State{}, err
	}
	var recipient struct {
		option     *int16
		comment    string
		answeredAt *time.Time
		late       bool
		version    int
	}
	err = tx.QueryRow(ctx, `
		SELECT option_index, comment, answered_at, answered_late, version FROM message_request_recipients
		WHERE message_id = $1 AND actor_id = $2 FOR UPDATE`, messageID, user.ActorID).Scan(
		&recipient.option, &recipient.comment, &recipient.answeredAt, &recipient.late, &recipient.version)
	isRecipient := err == nil
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return State{}, fmt.Errorf("lock request recipient: %w", err)
	}
	switch {
	case !access.member && isRecipient:
		return State{}, ErrNotMember
	case !access.member:
		return State{}, ErrNotFound
	case current.ChatArchived:
		return State{}, ErrChatArchived
	case !isRecipient:
		return State{}, ErrForbidden
	case current.Status != "open":
		return State{}, ErrClosed
	case option >= current.OptionCount:
		return State{}, invalid("option", "the request has no such option")
	case input.Comment != nil && *input.Comment != "" && !current.AllowComment:
		return State{}, invalid("comment", "the request does not take comments")
	}
	now := s.Now()
	first := recipient.answeredAt == nil
	comment := recipient.comment
	if input.Comment != nil {
		comment = *input.Comment
	}
	if input.ExpectedVersion != nil && *input.ExpectedVersion != recipient.version {
		return State{}, ErrVersionConflict
	}
	if !first {
		if int(*recipient.option) == option && comment == recipient.comment {
			state, err := s.stateTx(ctx, tx, user, messageID)
			if err != nil {
				return State{}, err
			}
			return state, tx.Commit(ctx)
		}
		if current.DueAt != nil && !now.Before(*current.DueAt) {
			return State{}, ErrChangeTooLate
		}
	}
	late := recipient.late
	if first {
		late = current.DueAt != nil && now.After(*current.DueAt)
	}
	var version int
	if err := tx.QueryRow(ctx, `
		UPDATE message_request_recipients SET option_index = $3, comment = $4,
			answered_at = COALESCE(answered_at, $5), answered_late = $6,
			changed_at = CASE WHEN answered_at IS NULL THEN NULL ELSE $5 END, version = version + 1
		WHERE message_id = $1 AND actor_id = $2 RETURNING version`,
		messageID, user.ActorID, option, comment, now, late).Scan(&version); err != nil {
		return State{}, fmt.Errorf("record request answer: %w", err)
	}
	// Only a first answer changes what everyone sees: the count and the
	// shared version. A changed answer moves the author's tally alone, so
	// the chat does not learn that somebody changed their mind.
	countChanged := 0
	if first {
		countChanged = 1
	}
	expireAt := current.ExpireAt
	if current.DueAt == nil {
		// Without a due date the request closes 30 days after the last
		// answer; its expiry job snoozes until then.
		expireAt = now.Add(s.limits.ExpireIdle)
	}
	if err := tx.QueryRow(ctx, `
		UPDATE message_requests SET answered_count = answered_count + $2, last_answer_at = $3, expire_at = $4, version = version + $2
		WHERE message_id = $1 RETURNING answered_count, version`, messageID, countChanged, now, expireAt).Scan(&current.AnsweredCount, &current.Version); err != nil {
		return State{}, fmt.Errorf("update request after answer: %w", err)
	}
	var seq int64
	if first {
		if seq, err = emitUpdated(ctx, tx, current); err != nil {
			return State{}, err
		}
	}
	tallies, err := loadTallies(ctx, tx, user.OrgID, []string{messageID})
	if err != nil {
		return State{}, err
	}
	waiting, err := waitingCount(ctx, tx, user.OrgID, messageID)
	if err != nil {
		return State{}, err
	}
	if seq, err = nextSequence(ctx, tx, user.OrgID); err != nil {
		return State{}, err
	}
	author := current.AuthorID
	if err := insertEvent(ctx, tx, user.OrgID, seq, "request.tally.updated", current.AuthorID, current.ChatID, messageID, &author, tallyEvent{
		MessageID: messageID, ChatID: current.ChatID, Tally: tallyOf(tallies[messageID], current.OptionCount),
		WaitingCount: waiting, Version: current.Version,
	}); err != nil {
		return State{}, err
	}
	if seq, err = nextSequence(ctx, tx, user.OrgID); err != nil {
		return State{}, err
	}
	answerer := user.ActorID
	if err := insertEvent(ctx, tx, user.OrgID, seq, "request.answer.updated", user.ActorID, current.ChatID, messageID, &answerer, answerEvent{
		MessageID: messageID, ChatID: current.ChatID, Option: option, HasComment: comment != "", Late: late, Version: version,
	}); err != nil {
		return State{}, err
	}
	state, err := s.stateTx(ctx, tx, user, messageID)
	if err != nil {
		return State{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return State{}, fmt.Errorf("commit request answer: %w", err)
	}
	s.notify(user.OrgID, seq)
	return state, nil
}

// Close closes the request: the author (reason author), or a chat owner or
// admin or a moderator in the chat (reason moderator). Closing a closed
// request returns its state and emits nothing.
func (s *Service) Close(ctx context.Context, user identity.User, messageID string) (State, error) {
	if err := validUUID("message_id", messageID); err != nil {
		return State{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return State{}, fmt.Errorf("begin close request: %w", err)
	}
	defer tx.Rollback(ctx)
	if err := lockOrganization(ctx, tx, user.OrgID); err != nil {
		return State{}, err
	}
	current, err := lockRequest(ctx, tx, user.OrgID, messageID)
	if err != nil {
		return State{}, err
	}
	access, err := readAccess(ctx, tx, user, current.ChatID)
	if err != nil {
		return State{}, err
	}
	if !access.member || current.MessageDeleted {
		return State{}, ErrNotFound
	}
	if current.ChatArchived {
		return State{}, ErrChatArchived
	}
	reason := "author"
	if current.AuthorID != user.ActorID {
		if !canModerate(user, true, access.chatRole) {
			return State{}, ErrForbidden
		}
		reason = "moderator"
	}
	var seq int64
	if current.Status == "open" {
		if err := tx.QueryRow(ctx, `
			UPDATE message_requests SET status='closed', closed_reason=$2, closed_by=$3, closed_at=$4,
				version=version+1, auto_remind_job_id=NULL, expire_job_id=NULL
			WHERE message_id=$1 RETURNING version`, messageID, reason, user.ActorID, s.Now()).Scan(&current.Version); err != nil {
			return State{}, fmt.Errorf("close request: %w", err)
		}
		if err := closeRecipientsTx(ctx, tx, messageID); err != nil {
			return State{}, err
		}
		if err := s.cancelJobs(ctx, tx, current); err != nil {
			return State{}, err
		}
		current.Status, current.ClosedReason = "closed", &reason
		if seq, err = emitUpdated(ctx, tx, current); err != nil {
			return State{}, err
		}
	}
	state, err := s.stateTx(ctx, tx, user, messageID)
	if err != nil {
		return State{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return State{}, fmt.Errorf("commit close request: %w", err)
	}
	s.notify(user.OrgID, seq)
	return state, nil
}

// RemindResult is the reply of remindRequest.
type RemindResult struct {
	Reminded     int        `json:"reminded"`
	NextRemindAt *time.Time `json:"next_remind_at"`
}

// Remind lets the author remind those who have not answered: not sooner
// than ManualRemindInterval after the previous time and at most
// ManualRemindMax times.
func (s *Service) Remind(ctx context.Context, user identity.User, messageID string) (RemindResult, error) {
	if err := validUUID("message_id", messageID); err != nil {
		return RemindResult{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return RemindResult{}, fmt.Errorf("begin remind request: %w", err)
	}
	defer tx.Rollback(ctx)
	if err := lockOrganization(ctx, tx, user.OrgID); err != nil {
		return RemindResult{}, err
	}
	current, err := lockRequest(ctx, tx, user.OrgID, messageID)
	if err != nil {
		return RemindResult{}, err
	}
	access, err := readAccess(ctx, tx, user, current.ChatID)
	if err != nil {
		return RemindResult{}, err
	}
	if !access.member || current.MessageDeleted {
		return RemindResult{}, ErrNotFound
	}
	switch {
	case current.ChatArchived:
		return RemindResult{}, ErrChatArchived
	case current.AuthorID != user.ActorID:
		return RemindResult{}, ErrForbidden
	case current.Status != "open":
		return RemindResult{}, ErrClosed
	case current.ManualRemindCount >= s.limits.ManualRemindMax:
		return RemindResult{}, ErrLimitReached
	}
	now := s.Now()
	if current.LastManualRemindAt != nil {
		if next := current.LastManualRemindAt.Add(s.limits.ManualRemindInterval); now.Before(next) {
			return RemindResult{}, &RemindTooSoonError{RetryAfter: next.Sub(now)}
		}
	}
	reminded, seq, err := s.remindWaitingTx(ctx, tx, current, "manual", now)
	if err != nil {
		return RemindResult{}, err
	}
	result := RemindResult{Reminded: reminded}
	if reminded > 0 {
		if _, err := tx.Exec(ctx, `UPDATE message_requests SET last_manual_remind_at=$2, manual_remind_count=manual_remind_count+1 WHERE message_id=$1`,
			messageID, now); err != nil {
			return RemindResult{}, fmt.Errorf("record manual request reminder: %w", err)
		}
		if current.ManualRemindCount+1 < s.limits.ManualRemindMax {
			next := now.Add(s.limits.ManualRemindInterval)
			result.NextRemindAt = &next
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return RemindResult{}, fmt.Errorf("commit remind request: %w", err)
	}
	s.notify(user.OrgID, seq)
	return result, nil
}

// remindWaitingTx sends request.reminded to every recipient without an
// answer who is still an active member, up to the daily limit per person.
// Everyone above the limit is counted in reminded but gets nothing.
func (s *Service) remindWaitingTx(ctx context.Context, tx pgx.Tx, current lockedRequest, kind string, now time.Time) (int, int64, error) {
	rows, err := tx.Query(ctx, `
		SELECT rr.actor_id, recent.count < $4
		FROM message_request_recipients rr `+recipientInChat+`
		CROSS JOIN LATERAL (
			SELECT count(*) FROM message_request_reminder_log log
			WHERE log.org_id = rr.org_id AND log.actor_id = rr.actor_id AND log.reminded_at > $3::timestamptz - interval '24 hours'
		) recent
		WHERE rr.org_id = $1 AND rr.message_id = $2 AND rr.answered_at IS NULL
		ORDER BY rr.actor_id
		FOR UPDATE OF rr`, current.OrgID, current.MessageID, now, s.limits.DailyRemindersPerPerson)
	if err != nil {
		return 0, 0, fmt.Errorf("find recipients to remind: %w", err)
	}
	type target struct {
		actorID string
		send    bool
	}
	targets, err := pgx.CollectRows(rows, func(row pgx.CollectableRow) (target, error) {
		var item target
		return item, row.Scan(&item.actorID, &item.send)
	})
	if err != nil {
		return 0, 0, fmt.Errorf("scan recipients to remind: %w", err)
	}
	sent := make([]string, 0, len(targets))
	for _, item := range targets {
		if item.send {
			sent = append(sent, item.actorID)
		}
	}
	seq, err := insertAudienceEvents(ctx, tx, current.OrgID, "request.reminded", current.AuthorID, current.ChatID, current.MessageID, sent,
		remindedEvent{MessageID: current.MessageID, ChatID: current.ChatID, Kind: kind})
	if err != nil {
		return 0, 0, err
	}
	if len(sent) > 0 {
		if _, err := tx.Exec(ctx, `
			UPDATE message_request_recipients SET last_reminded_at = $3, reminded_count = reminded_count + 1
			WHERE message_id = $1 AND actor_id = ANY($2::uuid[])`, current.MessageID, sent, now); err != nil {
			return 0, 0, fmt.Errorf("record request reminders: %w", err)
		}
		// The daily limit counts every reminder a person got in the last 24
		// hours, from all requests; older entries of these people go.
		if _, err := tx.Exec(ctx, `
			WITH expired AS (
				DELETE FROM message_request_reminder_log
				WHERE org_id = $1 AND actor_id = ANY($2::uuid[]) AND reminded_at <= $3::timestamptz - interval '24 hours'
			)
			INSERT INTO message_request_reminder_log (org_id, actor_id, reminded_at)
			SELECT $1, recipient, $3 FROM unnest($2::uuid[]) AS recipient`, current.OrgID, sent, now); err != nil {
			return 0, 0, fmt.Errorf("log request reminders: %w", err)
		}
	}
	return len(targets), seq, nil
}

// Snooze asks River to run the job again later: it woke up early.
type Snooze struct{ Delay time.Duration }

func (s Snooze) Error() string { return fmt.Sprintf("request job not due for %s", s.Delay) }

// beginJob opens the transaction of a job: the organization lock first, then
// the request. A request that is gone, or a job that is not the request's
// current one, reports ok false: the job has nothing to do.
func (s *Service) beginJob(ctx context.Context, messageID string) (pgx.Tx, lockedRequest, bool, error) {
	var orgID string
	if err := s.pool.QueryRow(ctx, `SELECT org_id FROM message_requests WHERE message_id = $1`, messageID).Scan(&orgID); errors.Is(err, pgx.ErrNoRows) {
		return nil, lockedRequest{}, false, nil
	} else if err != nil {
		return nil, lockedRequest{}, false, fmt.Errorf("find request of job: %w", err)
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return nil, lockedRequest{}, false, fmt.Errorf("begin request job: %w", err)
	}
	if err := lockOrganization(ctx, tx, orgID); err != nil {
		tx.Rollback(ctx)
		if errors.Is(err, ErrNotFound) {
			return nil, lockedRequest{}, false, nil
		}
		return nil, lockedRequest{}, false, err
	}
	current, err := lockRequest(ctx, tx, orgID, messageID)
	if err != nil {
		tx.Rollback(ctx)
		if errors.Is(err, ErrNotFound) {
			return nil, lockedRequest{}, false, nil
		}
		return nil, lockedRequest{}, false, err
	}
	return tx, current, true, nil
}

// AutoRemind runs the automatic reminder of a request. It does nothing for
// a stale job, a closed request, a deleted message, an archived chat, or an
// author who is no longer an active member; and skips a reminder more than
// AutoRemindMaxLateness late or past the due date. The author always gets
// the outcome, also when everyone has answered.
func (s *Service) AutoRemind(ctx context.Context, messageID string, jobID int64) error {
	tx, current, ok, err := s.beginJob(ctx, messageID)
	if err != nil || !ok {
		return err
	}
	defer tx.Rollback(ctx)
	if current.AutoRemindJobID == nil || *current.AutoRemindJobID != jobID || current.Status != "open" ||
		current.AutoRemindedAt != nil || current.AutoRemindAt == nil {
		return nil
	}
	now := s.Now()
	if now.Before(*current.AutoRemindAt) {
		return Snooze{Delay: current.AutoRemindAt.Sub(now)}
	}
	finish := func() error {
		if _, err := tx.Exec(ctx, `UPDATE message_requests SET auto_reminded_at=$2, auto_remind_job_id=NULL WHERE message_id=$1`, messageID, now); err != nil {
			return fmt.Errorf("record automatic request reminder: %w", err)
		}
		return nil
	}
	skip := current.MessageDeleted || current.ChatArchived ||
		now.Sub(*current.AutoRemindAt) > s.limits.AutoRemindMaxLateness ||
		(current.DueAt != nil && !now.Before(*current.DueAt))
	if !skip {
		var authorPresent bool
		if err := tx.QueryRow(ctx, `SELECT EXISTS (
			SELECT 1 FROM chat_members cm
			JOIN actors a ON a.org_id = cm.org_id AND a.id = cm.actor_id AND a.status = 'active' AND a.deleted_at IS NULL
			WHERE cm.org_id = $1 AND cm.chat_id = $2 AND cm.actor_id = $3)`, current.OrgID, current.ChatID, current.AuthorID).Scan(&authorPresent); err != nil {
			return fmt.Errorf("check request author: %w", err)
		}
		skip = !authorPresent
	}
	if skip {
		if err := finish(); err != nil {
			return err
		}
		return tx.Commit(ctx)
	}
	reminded, _, err := s.remindWaitingTx(ctx, tx, current, "auto", now)
	if err != nil {
		return err
	}
	waiting, err := waitingCount(ctx, tx, current.OrgID, messageID)
	if err != nil {
		return err
	}
	seq, err := nextSequence(ctx, tx, current.OrgID)
	if err != nil {
		return err
	}
	author := current.AuthorID
	if err := insertEvent(ctx, tx, current.OrgID, seq, "request.auto_reminded", current.AuthorID, current.ChatID, messageID, &author, autoRemindedEvent{
		MessageID: messageID, ChatID: current.ChatID, Reminded: reminded, AnsweredCount: current.AnsweredCount, WaitingCount: waiting,
	}); err != nil {
		return err
	}
	if err := finish(); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("commit automatic request reminder: %w", err)
	}
	s.notify(current.OrgID, seq)
	return nil
}

// Expire closes a request that outlived its time: 14 days after the due
// date, or without one 30 days after the last answer or creation. A job
// that wakes up early (an answer moved the time) snoozes until then.
func (s *Service) Expire(ctx context.Context, messageID string, jobID int64) error {
	tx, current, ok, err := s.beginJob(ctx, messageID)
	if err != nil || !ok {
		return err
	}
	defer tx.Rollback(ctx)
	if current.ExpireJobID == nil || *current.ExpireJobID != jobID || current.Status != "open" {
		return nil
	}
	now := s.Now()
	if now.Before(current.ExpireAt) {
		return Snooze{Delay: current.ExpireAt.Sub(now)}
	}
	if err := tx.QueryRow(ctx, `
		UPDATE message_requests SET status='closed', closed_reason='expired', closed_at=$2, version=version+1,
			auto_remind_job_id=NULL, expire_job_id=NULL
		WHERE message_id=$1 RETURNING version`, messageID, now).Scan(&current.Version); err != nil {
		return fmt.Errorf("expire request: %w", err)
	}
	if err := closeRecipientsTx(ctx, tx, messageID); err != nil {
		return err
	}
	if current.AutoRemindJobID != nil && s.jobs != nil {
		if err := s.jobs.CancelTx(ctx, tx, *current.AutoRemindJobID); err != nil {
			return fmt.Errorf("cancel request job: %w", err)
		}
	}
	current.Status, current.ClosedReason = "closed", strPtr("expired")
	seq, err := emitUpdated(ctx, tx, current)
	if err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("commit request expiry: %w", err)
	}
	s.notify(current.OrgID, seq)
	return nil
}
