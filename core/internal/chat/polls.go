package chat

import (
	"context"

	"github.com/comamessenger/comamessenger/core/internal/poll"
	"github.com/jackc/pgx/v5"
)

// pollMembersChanged keeps «N из M» of open polls live (phase 6.7): when a
// person joins or leaves a chat, poll.updated with the new denominator goes
// out before the member event, in the same transaction, so the event of the
// membership change stays the highest sequence of the transaction.
func pollMembersChanged(ctx context.Context, tx pgx.Tx, orgID, chatID, eventType string, data any) error {
	if chatID == "" || (eventType != "member.joined" && eventType != "member.removed") {
		return nil
	}
	fields, ok := data.(map[string]any)
	if !ok {
		return nil
	}
	actorID, ok := fields["actor_id"].(string)
	if !ok || actorID == "" {
		return nil
	}
	_, err := poll.OnMembershipChangedTx(ctx, tx, orgID, chatID, actorID)
	return err
}
