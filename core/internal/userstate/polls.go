package userstate

import (
	"context"
	"time"

	"github.com/comamessenger/comamessenger/core/internal/identity"
	"github.com/comamessenger/comamessenger/core/internal/poll"
)

// addPollCounts adds the open polls with a due date the person may vote in
// and has not voted in, per chat and in total, with the access rule of «Ждут
// вас»: the message not deleted, the chat not archived and the person an
// active member. Hot are those due within 24 hours: only they count in the
// badge of «Важные» (decision 14 of phase 6.7).
func (s *Service) addPollCounts(ctx context.Context, user identity.User, snapshot *UnreadSnapshot) error {
	waiting, err := poll.WaitingByChat(ctx, s.pool, user, time.Now().UTC())
	if err != nil {
		return err
	}
	for index := range snapshot.Chats {
		item := &snapshot.Chats[index]
		if counts, ok := waiting[item.ChatID]; ok {
			item.PollsWaiting = counts.Count
		}
	}
	for _, counts := range waiting {
		snapshot.PollsWaitingTotal += counts.Count
		snapshot.PollsHotTotal += counts.Hot
	}
	return nil
}
