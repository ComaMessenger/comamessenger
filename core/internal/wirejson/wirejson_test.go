package wirejson

import (
	"encoding/json"
	"testing"
)

func TestMarshalKeepsHTMLCharacters(t *testing.T) {
	payload, err := Marshal(map[string]any{"body": "<a & b>", "raw": json.RawMessage(`{"x":"<>"}`)})
	if err != nil {
		t.Fatal(err)
	}
	if string(payload) != `{"body":"<a & b>","raw":{"x":"<>"}}` {
		t.Fatalf("Marshal() = %s", payload)
	}
}
