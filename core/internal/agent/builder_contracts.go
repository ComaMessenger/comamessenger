package agent

import (
	"context"
	"fmt"
	"sort"
	"strings"

	"github.com/comamessenger/comamessenger/core/internal/identity"
	"github.com/comamessenger/comamessenger/core/internal/permission"
	"github.com/jackc/pgx/v5"
)

// Confirmation modes of a write action.
const (
	ConfirmationAuto    = "auto"
	ConfirmationConfirm = "confirm"
)

// confirmationDefaults lists every built-in write tool whose confirmation the
// agent version decides, with the default for new agents: publishing in the
// agent's own chats, cards and its own memory run by themselves; a direct
// message to a person waits for approval. Writes to external systems (MCP)
// are governed by the binding and default to confirmation as well.
var confirmationDefaults = map[string]string{
	"post_message":        ConfirmationAuto,
	"reply_in_thread":     ConfirmationAuto,
	"add_reaction":        ConfirmationAuto,
	"post_card":           ConfirmationAuto,
	"update_card":         ConfirmationAuto,
	"start_collection":    ConfirmationAuto,
	"schedule_followup":   ConfirmationAuto,
	"remember":            ConfirmationAuto,
	"send_direct_message": ConfirmationConfirm,
}

// legacyConfirmationPolicy is what Core enforced for every agent before
// confirmation became part of the agent version. Version configs published
// before that carry no policy and are restored with it, so a rollback never
// loosens what the old version did.
var legacyConfirmationPolicy = map[string]string{
	"post_message":        ConfirmationConfirm,
	"reply_in_thread":     ConfirmationConfirm,
	"add_reaction":        ConfirmationConfirm,
	"remember":            ConfirmationConfirm,
	"send_direct_message": ConfirmationConfirm,
	"post_card":           ConfirmationAuto,
	"update_card":         ConfirmationAuto,
	"start_collection":    ConfirmationAuto,
	"schedule_followup":   ConfirmationAuto,
}

// ConfirmableTools returns the built-in write tools whose confirmation mode
// an agent version sets, sorted by name.
func ConfirmableTools() []string {
	result := make([]string, 0, len(confirmationDefaults))
	for tool := range confirmationDefaults {
		result = append(result, tool)
	}
	sort.Strings(result)
	return result
}

// DefaultConfirmation is the mode of a tool the stored policy does not name.
func DefaultConfirmation(tool string) string {
	if mode, ok := confirmationDefaults[tool]; ok {
		return mode
	}
	return ConfirmationConfirm
}

// EffectiveConfirmation resolves the mode Core enforces for a built-in write
// tool: the server floor first, then the stored policy, then the default.
func EffectiveConfirmation(policy map[string]string, floor map[string]bool, tool string) string {
	if floor[tool] {
		return ConfirmationConfirm
	}
	if mode, ok := policy[tool]; ok && (mode == ConfirmationAuto || mode == ConfirmationConfirm) {
		return mode
	}
	return DefaultConfirmation(tool)
}

// normalizeConfirmationPolicy validates a partial policy and completes it
// with defaults, so every stored version names every confirmable tool.
func normalizeConfirmationPolicy(input map[string]string) (map[string]string, error) {
	if len(input) > 64 {
		return nil, fmt.Errorf("%w: too many confirmation entries", ErrInvalid)
	}
	result := make(map[string]string, len(confirmationDefaults))
	for tool, mode := range confirmationDefaults {
		result[tool] = mode
	}
	for tool, mode := range input {
		if _, known := confirmationDefaults[tool]; !known {
			return nil, fmt.Errorf("%w: %s has no confirmation setting", ErrInvalid, tool)
		}
		if mode != ConfirmationAuto && mode != ConfirmationConfirm {
			return nil, fmt.Errorf("%w: confirmation must be auto or confirm", ErrInvalid)
		}
		result[tool] = mode
	}
	return result, nil
}

// checkConfirmationFloor rejects an explicit attempt to let a tool run by
// itself when the server requires confirmation for it.
func checkConfirmationFloor(input map[string]string, floor map[string]bool) error {
	for tool, mode := range input {
		if mode == ConfirmationAuto && floor[tool] {
			return fmt.Errorf("%w: %s always waits for confirmation on this server", ErrInvalid, tool)
		}
	}
	return nil
}

func applyConfirmationFloor(policy map[string]string, floor map[string]bool) {
	for tool := range floor {
		if _, known := confirmationDefaults[tool]; known {
			policy[tool] = ConfirmationConfirm
		}
	}
}

// loosenedTools lists the tools that run by themselves in next but waited
// for confirmation in previous; the publish audit records them.
func loosenedTools(previous, next map[string]string) []string {
	result := make([]string, 0)
	for tool, mode := range next {
		if mode == ConfirmationAuto && previous[tool] != ConfirmationAuto {
			result = append(result, tool)
		}
	}
	sort.Strings(result)
	return result
}

// ParseConfirmationFloor reads the operator list of built-in tools that
// always wait for confirmation (AGENT_TOOLS_REQUIRE_CONFIRMATION).
func ParseConfirmationFloor(value string) (map[string]bool, error) {
	result := map[string]bool{}
	for _, part := range strings.Split(value, ",") {
		tool := strings.TrimSpace(part)
		if tool == "" {
			continue
		}
		if _, known := confirmationDefaults[tool]; !known {
			return nil, fmt.Errorf("unknown confirmable agent tool %q", tool)
		}
		result[tool] = true
	}
	return result, nil
}

