package architect

import (
	"slices"

	"github.com/comamessenger/comamessenger/core/internal/agent"
)

/*
 * Scopes are never chosen by the model. Like the builder
 * (apps/web/src/agents/shared/capabilities.ts), the Architect picks what the
 * agent knows and what it can do in plain terms and the scopes follow from
 * them. Keep both tables in sync.
 */

var sourceScopes = map[string][]agent.Scope{
	"search":  {agent.ScopeSearchRead},
	"files":   {agent.ScopeFilesRead},
	"members": {agent.ScopeMembersRead},
}

var skillScopes = map[string][]agent.Scope{
	"messages":  {agent.ScopeMessagesWrite},
	"reactions": {agent.ScopeReactionsWrite},
	"cards":     {agent.ScopeMessagesInteractive},
	"followups": {agent.ScopeFollowupsWrite},
	"memory":    {agent.ScopeMemoryRead, agent.ScopeMemoryWrite},
}

var knownSources = []string{"search", "files", "members"}
var knownSkills = []string{"messages", "cards", "followups", "reactions", "memory"}

// preservedScopes are not derived by the builder and therefore kept.
var preservedScopes = []agent.Scope{agent.ScopeChatsRead, agent.ScopeRuntimeWorker}

var orderedScopes = []agent.Scope{
	agent.ScopeChatsRead, agent.ScopeMessagesRead, agent.ScopeMessagesWrite, agent.ScopeMessagesInteractive,
	agent.ScopeReactionsWrite, agent.ScopeFilesRead, agent.ScopeSearchRead, agent.ScopeMembersRead,
	agent.ScopeKnowledgeRead, agent.ScopeMemoryRead, agent.ScopeMemoryWrite, agent.ScopeFollowupsWrite,
	agent.ScopeRuntimeExecute, agent.ScopeRuntimeWorker,
}

// capabilitiesOf reads sources and skills back from scopes.
func capabilitiesOf(scopes []agent.Scope) ([]string, []string) {
	has := func(required []agent.Scope) bool {
		for _, scope := range required {
			if !slices.Contains(scopes, scope) {
				return false
			}
		}
		return true
	}
	sources, skills := []string{}, []string{}
	for _, source := range knownSources {
		if has(sourceScopes[source]) {
			sources = append(sources, source)
		}
	}
	for _, skill := range knownSkills {
		if has(skillScopes[skill]) {
			skills = append(skills, skill)
		}
	}
	return sources, skills
}

// scopesFor derives the scopes of a draft. Reading the agent's chats and
// running are always needed by the built-in runtime; knowledge access
// follows the bound collections.
func scopesFor(sources, skills []string, hasKnowledge bool, current []agent.Scope) []agent.Scope {
	result := map[agent.Scope]bool{agent.ScopeMessagesRead: true, agent.ScopeRuntimeExecute: true}
	for _, source := range sources {
		for _, scope := range sourceScopes[source] {
			result[scope] = true
		}
	}
	for _, skill := range skills {
		for _, scope := range skillScopes[skill] {
			result[scope] = true
		}
	}
	if hasKnowledge {
		result[agent.ScopeKnowledgeRead] = true
	}
	for _, scope := range preservedScopes {
		if slices.Contains(current, scope) {
			result[scope] = true
		}
	}
	ordered := make([]agent.Scope, 0, len(result))
	for _, scope := range orderedScopes {
		if result[scope] {
			ordered = append(ordered, scope)
		}
	}
	return ordered
}
