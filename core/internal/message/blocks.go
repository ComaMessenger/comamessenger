package message

import (
	"encoding/json"
	"fmt"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/comamessenger/comamessenger/core/internal/identity"
	"github.com/comamessenger/comamessenger/core/internal/permission"
	"github.com/google/uuid"
)

// BlocksVersion is the only structured message schema version this Core
// writes. Clients that do not know a version render the body fallback.
const BlocksVersion = 1

const (
	maxActions       = 10
	maxSources       = 20
	maxCardFields    = 20
	maxCardItems     = 50
	maxAudienceItems = 100
)

var actionIDPattern = regexp.MustCompile(`^[a-z0-9][a-z0-9_.-]{0,63}$`)

// Blocks is the optional structured part of a message. Server-managed state
// (responses, closed flags set by single-use actions, system bindings) lives in
// the same document so durable events carry the current card without a
// second lookup.
type Blocks struct {
	Version int      `json:"version"`
	Card    *Card    `json:"card,omitempty"`
	Actions []Action `json:"actions,omitempty"`
	Sources []Source `json:"sources,omitempty"`
}

type Card struct {
	Title  string      `json:"title"`
	Status *CardStatus `json:"status,omitempty"`
	Fields []CardField `json:"fields,omitempty"`
	Items  []CardItem  `json:"items,omitempty"`
}

type CardStatus struct {
	Label string `json:"label"`
	Tone  string `json:"tone"`
}

type CardField struct {
	Label string `json:"label"`
	Value string `json:"value"`
}

type CardItem struct {
	Text  string `json:"text"`
	State string `json:"state,omitempty"`
}

type Action struct {
	ID        string           `json:"id"`
	Label     string           `json:"label"`
	Style     string           `json:"style"`
	Limit     string           `json:"limit"`
	Group     string           `json:"group,omitempty"`
	Allowed   *ActionAudience  `json:"allowed,omitempty"`
	Closed    bool             `json:"closed"`
	Responses []ActionResponse `json:"responses"`
	Binding   *ActionBinding   `json:"binding,omitempty"`
}

// ActionAudience narrows who may press an action. An absent audience means any
// active human member of the chat. Several lists are alternatives: matching
// any of them is enough.
type ActionAudience struct {
	ActorIDs    []string `json:"actor_ids,omitempty"`
	ChatRoles   []string `json:"chat_roles,omitempty"`
	OrgRoles    []string `json:"org_roles,omitempty"`
	Permissions []string `json:"permissions,omitempty"`
}

type ActionResponse struct {
	ActorID     string    `json:"actor_id"`
	RespondedAt time.Time `json:"responded_at"`
}

// ActionBinding is server-only: it ties a button to a domain command such as
// a tool confirmation. Agents cannot create or change bindings.
type ActionBinding struct {
	Kind           string `json:"kind"`
	ConfirmationID string `json:"confirmation_id,omitempty"`
	Decision       string `json:"decision,omitempty"`
}

type Source struct {
	Kind       string `json:"kind"`
	MessageID  string `json:"message_id,omitempty"`
	ChatID     string `json:"chat_id,omitempty"`
	FileID     string `json:"file_id,omitempty"`
	DocumentID string `json:"document_id,omitempty"`
	Title      string `json:"title,omitempty"`
	Excerpt    string `json:"excerpt,omitempty"`
}

func (blocks *Blocks) action(actionID string) (int, *Action) {
	if blocks == nil {
		return -1, nil
	}
	for index := range blocks.Actions {
		if blocks.Actions[index].ID == actionID {
			return index, &blocks.Actions[index]
		}
	}
	return -1, nil
}

func (blocks *Blocks) hasBindings() bool {
	if blocks == nil {
		return false
	}
	for _, action := range blocks.Actions {
		if action.Binding != nil {
			return true
		}
	}
	return false
}

func clone(blocks *Blocks) *Blocks {
	if blocks == nil {
		return nil
	}
	encoded, _ := json.Marshal(blocks)
	var result Blocks
	_ = json.Unmarshal(encoded, &result)
	return &result
}

