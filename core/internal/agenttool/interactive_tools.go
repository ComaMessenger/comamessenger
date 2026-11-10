package agenttool

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sort"

	"github.com/comamessenger/comamessenger/core/internal/agent"
	"github.com/comamessenger/comamessenger/core/internal/identity"
	"github.com/comamessenger/comamessenger/core/internal/interactive"
	"github.com/comamessenger/comamessenger/core/internal/message"
)

func blocksSchema(uuidSchema map[string]any) map[string]any {
	text := func(min, max int) map[string]any {
		return map[string]any{"type": "string", "minLength": min, "maxLength": max}
	}
	identifier := map[string]any{"type": "string", "pattern": "^[a-z0-9][a-z0-9_.-]{0,63}$"}
	strict := func(required []string, properties map[string]any) map[string]any {
		result := map[string]any{"type": "object", "additionalProperties": false, "properties": properties}
		if len(required) > 0 {
			result["required"] = required
		}
		return result
	}
	roles := map[string]any{"type": "array", "maxItems": 3, "uniqueItems": true, "items": map[string]any{"type": "string", "enum": []string{"owner", "admin", "member"}}}
	return strict([]string{"version"}, map[string]any{
		"version": map[string]any{"type": "integer", "const": message.BlocksVersion},
		"card": strict([]string{"title"}, map[string]any{
			"title":  text(1, 200),
			"status": strict([]string{"label"}, map[string]any{"label": text(1, 60), "tone": map[string]any{"type": "string", "enum": []string{"neutral", "info", "success", "warning", "danger"}}}),
			"fields": map[string]any{"type": "array", "maxItems": 20, "items": strict([]string{"label", "value"}, map[string]any{"label": text(1, 80), "value": text(0, 500)})},
			"items":  map[string]any{"type": "array", "maxItems": 50, "items": strict([]string{"text"}, map[string]any{"text": text(1, 500), "state": map[string]any{"type": "string", "enum": []string{"done", "pending", "failed"}}})},
		}),
		"actions": map[string]any{"type": "array", "maxItems": 10, "items": strict([]string{"id", "label"}, map[string]any{
			"id":     identifier,
			"label":  text(1, 60),
			"style":  map[string]any{"type": "string", "enum": []string{"primary", "secondary", "danger"}},
			"limit":  map[string]any{"type": "string", "enum": []string{"per_actor", "single"}, "description": "per_actor: each allowed person may press once; single: the first press closes the action for everyone."},
			"group":  map[string]any{"type": "string", "pattern": "^[a-z0-9][a-z0-9_.-]{0,63}$", "description": "Actions sharing a group are one choice per person."},
			"closed": map[string]any{"type": "boolean"},
			"allowed": strict(nil, map[string]any{
				"actor_ids":   map[string]any{"type": "array", "maxItems": 100, "uniqueItems": true, "items": uuidSchema},
				"chat_roles":  roles,
				"org_roles":   roles,
				"permissions": map[string]any{"type": "array", "maxItems": 10, "uniqueItems": true, "items": map[string]any{"type": "string"}},
			}),
		})},
		"sources": map[string]any{"type": "array", "maxItems": 20, "items": strict([]string{"kind"}, map[string]any{
			"kind":        map[string]any{"type": "string", "enum": []string{"message", "file", "document"}},
			"message_id":  uuidSchema,
			"file_id":     uuidSchema,
			"document_id": uuidSchema,
			"chunk_id":    map[string]any{"type": "string", "format": "uuid", "description": "chunk_id of the search_knowledge fragment the answer relies on."},
			"position":    map[string]any{"type": "integer", "minimum": 0},
			"title":       text(0, 200),
			"excerpt":     text(0, 500),
		})},
	})
}

