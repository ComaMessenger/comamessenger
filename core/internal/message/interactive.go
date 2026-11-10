package message

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"time"

	"github.com/comamessenger/comamessenger/core/internal/id"
	"github.com/comamessenger/comamessenger/core/internal/identity"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

var (
	ErrActionClosed   = errors.New("message action is closed")
	ErrActionConflict = errors.New("message action conflicts with an earlier choice")
)

// ActionPress describes a committed button press. Hooks run inside the press
// transaction, so a side effect such as waking the authoring agent is
// committed atomically with the response.
type ActionPress struct {
	ResponseID   string
	OrgID        string
	MessageID    string
	ChatID       string
	ThreadRootID *string
	ActionID     string
	ActorID      string
	AuthorID     string
	RespondedAt  time.Time
	Blocks       *Blocks
}

type ActionHook func(ctx context.Context, tx pgx.Tx, press ActionPress) error

// ConfirmationDecider executes a tool confirmation decision made from a chat
// card. It owns authorization (agents.approve) and updates the card itself.
type ConfirmationDecider interface {
	DecideFromCard(ctx context.Context, user identity.User, confirmationID string, approve bool) error
}

type ActionResult struct {
	Message  Message        `json:"message"`
	ActionID string         `json:"action_id"`
	Response ActionResponse `json:"response"`
	Replayed bool           `json:"replayed"`
}

type UpdateCardInput struct {
	Blocks          *Blocks `json:"blocks"`
	Body            *string `json:"body"`
	BodyFormat      string  `json:"body_format"`
	ExpectedVersion *int    `json:"expected_version"`
}

func (s *Service) SetActionHook(hook ActionHook) { s.actionHook = hook }

func (s *Service) SetConfirmationDecider(decider ConfirmationDecider) { s.decider = decider }

func blocksParam(blocks *Blocks) any {
	if blocks == nil {
		return nil
	}
	encoded, _ := json.Marshal(blocks)
	return string(encoded)
}

func blocksFingerprint(blocks *Blocks) string {
	if blocks == nil {
		return ""
	}
	return "\x00" + canonicalBlocks(blocks)
}

// validateBlockReferences enforces that a card only points at people and
// sources the authoring actor can already see.
func validateBlockReferences(ctx context.Context, tx pgx.Tx, user identity.User, chatID string, blocks *Blocks) error {
	for _, action := range blocks.Actions {
		if action.Allowed != nil && len(action.Allowed.ActorIDs) > 0 {
			if err := validateMentions(ctx, tx, user.OrgID, chatID, action.Allowed.ActorIDs); err != nil {
				return invalid("actions.allowed.actor_ids must be active chat members")
			}
		}
	}
	for _, source := range blocks.Sources {
		var visible bool
		var err error
		switch source.Kind {
		case "message":
			err = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM messages m
				JOIN chat_members cm ON cm.org_id=m.org_id AND cm.chat_id=m.chat_id AND cm.actor_id=$3
				WHERE m.org_id=$1 AND m.id=$2 AND m.deleted_at IS NULL)`, user.OrgID, source.MessageID, user.ActorID).Scan(&visible)
		case "file":
			err = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM files f WHERE f.org_id=$1 AND f.id=$2 AND f.status='ready' AND (f.uploader_id=$3 OR EXISTS(
				SELECT 1 FROM message_files mf JOIN messages m ON m.org_id=mf.org_id AND m.id=mf.message_id AND m.deleted_at IS NULL
				JOIN chat_members cm ON cm.org_id=m.org_id AND cm.chat_id=m.chat_id AND cm.actor_id=$3
				WHERE mf.org_id=f.org_id AND mf.file_id=f.id)))`, user.OrgID, source.FileID, user.ActorID).Scan(&visible)
		default:
			// Knowledge documents are owned by another package; their access is
			// re-checked when a client opens the source.
			visible = true
		}
		if err != nil {
			return fmt.Errorf("validate message source: %w", err)
		}
		if !visible {
			return invalid("sources must reference messages and files visible to the author")
		}
	}
	return nil
}