func invalid(format string, args ...any) error {
	return fmt.Errorf("%w: "+format, append([]any{ErrInvalid}, args...)...)
}

func checkText(name, value string, required bool, limit int) (string, error) {
	value = strings.TrimSpace(value)
	if !utf8.ValidString(value) {
		return "", invalid("%s must be UTF-8", name)
	}
	if required && value == "" {
		return "", invalid("%s must not be blank", name)
	}
	if utf8.RuneCountInString(value) > limit {
		return "", invalid("%s must be at most %d characters", name, limit)
	}
	return value, nil
}

// normalizeBlocks validates a blocks document. Server-managed state is reset
// unless allowSystem is set; agent input carrying bindings is rejected.
func normalizeBlocks(blocks *Blocks, allowSystem bool) error {
	if blocks == nil {
		return nil
	}
	if blocks.Version != BlocksVersion {
		return invalid("blocks.version must be %d", BlocksVersion)
	}
	if blocks.Card == nil && len(blocks.Actions) == 0 && len(blocks.Sources) == 0 {
		return invalid("blocks must contain a card, actions or sources")
	}
	var err error
	if card := blocks.Card; card != nil {
		if card.Title, err = checkText("card.title", card.Title, true, 200); err != nil {
			return err
		}
		if card.Status != nil {
			if card.Status.Label, err = checkText("card.status.label", card.Status.Label, true, 60); err != nil {
				return err
			}
			if card.Status.Tone == "" {
				card.Status.Tone = "neutral"
			}
			switch card.Status.Tone {
			case "neutral", "info", "success", "warning", "danger":
			default:
				return invalid("card.status.tone is not supported")
			}
		}
		if len(card.Fields) > maxCardFields {
			return invalid("card may contain at most %d fields", maxCardFields)
		}
		for index := range card.Fields {
			if card.Fields[index].Label, err = checkText("card.fields.label", card.Fields[index].Label, true, 80); err != nil {
				return err
			}
			if card.Fields[index].Value, err = checkText("card.fields.value", card.Fields[index].Value, false, 500); err != nil {
				return err
			}
		}
		if len(card.Items) > maxCardItems {
			return invalid("card may contain at most %d items", maxCardItems)
		}
		for index := range card.Items {
			if card.Items[index].Text, err = checkText("card.items.text", card.Items[index].Text, true, 500); err != nil {
				return err
			}
			switch card.Items[index].State {
			case "", "done", "pending", "failed":
			default:
				return invalid("card.items.state is not supported")
			}
		}
	}
	if len(blocks.Actions) > maxActions {
		return invalid("a message may contain at most %d actions", maxActions)
	}
	seen := make(map[string]struct{}, len(blocks.Actions))
	for index := range blocks.Actions {
		action := &blocks.Actions[index]
		if !actionIDPattern.MatchString(action.ID) {
			return invalid("actions.id must match %s", actionIDPattern.String())
		}
		if _, duplicate := seen[action.ID]; duplicate {
			return invalid("actions.id must be unique")
		}
		seen[action.ID] = struct{}{}
		if action.Label, err = checkText("actions.label", action.Label, true, 60); err != nil {
			return err
		}
		if action.Style == "" {
			action.Style = "secondary"
		}
		if action.Style != "primary" && action.Style != "secondary" && action.Style != "danger" {
			return invalid("actions.style must be primary, secondary or danger")
		}
		if action.Limit == "" {
			action.Limit = "per_actor"
		}
		if action.Limit != "per_actor" && action.Limit != "single" {
			return invalid("actions.limit must be per_actor or single")
		}
		if action.Group != "" && !actionIDPattern.MatchString(action.Group) {
			return invalid("actions.group must match %s", actionIDPattern.String())
		}
		if err := normalizeAudience(action.Allowed); err != nil {
			return err
		}
		if !allowSystem {
			if action.Binding != nil {
				return invalid("actions.binding is managed by the server")
			}
			action.Responses = nil
		}
		if action.Responses == nil {
			action.Responses = []ActionResponse{}
		}
	}
	if len(blocks.Sources) > maxSources {
		return invalid("a message may contain at most %d sources", maxSources)
	}
	for index := range blocks.Sources {
		source := &blocks.Sources[index]
		switch source.Kind {
		case "message":
			if uuid.Validate(source.MessageID) != nil || source.FileID != "" || source.DocumentID != "" {
				return invalid("message source requires message_id")
			}
		case "file":
			if uuid.Validate(source.FileID) != nil || source.MessageID != "" || source.DocumentID != "" {
				return invalid("file source requires file_id")
			}
		case "document":
			if uuid.Validate(source.DocumentID) != nil || source.MessageID != "" || source.FileID != "" {
				return invalid("document source requires document_id")
			}
		default:
			return invalid("sources.kind must be message, file or document")
		}
		source.ChatID = ""
		if source.Title, err = checkText("sources.title", source.Title, false, 200); err != nil {
			return err
		}
		if source.Excerpt, err = checkText("sources.excerpt", source.Excerpt, false, 500); err != nil {
			return err
		}
	}
	return nil
}

