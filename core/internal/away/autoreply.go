package away

import (
	"context"
	"errors"
	"fmt"

	"github.com/comamessenger/comamessenger/core/internal/identity"
	"github.com/jackc/pgx/v5"
)

// AutoreplyArgs carries only ids: the job reads the text, and whether an
// auto-reply is still due at all, from the locked rows when it runs.
type AutoreplyArgs struct {
	OrgID  string `json:"org_id"`
	AwayID string `json:"away_id"`
	ChatID string `json:"chat_id"`
	PeerID string `json:"peer_id"`
}

func (AutoreplyArgs) Kind() string { return "away.autoreply" }

// dueAutoreply finds, for a message `sender` wrote in the direct chat, the
// other member's active status with an auto-reply this sender has not got
// yet in the period. Both members must be active people; the chat must be
// live. With lock it share-locks the status row.
const dueAutoreply = `
	SELECT aw.id, aw.actor_id, aw.autoreply_text, owner.org_role
	FROM chats c
	JOIN chat_members cm ON cm.org_id = c.org_id AND cm.chat_id = c.id AND cm.actor_id <> $3
	JOIN chat_members sm ON sm.org_id = c.org_id AND sm.chat_id = c.id AND sm.actor_id = $3
	JOIN actors owner ON owner.org_id = cm.org_id AND owner.id = cm.actor_id
		AND owner.type = 'user' AND owner.status = 'active' AND owner.deleted_at IS NULL
	JOIN actors sender ON sender.org_id = sm.org_id AND sender.id = sm.actor_id
		AND sender.type = 'user' AND sender.status = 'active' AND sender.deleted_at IS NULL
	JOIN actor_away aw ON aw.org_id = cm.org_id AND aw.actor_id = cm.actor_id
		AND aw.autoreply_enabled AND aw.autoreply_text <> '' AND aw.starts_at <= now() AND aw.ends_at > now()
	WHERE c.org_id = $1 AND c.id = $2 AND c.kind = 'direct' AND c.archived_at IS NULL
	  AND NOT EXISTS (SELECT 1 FROM actor_away_autoreplies r WHERE r.away_id = aw.id AND r.peer_id = $3)`

// OnDirectMessageTx is message.AwayHook: inside the transaction of a
// person's new message in a direct chat it schedules the auto-reply of the
// other member if one is due. Nothing is written but the job.
func (s *Service) OnDirectMessageTx(ctx context.Context, tx pgx.Tx, sender identity.User, chatID, _ string) error {
	if s.scheduler == nil {
		return nil
	}
	var awayID, ownerID, text, role string
	err := tx.QueryRow(ctx, dueAutoreply+` LIMIT 1`, sender.OrgID, chatID, sender.ActorID).Scan(&awayID, &ownerID, &text, &role)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("find due auto-reply: %w", err)
	}
	if err := s.scheduler.ScheduleAutoreplyTx(ctx, tx, AutoreplyArgs{OrgID: sender.OrgID, AwayID: awayID, ChatID: chatID, PeerID: sender.ActorID}); err != nil {
		return fmt.Errorf("schedule auto-reply: %w", err)
	}
	return nil
}

// SendAutoreply is the job away.autoreply. Under the organization lock and
// a share lock of the status it checks every condition again (the status is
// this period and still active with an auto-reply, the chat is a live
// direct chat of the two active people, the peer has not got one, the
// owner's daily limit), then marks the peer and writes the owner's message
// in one transaction. Two jobs for the same peer make one auto-reply: the
// mark is the primary key (away_id, peer_id).
func (s *Service) SendAutoreply(ctx context.Context, args AutoreplyArgs) error {
	if s.messages == nil {
		return errors.New("away service has no message service")
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("begin auto-reply: %w", err)
	}
	defer tx.Rollback(ctx)
	if err := lockOrganization(ctx, tx, args.OrgID); err != nil {
		return err
	}
	var awayID, ownerID, text, role string
	err = tx.QueryRow(ctx, dueAutoreply+` AND aw.id = $4 FOR SHARE OF aw`, args.OrgID, args.ChatID, args.PeerID, args.AwayID).
		Scan(&awayID, &ownerID, &text, &role)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("check auto-reply: %w", err)
	}
	var sentToday int
	if err := tx.QueryRow(ctx, `SELECT count(*) FROM messages WHERE org_id = $1 AND actor_id = $2 AND auto_reply AND created_at > now() - interval '24 hours'`,
		args.OrgID, ownerID).Scan(&sentToday); err != nil {
		return fmt.Errorf("count auto-replies: %w", err)
	}
	if sentToday >= DailyAutoreplyLimit {
		s.logger.Info("auto-reply skipped: daily limit", "org_id", args.OrgID, "actor_id", ownerID)
		return nil
	}
	var marked bool
	if err := tx.QueryRow(ctx, `
		INSERT INTO actor_away_autoreplies (org_id, away_id, peer_id) VALUES ($1, $2, $3)
		ON CONFLICT DO NOTHING RETURNING true`, args.OrgID, awayID, args.PeerID).Scan(&marked); errors.Is(err, pgx.ErrNoRows) {
		return nil
	} else if err != nil {
		return fmt.Errorf("mark auto-reply: %w", err)
	}
	owner := identity.User{ActorID: ownerID, OrgID: args.OrgID, OrgRole: role, Status: "active"}
	result, high, err := s.messages.CreateAutoReplyTx(ctx, tx, owner, args.ChatID, text)
	if err != nil {
		return fmt.Errorf("write auto-reply: %w", err)
	}
	if _, err := tx.Exec(ctx, `UPDATE actor_away_autoreplies SET message_id = $3 WHERE away_id = $1 AND peer_id = $2`,
		awayID, args.PeerID, result.ID); err != nil {
		return fmt.Errorf("link auto-reply: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("commit auto-reply: %w", err)
	}
	s.notify(args.OrgID, high)
	return nil
}