func interactiveTools(executor *Executor, object func([]string, map[string]any) map[string]any, uuidSchema map[string]any) []Tool {
	blocks := blocksSchema(uuidSchema)
	bodyFormat := map[string]any{"type": "string", "enum": []string{"plain", "markdown"}}
	timestamp := map[string]any{"type": "string", "format": "date-time"}
	return []Tool{
		{Definition: Definition{Name: "post_card", Description: "Post a card with optional buttons and sources. body is the plain-text fallback; when omitted it is generated from the card. Pressing a button starts a new run of this agent with input.trigger_type=message_action.", Mode: "write", RequiredScope: agent.ScopeMessagesInteractive,
			InputSchema: object([]string{"chat_id", "client_msg_id", "blocks"}, map[string]any{"chat_id": uuidSchema, "client_msg_id": uuidSchema, "thread_root_id": uuidSchema, "body": map[string]any{"type": "string", "maxLength": 65536}, "body_format": bodyFormat, "mentioned_actor_ids": map[string]any{"type": "array", "maxItems": 100, "uniqueItems": true, "items": uuidSchema}, "blocks": blocks})}, Handler: executor.postCard},
		{Definition: Definition{Name: "update_card", Description: "Replace the card of a message this agent posted. Existing button responses are kept for actions with the same id.", Mode: "write", RequiredScope: agent.ScopeMessagesInteractive,
			InputSchema: object([]string{"message_id", "blocks"}, map[string]any{"message_id": uuidSchema, "blocks": blocks, "body": map[string]any{"type": "string", "maxLength": 65536}, "body_format": bodyFormat, "expected_version": map[string]any{"type": "integer", "minimum": 1}})}, Handler: executor.updateCard},
		{Definition: Definition{Name: "get_reactions", Description: "Read reactions on a message and which human chat members have not reacted yet.", Mode: "read", RequiredScope: agent.ScopeMessagesRead,
			InputSchema: object([]string{"message_id"}, map[string]any{"message_id": uuidSchema})}, Handler: executor.getReactions},
		{Definition: Definition{Name: "start_collection", Description: "Wait for chosen people to answer a message by reaction, button or reply. The server counts answers, sends reminders within quiet hours and per-person limits, and starts a run with input.trigger_type=collection when everyone answered or the deadline passed.", Mode: "write", RequiredScope: agent.ScopeMessagesInteractive,
			InputSchema: object([]string{"message_id", "response"}, map[string]any{
				"message_id": uuidSchema, "response": map[string]any{"type": "string", "enum": []string{"reaction", "action", "reply"}},
				"match":                map[string]any{"type": "array", "maxItems": 20, "uniqueItems": true, "items": map[string]any{"type": "string", "minLength": 1, "maxLength": 64}, "description": "Emojis or action ids that count as an answer; empty means any."},
				"expected_actor_ids":   map[string]any{"type": "array", "maxItems": 500, "uniqueItems": true, "items": uuidSchema},
				"expect_all_members":   map[string]any{"type": "boolean", "description": "Wait for every human chat member except the message author."},
				"deadline_at":          timestamp,
				"deadline_in_seconds":  map[string]any{"type": "integer", "minimum": 60, "maximum": 2592000},
				"remind_every_seconds": map[string]any{"type": "integer", "minimum": 300, "maximum": 604800},
				"max_reminders":        map[string]any{"type": "integer", "minimum": 1, "maximum": 5},
				"reminder_channel":     map[string]any{"type": "string", "enum": []string{"thread", "direct"}},
				"reminder_text":        map[string]any{"type": "string", "minLength": 1, "maxLength": 2000},
				"report_chat_id":       uuidSchema,
				"report_in_thread":     map[string]any{"type": "boolean"},
				"note":                 map[string]any{"type": "string", "maxLength": 2000},
			})}, Handler: executor.startCollection},
		{Definition: Definition{Name: "get_collection", Description: "Read a response collection with the server-counted answers and pending people.", Mode: "read", RequiredScope: agent.ScopeMessagesInteractive,
			InputSchema: object([]string{"collection_id"}, map[string]any{"collection_id": uuidSchema})}, Handler: executor.getCollection},
		{Definition: Definition{Name: "schedule_followup", Description: "Schedule this agent to run again later with the given note and context (input.trigger_type=followup). Pausing or deleting the agent cancels it.", Mode: "write", RequiredScope: agent.ScopeFollowupsWrite,
			InputSchema: object(nil, map[string]any{"at": timestamp, "delay_seconds": map[string]any{"type": "integer", "minimum": 60, "maximum": 2592000}, "chat_id": uuidSchema, "thread_root_id": uuidSchema, "note": map[string]any{"type": "string", "maxLength": 2000}, "context": map[string]any{"type": "object"}})}, Handler: executor.scheduleFollowup},
		// send_direct_card is the card form of «writes to people directly»: the
		// same scope, the same send_direct_message confirmation setting, the
		// same per-person limit and quiet hours (see confirmationTarget and
		// the message service direct guard).
		{Definition: Definition{Name: "send_direct_card", Description: "Deliver a card privately to one person in their direct chat with this agent: a personal report, summary or reminder with buttons or sources. It is writing to a person directly: it follows the agent's setting for direct messages (it may wait for a person to approve it), the person's quiet hours and the daily limit of agent messages to one person. The person must share a group chat with this agent. The result has the direct chat_id, usable as report_chat_id of a collection.", Mode: "write", RequiredScope: agent.ScopeMessagesWrite,
			InputSchema: object([]string{"actor_id", "client_msg_id", "blocks"}, map[string]any{"actor_id": uuidSchema, "client_msg_id": uuidSchema, "body": map[string]any{"type": "string", "maxLength": 65536}, "body_format": bodyFormat, "blocks": blocks})}, Handler: executor.sendDirectCard},
		{Definition: Definition{Name: "send_direct_message", Description: "Send a direct message to one person who shares a chat with this agent. Waits for a person to approve it unless the agent version lets it run by itself.", Mode: "write", RequiredScope: agent.ScopeMessagesWrite,
			InputSchema: object([]string{"actor_id", "client_msg_id", "body"}, map[string]any{"actor_id": uuidSchema, "client_msg_id": uuidSchema, "body": map[string]any{"type": "string", "minLength": 1, "maxLength": 65536}, "body_format": bodyFormat})}, Handler: executor.sendDirectMessage},
	}
}

