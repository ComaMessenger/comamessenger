package agenttool

import (
	"testing"
)

func TestToolDefinitionsCompileAndRejectUnknownFields(t *testing.T) {
	tools, order, err := compileTools(&Executor{})
	if err != nil {
		t.Fatal(err)
	}
	if len(tools) != 10 || len(order) != 10 {
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
}
