package agenttool

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// ErrChatRole rejects a tool call outside the chat roles of the agent
// version: reading a chat it only writes to, or writing to a chat it only
// reads.
type chatRoleError struct{ code string }

func (err chatRoleError) Error() string     { return "agent tool call violates the chat role: " + err.code }
func (err chatRoleError) ErrorCode() string { return err.code }
func (err chatRoleError) Unwrap() error     { return ErrForbidden }

var (
	errChatWriteOnly = chatRoleError{code: "chat_write_only"}
	errChatReadOnly  = chatRoleError{code: "chat_read_only"}
)

// chatTarget names an argument that points at a chat, directly or through a
// message, and what the tool does there.
type chatTarget struct {
	argument string
	message  bool
	write    bool
	// collection resolves a response collection to its message.
	collection bool
	// own lets the agent read its own message (a check-in card and its
	// reactions) in a chat it only writes to.
	own bool
}

var chatTargets = map[string][]chatTarget{
	"get_chat_messages": {{argument: "chat_id"}},
	"list_members":      {{argument: "chat_id"}},
	"search_messages":   {{argument: "chat_id"}},
	"get_thread":        {{argument: "message_id", message: true}},
	"get_reactions":     {{argument: "message_id", message: true, own: true}},
	"get_collection":    {{argument: "collection_id", collection: true, own: true}},
	"post_message":      {{argument: "chat_id", write: true}},
	"reply_in_thread":   {{argument: "chat_id", write: true}},
	"post_card":         {{argument: "chat_id", write: true}},
	"add_reaction":      {{argument: "message_id", message: true, write: true}},
	"update_card":       {{argument: "message_id", message: true, write: true}},
	"start_collection":  {{argument: "message_id", message: true, write: true}, {argument: "report_chat_id", write: true}},
	"schedule_followup": {{argument: "chat_id", write: true}},
}

// checkChatRoles enforces read-only and write-only chats on every call. A
// target the agent cannot see is left to the tool itself, which answers
// not found or forbidden as before.
func (executor *Executor) checkChatRoles(ctx context.Context, invocation Invocation, definition Definition) error {
	targets := chatTargets[definition.Name]
	if len(targets) == 0 || (len(invocation.readOnlyChats) == 0 && len(invocation.writeOnlyChats) == 0) {
		return nil
	}
	var arguments map[string]any
	if err := json.Unmarshal(invocation.Arguments, &arguments); err != nil {
		return fmt.Errorf("%w: arguments must be a JSON object", ErrInvalid)
	}
	for _, target := range targets {
		value, _ := arguments[target.argument].(string)
		if uuid.Validate(value) != nil {
			continue
		}
		chatID := value
		author := ""
		if target.message || target.collection {
			query := `SELECT chat_id::text,actor_id::text FROM messages WHERE org_id=$1 AND id=$2`
			if target.collection {
				query = `SELECT m.chat_id::text,m.actor_id::text FROM agent_collections c JOIN messages m ON m.org_id=c.org_id AND m.id=c.message_id WHERE c.org_id=$1 AND c.id=$2`
			}
			err := executor.pool.QueryRow(ctx, query, invocation.User.OrgID, value).Scan(&chatID, &author)
			if errors.Is(err, pgx.ErrNoRows) {
				continue
			}
			if err != nil {
				return err
			}
		}
		if target.own && author == invocation.User.ActorID {
			continue
		}
		if target.write && invocation.readOnlyChats[chatID] {
			return errChatReadOnly
		}
		if !target.write && invocation.writeOnlyChats[chatID] {
			return errChatWriteOnly
		}
	}
	return nil
}

func setOf(values []string) map[string]bool {
	result := make(map[string]bool, len(values))
	for _, value := range values {
		result[value] = true
	}
	return result
}
