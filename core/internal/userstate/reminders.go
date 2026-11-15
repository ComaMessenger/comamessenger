package userstate

import (
	"context"

	"github.com/comamessenger/comamessenger/core/internal/identity"
	"github.com/comamessenger/comamessenger/core/internal/reminder"
)

// addReminders fills the counters of personal reminders: the «Важные» badge.
func (s *Service) addReminders(ctx context.Context, user identity.User, snapshot *UnreadSnapshot) error {
	total, err := reminder.FiredTotal(ctx, s.pool, user.OrgID, user.ActorID)
	if err != nil {
		return err
	}
	snapshot.RemindersFiredTotal = total
	return nil
}