func (executor *Executor) postCard(ctx context.Context, invocation Invocation) (any, error) {
	var input struct {
		ChatID            string          `json:"chat_id"`
		ClientMsgID       string          `json:"client_msg_id"`
		ThreadRootID      *string         `json:"thread_root_id"`
		Body              string          `json:"body"`
		BodyFormat        string          `json:"body_format"`
		MentionedActorIDs []string        `json:"mentioned_actor_ids"`
		Blocks            *message.Blocks `json:"blocks"`
	}
	if err := json.Unmarshal(invocation.Arguments, &input); err != nil {
		return nil, fmt.Errorf("%w: %v", ErrInvalid, err)
	}
	created, _, err := executor.services.Messages.CreateForAgentRun(ctx, invocation.User, input.ChatID, message.CreateInput{
		ClientMsgID: input.ClientMsgID, Body: input.Body, BodyFormat: input.BodyFormat, ThreadRootID: input.ThreadRootID, ReplyToID: input.ThreadRootID,
		MentionedActorIDs: input.MentionedActorIDs, Blocks: input.Blocks,
	}, message.AgentProvenance{RunID: invocation.RunID})
	return created, err
}

func (executor *Executor) updateCard(ctx context.Context, invocation Invocation) (any, error) {
	var input struct {
		MessageID string `json:"message_id"`
		message.UpdateCardInput
	}
	if err := json.Unmarshal(invocation.Arguments, &input); err != nil {
		return nil, fmt.Errorf("%w: %v", ErrInvalid, err)
	}
	return executor.services.Messages.UpdateCardForAgentRun(ctx, invocation.User, input.MessageID, input.UpdateCardInput)
}

func (executor *Executor) sendDirectCard(ctx context.Context, invocation Invocation) (any, error) {
	service, err := executor.interactiveService()
	if err != nil {
		return nil, err
	}
	var input interactive.DirectCardInput
	if err := json.Unmarshal(invocation.Arguments, &input); err != nil {
		return nil, fmt.Errorf("%w: %v", ErrInvalid, err)
	}
	return service.SendDirectCard(ctx, invocation.User, invocation.RunID, input)
}

type reactionGroup struct {
	Emoji    string   `json:"emoji"`
	ActorIDs []string `json:"actor_ids"`
}

