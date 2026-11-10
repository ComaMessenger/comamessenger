package interactive

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/comamessenger/comamessenger/core/internal/agent"
	"github.com/comamessenger/comamessenger/core/internal/message"
	"github.com/jackc/pgx/v5"
)

// ErrDirectNeedsConfirmation rejects an agent write to a person that its
// policy sends to a person for approval first.
var ErrDirectNeedsConfirmation = fmt.Errorf("%w: writing to a person directly needs approval", ErrForbidden)

// gatedRunTriggers are runs whose chat was chosen by an action that already
// went through the «writes to people directly» gate (scheduling a follow-up,
// starting a collection, a decided confirmation) or by the person themself
// (pressing a card button).
var gatedRunTriggers = map[string]bool{"followup": true, "collection": true, "confirmation": true, "message_action": true}

// SetConfirmationFloor installs the operator list of tools that always wait
// for a person (AGENT_TOOLS_REQUIRE_CONFIRMATION); it also binds direct
// writes, which follow the send_direct_message setting.
func (s *Service) SetConfirmationFloor(floor map[string]bool) { s.confirmationFloor = floor }

// guardDirect is the message service's second line for agent writes to a
// direct chat. Every such write is «writing to a person directly», whatever
// tool made it: it needs the agent's send_direct_message policy to be auto
// (or a decided write), and it counts against the per-person limit of all
// agents and quiet hours. The one exception is answering in a direct chat a
// run the person started there themself.
func (s *Service) guardDirect(ctx context.Context, tx pgx.Tx, write message.DirectWrite) error {
	var recipient, timezone string
	err := tx.QueryRow(ctx, `SELECT a.id::text,a.timezone FROM chat_members cm
		JOIN actors a ON a.org_id=cm.org_id AND a.id=cm.actor_id AND a.type='user'
		WHERE cm.org_id=$1 AND cm.chat_id=$2 AND cm.actor_id<>$3 LIMIT 1`, write.OrgID, write.ChatID, write.AgentID).Scan(&recipient, &timezone)
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrForbidden
	}
	if err != nil {
		return err
	}
	var runChat, requestedBy *string
	trigger := ""
	if write.RunID != "" {
		if err := tx.QueryRow(ctx, `SELECT chat_id::text,requested_by::text,COALESCE(input->>'trigger_type','') FROM agent_runs WHERE org_id=$1 AND agent_id=$2 AND id=$3`,
			write.OrgID, write.AgentID, write.RunID).Scan(&runChat, &requestedBy, &trigger); err != nil && !errors.Is(err, pgx.ErrNoRows) {
			return err
		}
	}
	inRunChat := runChat != nil && *runChat == write.ChatID
	if inRunChat && requestedBy != nil && *requestedBy == recipient && !gatedRunTriggers[trigger] {
		return nil
	}
	if !message.ApprovedWrite(ctx) && !(write.Final && inRunChat && gatedRunTriggers[trigger]) {
		var raw []byte
		if err := tx.QueryRow(ctx, `SELECT confirmation_policy FROM agents WHERE org_id=$1 AND actor_id=$2`, write.OrgID, write.AgentID).Scan(&raw); err != nil {
			return err
		}
		policy := map[string]string{}
		_ = json.Unmarshal(raw, &policy)
		if agent.EffectiveConfirmation(policy, s.confirmationFloor, "send_direct_message") != agent.ConfirmationAuto {
			return ErrDirectNeedsConfirmation
		}
	}
	now := s.now().UTC()
	if quiet, _ := s.inQuietHours(now, timezone); quiet {
		return fmt.Errorf("%w: quiet hours of the recipient", ErrLimit)
	}
	var sent int
	if err := tx.QueryRow(ctx, `SELECT count(*) FROM messages m
		JOIN chats c ON c.org_id=m.org_id AND c.id=m.chat_id AND c.kind='direct'
		JOIN chat_members cm ON cm.org_id=c.org_id AND cm.chat_id=c.id AND cm.actor_id=$2
		JOIN agents a ON a.org_id=m.org_id AND a.actor_id=m.actor_id
		WHERE m.org_id=$1 AND m.created_at>now()-interval '24 hours' AND m.deleted_at IS NULL`, write.OrgID, recipient).Scan(&sent); err != nil {
		return err
	}
	if sent >= s.limits.MaxDirectMessagesPerPersonPerDay {
		return fmt.Errorf("%w: daily limit of agent direct messages to this person", ErrLimit)
	}
	return nil
}
