package agenttool

import (
	"testing"

	"github.com/comamessenger/comamessenger/core/internal/agent"
)

func TestToolDefinitionsCompileAndRejectUnknownFields(t *testing.T) {
	tools, order, err := compileTools(&Executor{})
	if err != nil {
		t.Fatal(err)
	}
	if len(tools) != 19 || len(order) != 19 {
		t.Fatalf("tools=%d order=%d", len(tools), len(order))
	}
	definition := tools["get_chat_messages"].Definition
	valid := map[string]any{"chat_id": "00000000-0000-7000-8000-000000000001", "limit": 10}
	if err := definition.compiled.Validate(valid); err != nil {
		t.Fatalf("valid arguments rejected: %v", err)
	}
	valid["provider_secret"] = "must-not-pass"
	if err := definition.compiled.Validate(valid); err == nil {
		t.Fatal("schema accepted unknown provider_secret")
	}
	if tools["post_message"].Definition.Mode != "write" || tools["post_message"].Definition.RequiredScope != "messages:write" {
		t.Fatalf("post_message definition=%+v", tools["post_message"].Definition)
	}
	for name, scope := range map[string]string{"post_card": "messages:interactive", "update_card": "messages:interactive", "start_collection": "messages:interactive", "schedule_followup": "followups:write"} {
		definition := tools[name].Definition
		if definition.Mode != "write" || string(definition.RequiredScope) != scope {
			t.Fatalf("%s definition=%+v", name, definition)
		}
	}
	// Every built-in write tool has a confirmation setting in the agent
	// version; read tools never wait for a person.
	confirmable := map[string]bool{}
	for _, name := range agent.ConfirmableTools() {
		confirmable[name] = true
	}
	for name, tool := range tools {
		if (tool.Definition.Mode == "write") != confirmable[name] {
			t.Fatalf("%s mode=%s confirmable=%v", name, tool.Definition.Mode, confirmable[name])
		}
	}
	if agent.DefaultConfirmation("send_direct_message") != agent.ConfirmationConfirm || agent.DefaultConfirmation("post_card") != agent.ConfirmationAuto {
		t.Fatal("unsafe confirmation defaults")
	}
	if search := tools["search_knowledge"].Definition; search.Mode != "read" || search.RequiredScope != "knowledge:read" {
		t.Fatalf("search_knowledge definition=%+v", search)
	}
	if table := tools["query_table"].Definition; table.Mode != "read" || table.RequiredScope != "tables:read" {
		t.Fatalf("query_table definition=%+v", table)
	}
	if err := tools["query_table"].Definition.compiled.Validate(map[string]any{"filters": []any{map[string]any{"column": "Дата", "op": "regex", "value": "."}}}); err == nil {
		t.Fatal("query_table accepted an unknown filter operator")
	}
}