func normalizeAudience(audience *ActionAudience) error {
	if audience == nil {
		return nil
	}
	if len(audience.ActorIDs)+len(audience.ChatRoles)+len(audience.OrgRoles)+len(audience.Permissions) == 0 {
		return invalid("actions.allowed must list at least one actor, role or permission")
	}
	if len(audience.ActorIDs) > maxAudienceItems {
		return invalid("actions.allowed.actor_ids may contain at most %d actors", maxAudienceItems)
	}
	normalized, err := normalizeActorIDs(audience.ActorIDs)
	if err != nil {
		return invalid("actions.allowed.actor_ids must contain UUIDs")
	}
	audience.ActorIDs = normalized
	for _, roles := range [][]string{audience.ChatRoles, audience.OrgRoles} {
		for _, role := range roles {
			if role != "owner" && role != "admin" && role != "member" {
				return invalid("actions.allowed roles must be owner, admin or member")
			}
		}
	}
	for _, code := range audience.Permissions {
		if !permission.Valid(permission.Code(code)) {
			return invalid("actions.allowed.permissions contains an unknown permission")
		}
	}
	return nil
}

func (audience *ActionAudience) allows(user identity.User, chatRole string) bool {
	if audience == nil {
		return true
	}
	for _, actorID := range audience.ActorIDs {
		if actorID == user.ActorID {
			return true
		}
	}
	for _, role := range audience.ChatRoles {
		if role == chatRole {
			return true
		}
	}
	for _, role := range audience.OrgRoles {
		if role == user.OrgRole {
			return true
		}
	}
	for _, code := range audience.Permissions {
		if permission.Allows(user.OrgRole, user.Permissions, permission.Code(code)) {
			return true
		}
	}
	return false
}

// FallbackText renders a plain-text representation used as the message body
// when an agent does not provide one, so clients without block support still
// show meaningful content.
func FallbackText(blocks *Blocks) string {
	if blocks == nil {
		return ""
	}
	lines := make([]string, 0, 8)
	if card := blocks.Card; card != nil {
		title := card.Title
		if card.Status != nil {
			title += " [" + card.Status.Label + "]"
		}
		lines = append(lines, title)
		for _, field := range card.Fields {
			lines = append(lines, field.Label+": "+field.Value)
		}
		for _, item := range card.Items {
			marker := "•"
			switch item.State {
			case "done":
				marker = "✓"
			case "failed":
				marker = "✗"
			case "pending":
				marker = "…"
			}
			lines = append(lines, marker+" "+item.Text)
		}
	}
	if len(blocks.Actions) > 0 {
		labels := make([]string, 0, len(blocks.Actions))
		for _, action := range blocks.Actions {
			labels = append(labels, "["+action.Label+"]")
		}
		lines = append(lines, strings.Join(labels, " "))
	}
	for _, source := range blocks.Sources {
		label := source.Title
		if label == "" {
			label = source.Kind
		}
		lines = append(lines, "↳ "+label)
	}
	return strings.Join(lines, "\n")
}

func canonicalBlocks(blocks *Blocks) string {
	if blocks == nil {
		return "-"
	}
	encoded, _ := json.Marshal(blocks)
	return string(encoded)
}