// Get returns one visible message.
func (s *Service) Get(ctx context.Context, user identity.User, messageID string) (Message, error) {
	if uuid.Validate(messageID) != nil {
		return Message{}, invalid("message_id must be a UUID")
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Message{}, err
	}
	defer tx.Rollback(ctx)
	result, _, _, err := lockMessage(ctx, tx, user, messageID)
	if err != nil {
		return Message{}, err
	}
	items := []Message{result}
	if err := hydrateThreadReplyCounts(ctx, tx, user.OrgID, items); err != nil {
		return Message{}, err
	}
	if err := hydrateFiles(ctx, tx, user.OrgID, items); err != nil {
		return Message{}, err
	}
	return items[0], tx.Commit(ctx)
}

// PressAction records a button press by a human chat member. The same actor
// pressing the same action again replays the original response; the server,
// not the client, decides who may press.
func (s *Service) PressAction(ctx context.Context, user identity.User, messageID, actionID string) (ActionResult, error) {
	if uuid.Validate(messageID) != nil {
		return ActionResult{}, invalid("message_id must be a UUID")
	}
	if !actionIDPattern.MatchString(actionID) {
		return ActionResult{}, ErrNotFound
	}
	result, binding, err := s.pressAction(ctx, user, messageID, actionID)
	if err != nil || binding == nil {
		return result, err
	}
	if s.decider == nil || binding.Kind != "tool_confirmation" {
		return ActionResult{}, ErrActionClosed
	}
	if err := s.decider.DecideFromCard(ctx, user, binding.ConfirmationID, binding.Decision == "approve"); err != nil {
		return ActionResult{}, err
	}
	current, err := s.Get(ctx, user, messageID)
	if err != nil {
		return ActionResult{}, err
	}
	result = ActionResult{Message: current, ActionID: actionID, Response: ActionResponse{ActorID: user.ActorID, RespondedAt: time.Now().UTC()}}
	if _, action := current.Blocks.action(actionID); action != nil {
		for _, response := range action.Responses {
			if response.ActorID == user.ActorID {
				result.Response = response
			}
		}
	}
	return result, nil
}

