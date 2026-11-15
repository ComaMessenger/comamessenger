package userstate

import (
	"context"

	"github.com/comamessenger/comamessenger/core/internal/identity"
	"github.com/comamessenger/comamessenger/core/internal/request"
)

// requestRecipient: the message `m` is a request asking the person $2. A
// recipient counts it as a mention (phase 6.4: «Получатель запроса — как
// упомянутый»).
const requestRecipient = `(m.type='request' AND EXISTS (SELECT 1 FROM message_request_recipients rr WHERE rr.message_id=m.id AND rr.actor_id=$2))`

// addRequestCounts adds the requests waiting for the person's answer, per
// chat and in total, with the access rule of «Ждут вас»: open, the message
// not deleted, the chat not archived and the person an active member.
func (s *Service) addRequestCounts(ctx context.Context, user identity.User, snapshot *UnreadSnapshot) error {
	waiting, err := request.WaitingByChat(ctx, s.pool, user)
	if err != nil {
		return err
	}
	for index := range snapshot.Chats {
		item := &snapshot.Chats[index]
		if counts, ok := waiting[item.ChatID]; ok {
			item.RequestsWaiting, item.RequestsNextDueAt = counts.Count, counts.NextDueAt
		}
	}
	for _, counts := range waiting {
		snapshot.RequestsWaitingTotal += counts.Count
	}
	return nil
}
