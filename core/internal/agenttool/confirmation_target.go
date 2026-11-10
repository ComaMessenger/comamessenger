package agenttool

import (
	"context"
	"encoding/json"
	"errors"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// Limits of interactive writes that may run without a person.
const (
	// maxAutoCardMentions bounds the people a card notifies by itself.
	maxAutoCardMentions = 10
	// maxAutoCollectionRecipients bounds the people a collection waits for
	// (and may remind) without approval.
	maxAutoCollectionRecipients = 50
)

// directPolicyTool is the policy setting of «writes to people directly».
const directPolicyTool = "send_direct_message"

// confirmationTarget names the policy setting a write call follows and
// whether it must wait for a person regardless of the setting. The mode
// depends on where and to whom the agent writes, not on the tool name:
//
//   - any write whose chat is a direct chat with a person (a message, a
//     thread reply, a card, a card update, a reaction, a collection with
//     direct reminders or a report there, a follow-up publishing there) is
//     «writes to people directly» — unless it answers in the direct chat of a
//     run that person started there;
//   - a card outside the chat of the run is a write to another chat
//     (post_message);
//   - a card mentioning many people or a collection waiting for many people
//     always waits for approval.
func (executor *Executor) confirmationTarget(ctx context.Context, invocation Invocation, definition Definition) (string, bool, error) {
	if definition.Name == directPolicyTool {
		return directPolicyTool, false, nil
	}
	if definition.Name == "send_direct_card" {
		// The card form of writing to a person directly. Like any write, it
		// answers without the setting only in the direct chat of a run that
		// person started there.
		var target struct {
			ActorID string `json:"actor_id"`
		}
		_ = json.Unmarshal(invocation.Arguments, &target)
		if invocation.runChatID != "" && target.ActorID != "" && target.ActorID == invocation.requestedBy {
			left, right := invocation.User.ActorID, target.ActorID
			if right < left {
				left, right = right, left
			}
			var ownDirect bool
			if err := executor.pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM chats WHERE org_id=$1 AND id::text=$2 AND kind='direct' AND direct_pair_key=$3)`,
				invocation.User.OrgID, invocation.runChatID, left+":"+right).Scan(&ownDirect); err != nil {
				return "", false, err
			}
			if ownDirect {
				return "post_card", false, nil
			}
		}
		return directPolicyTool, false, nil
	}
	var arguments map[string]any
	if err := json.Unmarshal(invocation.Arguments, &arguments); err != nil {
		return "", false, ErrInvalid
	}
	text := func(key string) string {
		value, _ := arguments[key].(string)
		return value
	}
	chats := make([]string, 0, 2)
	addChat := func(chatID string) {
		if uuid.Validate(chatID) == nil {
			chats = append(chats, chatID)
		}
	}
	addMessageChat := func(messageID string) error {
		if uuid.Validate(messageID) != nil {
			return nil
		}
		var chatID string
		err := executor.pool.QueryRow(ctx, `SELECT chat_id::text FROM messages WHERE org_id=$1 AND id=$2`, invocation.User.OrgID, messageID).Scan(&chatID)
		if errors.Is(err, pgx.ErrNoRows) {
			return nil
		}
		if err == nil {
			chats = append(chats, chatID)
		}
		return err
	}
	direct := false
	force := false
	switch definition.Name {
	case "post_message", "reply_in_thread", "schedule_followup":
		addChat(text("chat_id"))
	case "post_card":
		addChat(text("chat_id"))
		if mentions, _ := arguments["mentioned_actor_ids"].([]any); len(mentions) > maxAutoCardMentions {
			force = true
		}
	case "update_card", "add_reaction":
		if err := addMessageChat(text("message_id")); err != nil {
			return "", false, err
		}
	case "start_collection":
		if err := addMessageChat(text("message_id")); err != nil {
			return "", false, err
		}
		addChat(text("report_chat_id"))
		if text("reminder_channel") == "direct" {
			direct = true
		}
		count, err := executor.collectionRecipients(ctx, invocation, arguments)
		if err != nil {
			return "", false, err
		}
		if count > maxAutoCollectionRecipients {
			force = true
		}
	}
	for _, chatID := range chats {
		var kind string
		var personStarted bool
		err := executor.pool.QueryRow(ctx, `SELECT c.kind, $3<>'' AND c.id::text=$3 AND EXISTS(
				SELECT 1 FROM chat_members cm WHERE cm.org_id=c.org_id AND cm.chat_id=c.id AND cm.actor_id::text=$4)
			FROM chats c WHERE c.org_id=$1 AND c.id=$2`, invocation.User.OrgID, chatID, invocation.runChatID, invocation.requestedBy).Scan(&kind, &personStarted)
		if errors.Is(err, pgx.ErrNoRows) {
			continue
		}
		if err != nil {
			return "", false, err
		}
		if kind == "direct" && !(personStarted && invocation.requestedBy != "" && invocation.requestedBy != invocation.User.ActorID) {
			direct = true
		}
	}
	if direct {
		return directPolicyTool, force, nil
	}
	if definition.Name == "post_card" && (invocation.runChatID == "" || text("chat_id") != invocation.runChatID) {
		return "post_message", force, nil
	}
	return definition.Name, force, nil
}

// collectionRecipients counts the people a collection would wait for.
func (executor *Executor) collectionRecipients(ctx context.Context, invocation Invocation, arguments map[string]any) (int, error) {
	if expected, _ := arguments["expected_actor_ids"].([]any); len(expected) > 0 {
		return len(expected), nil
	}
	if all, _ := arguments["expect_all_members"].(bool); !all {
		return 0, nil
	}
	messageID, _ := arguments["message_id"].(string)
	if uuid.Validate(messageID) != nil {
		return 0, nil
	}
	var count int
	err := executor.pool.QueryRow(ctx, `SELECT count(*) FROM messages m
		JOIN chat_members cm ON cm.org_id=m.org_id AND cm.chat_id=m.chat_id AND cm.actor_id<>m.actor_id
		JOIN actors a ON a.org_id=cm.org_id AND a.id=cm.actor_id AND a.type='user' AND a.status='active' AND a.deleted_at IS NULL
		WHERE m.org_id=$1 AND m.id=$2`, invocation.User.OrgID, messageID).Scan(&count)
	return count, err
}