func (s *Service) pressAction(ctx context.Context, user identity.User, messageID, actionID string) (ActionResult, *ActionBinding, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return ActionResult{}, nil, fmt.Errorf("begin message action: %w", err)
	}
	defer tx.Rollback(ctx)
	if err := lockOrganization(ctx, tx, user.OrgID); err != nil {
		return ActionResult{}, nil, err
	}
	current, _, chatRole, err := lockMessage(ctx, tx, user, messageID)
	if err != nil {
		return ActionResult{}, nil, err
	}
	if current.DeletedAt != nil || current.Blocks == nil {
		return ActionResult{}, nil, ErrNotFound
	}
	var actorType string
	if err := tx.QueryRow(ctx, `SELECT type FROM actors WHERE org_id=$1 AND id=$2`, user.OrgID, user.ActorID).Scan(&actorType); err != nil {
		return ActionResult{}, nil, fmt.Errorf("load pressing actor: %w", err)
	}
	if actorType != "user" {
		return ActionResult{}, nil, ErrForbidden
	}
	index, action := current.Blocks.action(actionID)
	if action == nil {
		return ActionResult{}, nil, ErrNotFound
	}
	var existing ActionResponse
	err = tx.QueryRow(ctx, `SELECT actor_id, created_at FROM message_action_responses WHERE message_id=$1 AND action_id=$2 AND actor_id=$3`,
		messageID, actionID, user.ActorID).Scan(&existing.ActorID, &existing.RespondedAt)
	if err == nil {
		items := []Message{current}
		if err := hydrateFiles(ctx, tx, user.OrgID, items); err != nil {
			return ActionResult{}, nil, err
		}
		return ActionResult{Message: items[0], ActionID: actionID, Response: existing, Replayed: true}, nil, tx.Commit(ctx)
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return ActionResult{}, nil, fmt.Errorf("find message action response: %w", err)
	}
	if !action.Allowed.allows(user, chatRole) {
		return ActionResult{}, nil, ErrForbidden
	}
	if action.Closed || (action.Limit == "single" && len(action.Responses) > 0) {
		return ActionResult{}, nil, ErrActionClosed
	}
	if action.Binding != nil {
		// Domain-bound actions are decided by their owner outside this
		// transaction; the owner rewrites the card when it commits.
		binding := *action.Binding
		return ActionResult{}, &binding, nil
	}
	if action.Group != "" {
		var chosen bool
		if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM message_action_responses WHERE message_id=$1 AND actor_id=$2 AND action_id=ANY($3::text[]))`,
			messageID, user.ActorID, groupSiblings(current.Blocks, action)).Scan(&chosen); err != nil {
			return ActionResult{}, nil, fmt.Errorf("check message action group: %w", err)
		}
		if chosen {
			return ActionResult{}, nil, ErrActionConflict
		}
	}
	responseID, err := id.New()
	if err != nil {
		return ActionResult{}, nil, err
	}
	var response ActionResponse
	if err := tx.QueryRow(ctx, `INSERT INTO message_action_responses(id,org_id,message_id,action_id,actor_id) VALUES($1,$2,$3,$4,$5) RETURNING actor_id, created_at`,
		responseID, user.OrgID, messageID, actionID, user.ActorID).Scan(&response.ActorID, &response.RespondedAt); err != nil {
		return ActionResult{}, nil, fmt.Errorf("record message action response: %w", err)
	}
	blocks := clone(current.Blocks)
	blocks.Actions[index].Responses = append(blocks.Actions[index].Responses, response)
	if blocks.Actions[index].Limit == "single" {
		blocks.Actions[index].Closed = true
	}
	updated, seq, err := s.writeBlocks(ctx, tx, user, current, blocks, nil)
	if err != nil {
		return ActionResult{}, nil, err
	}
	if s.actionHook != nil {
		if err := s.actionHook(ctx, tx, ActionPress{
			ResponseID: responseID, OrgID: user.OrgID, MessageID: messageID, ChatID: current.ChatID, ThreadRootID: current.ThreadRootID,
			ActionID: actionID, ActorID: user.ActorID, AuthorID: current.ActorID, RespondedAt: response.RespondedAt, Blocks: blocks,
		}); err != nil {
			return ActionResult{}, nil, err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return ActionResult{}, nil, fmt.Errorf("commit message action: %w", err)
	}
	s.notifyAfterCommit(user.OrgID, seq)
	return ActionResult{Message: updated, ActionID: actionID, Response: response}, nil, nil
}

func groupSiblings(blocks *Blocks, action *Action) []string {
	result := make([]string, 0, len(blocks.Actions))
	for _, candidate := range blocks.Actions {
		if candidate.Group == action.Group && candidate.ID != action.ID {
			result = append(result, candidate.ID)
		}
	}
	return result
}

// writeBlocks persists a new card projection, bumps the message version and
// appends message.updated, so every client converges through the existing
// message reducer.
func (s *Service) writeBlocks(ctx context.Context, tx pgx.Tx, user identity.User, current Message, blocks *Blocks, body *[2]string) (Message, int64, error) {
	seq, err := nextSequence(ctx, tx, user.OrgID)
	if err != nil {
		return Message{}, 0, err
	}
	newBody, newFormat := current.Body, current.BodyFormat
	if body != nil {
		newBody, newFormat = body[0], body[1]
	}
	var updated Message
	err = scanMessage(tx.QueryRow(ctx, `
		UPDATE messages SET blocks = $3::jsonb, body = $4, body_format = $5, version = version + 1
		WHERE org_id = $1 AND id = $2
		RETURNING id, chat_id, actor_id, client_msg_id, type, body, body_format, reply_to_id,
			thread_root_id, version, created_seq, created_at, edited_at, deleted_at, forwarded_from, mentioned_actor_ids, blocks`,
		user.OrgID, current.ID, blocksParam(blocks), newBody, newFormat), &updated)
	if err != nil {
		return Message{}, 0, fmt.Errorf("update message blocks: %w", err)
	}
	if err := insertEvent(ctx, tx, user, updated.ChatID, updated.ID, seq, "message.updated"); err != nil {
		return Message{}, 0, err
	}
	items := []Message{updated}
	if err := hydrateThreadReplyCounts(ctx, tx, user.OrgID, items); err != nil {
		return Message{}, 0, err
	}
	if err := hydrateFiles(ctx, tx, user.OrgID, items); err != nil {
		return Message{}, 0, err
	}
	return items[0], seq, nil
}

// UpdateCardForAgentRun replaces the card of an agent's own interactive
// message. Responses and single-use closures of actions that keep their id
// are preserved; when body is omitted the fallback text is regenerated.
func (s *Service) UpdateCardForAgentRun(ctx context.Context, user identity.User, messageID string, input UpdateCardInput) (Message, error) {
	if uuid.Validate(messageID) != nil {
		return Message{}, invalid("message_id must be a UUID")
	}
	if input.Blocks == nil {
		return Message{}, invalid("blocks are required")
	}
	if err := normalizeBlocks(input.Blocks, false); err != nil {
		return Message{}, err
	}
	var body *[2]string
	if input.Body != nil {
		value, format := *input.Body, input.BodyFormat
		if err := s.validateBody(&value, &format, false); err != nil {
			return Message{}, err
		}
		body = &[2]string{value, format}
	} else {
		body = &[2]string{FallbackText(input.Blocks), "plain"}
		if len([]byte(body[0])) > s.maxBodyBytes {
			return Message{}, ErrTooLarge
		}
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Message{}, fmt.Errorf("begin update card: %w", err)
	}
	defer tx.Rollback(ctx)
	if err := lockOrganization(ctx, tx, user.OrgID); err != nil {
		return Message{}, err
	}
	current, _, _, err := lockMessage(ctx, tx, user, messageID)
	if err != nil {
		return Message{}, err
	}
	if current.DeletedAt != nil || current.Blocks == nil {
		return Message{}, ErrNotFound
	}
	if current.ActorID != user.ActorID || current.Blocks.hasBindings() {
		return Message{}, ErrForbidden
	}
	if input.ExpectedVersion != nil && *input.ExpectedVersion != current.Version {
		return Message{}, ErrVersionConflict
	}
	for index := range input.Blocks.Actions {
		next := &input.Blocks.Actions[index]
		if _, previous := current.Blocks.action(next.ID); previous != nil {
			next.Responses = previous.Responses
			if previous.Limit == "single" && next.Limit == "single" && len(previous.Responses) > 0 {
				next.Closed = true
			}
		}
		if next.Responses == nil {
			next.Responses = []ActionResponse{}
		}
	}
	if err := validateBlockReferences(ctx, tx, user, current.ChatID, input.Blocks); err != nil {
		return Message{}, err
	}
	updated, seq, err := s.writeBlocks(ctx, tx, user, current, input.Blocks, body)
	if err != nil {
		return Message{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Message{}, fmt.Errorf("commit update card: %w", err)
	}
	s.notifyAfterCommit(user.OrgID, seq)
	return updated, nil
}

// ConfirmationCardInput describes the chat mirror of a pending tool
// confirmation. The card is authored by the agent but its buttons are bound to
// the confirmation and require agents.approve.
type ConfirmationCardInput struct {
	ChatID         string
	ThreadRootID   *string
	RunID          string
	ConfirmationID string
	ToolName       string
	Arguments      json.RawMessage
}

func (s *Service) CreateConfirmationCard(ctx context.Context, agent identity.User, input ConfirmationCardInput) (Message, error) {
	audience := &ActionAudience{Permissions: []string{"agents.approve"}}
	blocks := &Blocks{
		Version: BlocksVersion,
		Card: &Card{
			Title:  input.ToolName,
			Status: &CardStatus{Label: "Approval required", Tone: "warning"},
			Fields: argumentFields(input.Arguments),
		},
		Actions: []Action{
			{ID: "approve", Label: "Approve", Style: "primary", Limit: "single", Group: "decision", Allowed: audience,
				Binding: &ActionBinding{Kind: "tool_confirmation", ConfirmationID: input.ConfirmationID, Decision: "approve"}},
			{ID: "deny", Label: "Deny", Style: "danger", Limit: "single", Group: "decision", Allowed: audience,
				Binding: &ActionBinding{Kind: "tool_confirmation", ConfirmationID: input.ConfirmationID, Decision: "deny"}},
		},
	}
	clientMsgID := uuid.NewSHA1(uuid.NameSpaceOID, []byte("coma/tool-confirmation-card/"+input.ConfirmationID)).String()
	created, _, err := s.CreateForAgentRun(ctx, agent, input.ChatID, CreateInput{
		ClientMsgID: clientMsgID, ThreadRootID: input.ThreadRootID, ReplyToID: input.ThreadRootID, Blocks: blocks, systemBlocks: true,
	}, AgentProvenance{RunID: input.RunID})
	return created, err
}

func argumentFields(arguments json.RawMessage) []CardField {
	var values map[string]any
	if json.Unmarshal(arguments, &values) != nil {
		return nil
	}
	keys := make([]string, 0, len(values))
	for key := range values {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	fields := make([]CardField, 0, len(keys))
	for _, key := range keys {
		if len(fields) == 8 {
			break
		}
		var text string
		switch value := values[key].(type) {
		case string:
			text = value
		default:
			encoded, _ := json.Marshal(value)
			text = string(encoded)
		}
		if runes := []rune(text); len(runes) > 200 {
			text = string(runes[:199]) + "…"
		}
		fields = append(fields, CardField{Label: key, Value: text})
	}
	return fields
}

// ResolveConfirmationCard closes a confirmation card after the decision was
// committed elsewhere (chat card or the approvals queue).
func (s *Service) ResolveConfirmationCard(ctx context.Context, orgID, messageID, deciderID, status string) error {
	presentation, known := map[string][2]string{
		"approved":  {"Approved", "success"},
		"completed": {"Done", "success"},
		"failed":    {"Failed", "danger"},
		"denied":    {"Denied", "danger"},
		"expired":   {"Expired", "neutral"},
	}[status]
	label, tone := presentation[0], presentation[1]
	if !known {
		return invalid("unsupported confirmation status")
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if err := lockOrganization(ctx, tx, orgID); err != nil {
		return err
	}
	var current Message
	if err := scanMessage(tx.QueryRow(ctx, `SELECT id, chat_id, actor_id, client_msg_id, type, body, body_format, reply_to_id,
			thread_root_id, version, created_seq, created_at, edited_at, deleted_at, forwarded_from, mentioned_actor_ids, blocks
		FROM messages WHERE org_id=$1 AND id=$2 FOR UPDATE`, orgID, messageID), &current); errors.Is(err, pgx.ErrNoRows) {
		return nil
	} else if err != nil {
		return err
	}
	if current.DeletedAt != nil || !current.Blocks.hasBindings() {
		return nil
	}
	blocks := clone(current.Blocks)
	if blocks.Card != nil {
		if blocks.Card.Status != nil && blocks.Card.Status.Label == label {
			return nil
		}
		blocks.Card.Status = &CardStatus{Label: label, Tone: tone}
	}
	decision := "approve"
	if status == "denied" {
		decision = "deny"
	}
	now := time.Now().UTC()
	for index := range blocks.Actions {
		action := &blocks.Actions[index]
		if action.Binding == nil || action.Binding.Kind != "tool_confirmation" {
			continue
		}
		action.Closed = true
		if deciderID != "" && status != "expired" && action.Binding.Decision == decision && len(action.Responses) == 0 {
			action.Responses = append(action.Responses, ActionResponse{ActorID: deciderID, RespondedAt: now})
			if _, err := tx.Exec(ctx, `INSERT INTO message_action_responses(id,org_id,message_id,action_id,actor_id)
				SELECT $1,$2,$3,$4,$5 WHERE EXISTS(SELECT 1 FROM actors WHERE org_id=$2 AND id=$5)
				ON CONFLICT (message_id, action_id, actor_id) DO NOTHING`, uuid.NewString(), orgID, messageID, action.ID, deciderID); err != nil {
				return fmt.Errorf("record confirmation card response: %w", err)
			}
		}
	}
	eventActor := deciderID
	if eventActor == "" {
		eventActor = current.ActorID
	}
	body := [2]string{FallbackText(blocks), "plain"}
	_, seq, err := s.writeBlocks(ctx, tx, identity.User{ActorID: eventActor, OrgID: orgID}, current, blocks, &body)
	if err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return err
	}
	s.notifyAfterCommit(orgID, seq)
	return nil
}
