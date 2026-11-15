package userstate

import (
	"context"
	"time"

	"github.com/comamessenger/comamessenger/core/internal/identity"
	"github.com/comamessenger/comamessenger/core/internal/task"
)

// addTaskCounts adds the person's open tasks — responsible, assignee of an
// open item or candidate of a queue nobody has taken — per chat and in
// total, with the access rule of «Ждут вас»: the message not deleted, the
// chat not archived and the person an active member. Hot are those overdue
// or due within 24 hours.
func (s *Service) addTaskCounts(ctx context.Context, user identity.User, snapshot *UnreadSnapshot) error {
	mine, err := task.MineByChat(ctx, s.pool, user, time.Now().UTC())
	if err != nil {
		return err
	}
	for index := range snapshot.Chats {
		item := &snapshot.Chats[index]
		if counts, ok := mine[item.ChatID]; ok {
			item.TasksMineOpen, item.TasksMineNextDueAt = counts.Count, counts.NextDueAt
		}
	}
	for _, counts := range mine {
		snapshot.TasksMineOpenTotal += counts.Count
		snapshot.TasksMineHotTotal += counts.Hot
	}
	return nil
}
