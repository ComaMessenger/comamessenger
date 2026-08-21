package agenttool

import (
	"testing"
)

func TestToolDefinitionsCompileAndRejectUnknownFields(t *testing.T) {
	definitions, err := compileDefinitions()
	if err != nil {
		t.Fatal(err)
	}
	if len(definitions) != 10 {
		t.Fatalf("definitions=%d", len(definitions))
	}
	definition := definitions["get_chat_messages"]
	valid := map[string]any{"chat_id": "00000000-0000-7000-8000-000000000001", "limit": 10}
	if err := definition.compiled.Validate(valid); err != nil {
		t.Fatalf("valid arguments rejected: %v", err)
	}
	valid["provider_secret"] = "must-not-pass"
	if err := definition.compiled.Validate(valid); err == nil {
		t.Fatal("schema accepted unknown provider_secret")
	}
	if definitions["post_message"].Mode != "write" || definitions["post_message"].RequiredScope != "messages:write" {
		t.Fatalf("post_message definition=%+v", definitions["post_message"])
	}
}