// Tones an agent version may choose. Empty means no tone instruction.
var tones = map[string]string{
	"":         "",
	"concise":  "Tone: answer briefly and to the point; skip greetings and filler.",
	"friendly": "Tone: be warm and friendly; use plain words and address people kindly.",
	"formal":   "Tone: use a formal, polite business style without slang or emoji.",
}

func validTone(value string) bool {
	_, ok := tones[value]
	return ok
}

// Instructions is the trusted configuration Core hands to the model: the
// task written by the builder plus the explicit lines Core derives from the
// version (tone, chats where the agent only reads or only writes). It is
// returned to builders so the advanced settings show exactly what the model
// receives.
func Instructions(description, tone string, readOnlyChatIDs, writeOnlyChatIDs []string) string {
	parts := make([]string, 0, 4)
	if text := strings.TrimSpace(description); text != "" {
		parts = append(parts, text)
	}
	if line := tones[tone]; line != "" {
		parts = append(parts, line)
	}
	if len(readOnlyChatIDs) > 0 {
		parts = append(parts, "Chats you only read and never post to: "+strings.Join(readOnlyChatIDs, ", ")+".")
	}
	if len(writeOnlyChatIDs) > 0 {
		parts = append(parts, "Chats you only post to and never read: "+strings.Join(writeOnlyChatIDs, ", ")+".")
	}
	return strings.Join(parts, "\n\n")
}

// chatRoles derives the stored restrictions from positive read and write
// lists: chat_ids becomes their union; a chat in only one list is restricted.
func chatRoles(read, write []string) (chatIDs, readOnly, writeOnly []string) {
	inRead := make(map[string]bool, len(read))
	inWrite := make(map[string]bool, len(write))
	for _, value := range read {
		inRead[value] = true
	}
	for _, value := range write {
		inWrite[value] = true
	}
	all := make(map[string]bool, len(read)+len(write))
	for value := range inRead {
		all[value] = true
	}
	for value := range inWrite {
		all[value] = true
	}
	chatIDs, readOnly, writeOnly = []string{}, []string{}, []string{}
	for value := range all {
		chatIDs = append(chatIDs, value)
		if inRead[value] && !inWrite[value] {
			readOnly = append(readOnly, value)
		}
		if inWrite[value] && !inRead[value] {
			writeOnly = append(writeOnly, value)
		}
	}
	sort.Strings(chatIDs)
	sort.Strings(readOnly)
	sort.Strings(writeOnly)
	return chatIDs, readOnly, writeOnly
}

// restrictTo keeps the restricted chats that are still agent chats.
func restrictTo(values, chatIDs []string) []string {
	keep := make(map[string]bool, len(chatIDs))
	for _, value := range chatIDs {
		keep[value] = true
	}
	result := make([]string, 0, len(values))
	for _, value := range values {
		if keep[value] {
			result = append(result, value)
		}
	}
	sort.Strings(result)
	return result
}

// without returns values minus excluded, preserving order.
func without(values, excluded []string) []string {
	skip := make(map[string]bool, len(excluded))
	for _, value := range excluded {
		skip[value] = true
	}
	result := make([]string, 0, len(values))
	for _, value := range values {
		if !skip[value] {
			result = append(result, value)
		}
	}
	return result
}

// checkBuilderReach enforces that a builder binds only what they can see
// themself: every newly added chat must be one they belong to (or they may
// moderate chats), every newly added knowledge collection one they may read.
// Bindings that already exist are left alone; they are checked again when a
// person changes them or runs a check.
func checkBuilderReach(ctx context.Context, tx pgx.Tx, current identity.User, previousChats, chats, previousCollections, collections []string) error {
	addedChats := without(chats, previousChats)
	if len(addedChats) > 0 && !permission.Allows(current.OrgRole, current.Permissions, permission.ChatsModerate) {
		var count int
		if err := tx.QueryRow(ctx, `SELECT count(*) FROM chat_members WHERE org_id=$1 AND actor_id=$2 AND chat_id=ANY($3::uuid[])`, current.OrgID, current.ActorID, addedChats).Scan(&count); err != nil {
			return fmt.Errorf("check builder chats: %w", err)
		}
		if count != len(addedChats) {
			return fmt.Errorf("%w: you can add the agent only to chats you are a member of", ErrForbidden)
		}
	}
	addedCollections := without(collections, previousCollections)
	if len(addedCollections) > 0 && !permission.Allows(current.OrgRole, current.Permissions, permission.KnowledgeManage) {
		var readable int
		if err := tx.QueryRow(ctx, `SELECT count(*) FROM knowledge_collections collection
			WHERE collection.org_id=$1 AND collection.id=ANY($3::uuid[]) AND (collection.access='organization' OR EXISTS(
				SELECT 1 FROM knowledge_collection_chats shared
				JOIN chat_members member ON member.org_id=shared.org_id AND member.chat_id=shared.chat_id AND member.actor_id=$2
				WHERE shared.org_id=collection.org_id AND shared.collection_id=collection.id))`, current.OrgID, current.ActorID, addedCollections).Scan(&readable); err != nil {
			return fmt.Errorf("check builder collections: %w", err)
		}
		if readable != len(addedCollections) {
			return fmt.Errorf("%w: you can bind only knowledge collections you may read", ErrForbidden)
		}
	}
	return nil
}
