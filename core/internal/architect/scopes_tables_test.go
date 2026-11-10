package architect

import (
	"slices"
	"testing"

	"github.com/comamessenger/comamessenger/core/internal/agent"
)

// TestSpreadsheetsAreDerivedAndKept: the Architect derives tables:read from
// the «tables» source like the builder, keeps it when it edits other parts
// of the draft, and drops it without knowledge collections.
func TestSpreadsheetsAreDerivedAndKept(t *testing.T) {
	derived := scopesFor([]string{"tables"}, nil, true, nil)
	if !slices.Contains(derived, agent.ScopeTablesRead) {
		t.Fatalf("tables source scopes = %v", derived)
	}
	sources, skills := capabilitiesOf(derived)
	kept := scopesFor(sources, append(skills, "cards"), true, derived)
	if !slices.Contains(kept, agent.ScopeTablesRead) {
		t.Fatalf("scopes after an unrelated edit = %v", kept)
	}
	if without := scopesFor([]string{"tables"}, nil, false, nil); slices.Contains(without, agent.ScopeTablesRead) {
		t.Fatalf("tables without knowledge = %v", without)
	}
}