func (executor *Executor) getReactions(ctx context.Context, invocation Invocation) (any, error) {
	var input struct {
		MessageID string `json:"message_id"`
	}
	_ = json.Unmarshal(invocation.Arguments, &input)
	target, err := executor.services.Messages.Get(ctx, invocation.User, input.MessageID)
	if err != nil {
		return nil, err
	}
	reactions, err := executor.services.Messages.ListReactions(ctx, invocation.User, input.MessageID)
	if err != nil {
		return nil, err
	}
	groups := map[string]*reactionGroup{}
	reacted := map[string]bool{}
	order := make([]string, 0)
	for _, reaction := range reactions {
		group := groups[reaction.Emoji]
		if group == nil {
			group = &reactionGroup{Emoji: reaction.Emoji, ActorIDs: []string{}}
			groups[reaction.Emoji] = group
			order = append(order, reaction.Emoji)
		}
		group.ActorIDs = append(group.ActorIDs, reaction.ActorID)
		reacted[reaction.ActorID] = true
	}
	result := struct {
		MessageID          string          `json:"message_id"`
		Reactions          []reactionGroup `json:"reactions"`
		ReactedActorIDs    []string        `json:"reacted_actor_ids"`
		NotReactedActorIDs []string        `json:"not_reacted_actor_ids"`
	}{MessageID: target.ID, Reactions: make([]reactionGroup, 0, len(order)), ReactedActorIDs: []string{}, NotReactedActorIDs: []string{}}
	for _, emoji := range order {
		result.Reactions = append(result.Reactions, *groups[emoji])
	}
	for actorID := range reacted {
		result.ReactedActorIDs = append(result.ReactedActorIDs, actorID)
	}
	sort.Strings(result.ReactedActorIDs)
	rows, err := executor.pool.Query(ctx, `SELECT cm.actor_id FROM chat_members cm JOIN actors a ON a.org_id=cm.org_id AND a.id=cm.actor_id
		WHERE cm.org_id=$1 AND cm.chat_id=$2 AND a.type='user' AND a.status='active' AND a.deleted_at IS NULL AND cm.actor_id<>$3
		ORDER BY cm.actor_id LIMIT 1000`, invocation.User.OrgID, target.ChatID, target.ActorID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var actorID string
		if err := rows.Scan(&actorID); err != nil {
			return nil, err
		}
		if !reacted[actorID] {
			result.NotReactedActorIDs = append(result.NotReactedActorIDs, actorID)
		}
	}
	return result, rows.Err()
}

func (executor *Executor) interactiveService() (*interactive.Service, error) {
	if executor.services.Interactive == nil {
		return nil, ErrForbidden
	}
	return executor.services.Interactive, nil
}

func (executor *Executor) startCollection(ctx context.Context, invocation Invocation) (any, error) {
	service, err := executor.interactiveService()
	if err != nil {
		return nil, err
	}
	var input interactive.StartCollectionInput
	if err := json.Unmarshal(invocation.Arguments, &input); err != nil {
		return nil, fmt.Errorf("%w: %v", ErrInvalid, err)
	}
	return service.StartCollection(ctx, invocation.User, invocation.RunID, input)
}

func (executor *Executor) getCollection(ctx context.Context, invocation Invocation) (any, error) {
	service, err := executor.interactiveService()
	if err != nil {
		return nil, err
	}
	var input struct {
		CollectionID string `json:"collection_id"`
	}
	_ = json.Unmarshal(invocation.Arguments, &input)
	return service.GetCollection(ctx, invocation.User, input.CollectionID)
}

func (executor *Executor) scheduleFollowup(ctx context.Context, invocation Invocation) (any, error) {
	service, err := executor.interactiveService()
	if err != nil {
		return nil, err
	}
	var input interactive.ScheduleFollowupInput
	if err := json.Unmarshal(invocation.Arguments, &input); err != nil {
		return nil, fmt.Errorf("%w: %v", ErrInvalid, err)
	}
	return service.ScheduleFollowup(ctx, invocation.User, invocation.RunID, invocation.ToolCallID, input)
}

func (executor *Executor) sendDirectMessage(ctx context.Context, invocation Invocation) (any, error) {
	service, err := executor.interactiveService()
	if err != nil {
		return nil, err
	}
	var input interactive.DirectMessageInput
	if err := json.Unmarshal(invocation.Arguments, &input); err != nil {
		return nil, fmt.Errorf("%w: %v", ErrInvalid, err)
	}
	return service.SendDirectMessage(ctx, invocation.User, invocation.RunID, input)
}

// postConfirmationCard mirrors a new pending confirmation into the run's chat.
// It is best effort: the approvals queue remains authoritative, so a chat
// where the agent cannot post simply gets no card. Everyone in the chat sees
// the card, so it shows argument values only for writes into that same chat
// (see cardArguments); everything else stays in the approvals queue.
func (executor *Executor) postConfirmationCard(ctx context.Context, invocation Invocation, confirmation *Confirmation) {
	var chatID, threadRootID *string
	if err := executor.pool.QueryRow(ctx, `SELECT chat_id, thread_root_id FROM agent_runs WHERE org_id=$1 AND id=$2`, invocation.User.OrgID, invocation.RunID).Scan(&chatID, &threadRootID); err != nil || chatID == nil {
		return
	}
	arguments := executor.cardArguments(ctx, invocation, confirmation.ToolName, *chatID)
	card, err := executor.services.Messages.CreateConfirmationCard(ctx, invocation.User, message.ConfirmationCardInput{
		ChatID: *chatID, ThreadRootID: threadRootID, RunID: invocation.RunID, ConfirmationID: confirmation.ID,
		ToolName: confirmation.ToolName, Arguments: arguments,
	})
	if err != nil {
		return
	}
	if _, err := executor.pool.Exec(ctx, `UPDATE agent_tool_confirmations SET card_message_id=$2 WHERE id=$1`, confirmation.ID, card.ID); err == nil {
		confirmation.CardMessageID = &card.ID
	}
}

func (executor *Executor) resolveConfirmationCard(ctx context.Context, orgID string, confirmation Confirmation, deciderID string) {
	if confirmation.CardMessageID == nil {
		return
	}
	_ = executor.services.Messages.ResolveConfirmationCard(ctx, orgID, *confirmation.CardMessageID, deciderID, confirmation.Status)
}

func (executor *Executor) finishAndResolve(ctx context.Context, current identity.User, confirmation Confirmation, output json.RawMessage, callErr error) (Confirmation, error) {
	finished, err := executor.finishConfirmation(ctx, confirmation, output, callErr)
	if err != nil {
		return finished, err
	}
	executor.resolveConfirmationCard(ctx, current.OrgID, finished, current.ActorID)
	return finished, nil
}

// DecideFromCard implements message.ConfirmationDecider: a press on a
// confirmation card is the same decision as approve/deny in the approvals
// queue, with the same authorization and audit.
func (executor *Executor) DecideFromCard(ctx context.Context, user identity.User, confirmationID string, approve bool) error {
	_, err := executor.DecideConfirmation(ctx, user, confirmationID, approve)
	switch {
	case err == nil:
		return nil
	case errors.Is(err, ErrForbidden):
		return message.ErrForbidden
	case errors.Is(err, ErrConfirmationNotFound), errors.Is(err, ErrConfirmationConflict):
		var status string
		var cardID *string
		if executor.pool.QueryRow(ctx, `SELECT status, card_message_id FROM agent_tool_confirmations WHERE org_id=$1 AND id=$2`, user.OrgID, confirmationID).Scan(&status, &cardID) == nil && cardID != nil {
			if status == "pending" {
				status = "expired"
			}
			_ = executor.services.Messages.ResolveConfirmationCard(ctx, user.OrgID, *cardID, "", status)
		}
		return message.ErrActionClosed
	default:
		return err
	}
}

// cardVisibleArguments lists the tools whose arguments a confirmation card may
// show to the chat, and which of them: the text the agent would post there.
var cardVisibleArguments = map[string][]string{
	"post_message":    {"chat_id", "body", "body_format"},
	"reply_in_thread": {"chat_id", "body", "body_format", "thread_root_id"},
	"post_card":       {"chat_id", "body", "body_format", "blocks"},
}

// cardArguments is what a confirmation card in chatID shows. Only writes
// into that chat show their text; a collection shows its reminder text and
// how many people it would reach, so the person approving sees the reach.
// Memory values, external system arguments, reactions on messages of other
// chats and direct messages never appear on a card.
func (executor *Executor) cardArguments(ctx context.Context, invocation Invocation, toolName, chatID string) json.RawMessage {
	var arguments map[string]any
	if json.Unmarshal(invocation.Arguments, &arguments) != nil {
		return json.RawMessage(`{}`)
	}
	shown := map[string]any{}
	if keys, ok := cardVisibleArguments[toolName]; ok && arguments["chat_id"] == chatID {
		for _, key := range keys {
			if value, exists := arguments[key]; exists {
				shown[key] = value
			}
		}
	}
	if toolName == "start_collection" {
		var messageChat string
		messageID, _ := arguments["message_id"].(string)
		if executor.pool.QueryRow(ctx, `SELECT chat_id::text FROM messages WHERE org_id=$1 AND id=$2`, invocation.User.OrgID, messageID).Scan(&messageChat) == nil && messageChat == chatID {
			if count, err := executor.collectionRecipients(ctx, invocation, arguments); err == nil {
				shown["recipients"] = count
			}
			for _, key := range []string{"reminder_channel", "reminder_text", "max_reminders"} {
				if value, exists := arguments[key]; exists {
					shown[key] = value
				}
			}
		}
	}
	encoded, err := json.Marshal(shown)
	if err != nil {
		return json.RawMessage(`{}`)
	}
	return encoded
}
