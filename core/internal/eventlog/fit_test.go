package eventlog

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/comamessenger/comamessenger/core/internal/wirejson"
)

// Any event whose frame would exceed the limit gets a stub that fits: a
// draft keeps its ids and version, drops its body.
func TestFitShrinksOversizedEventData(t *testing.T) {
	store := &Store{maxFrameBytes: 4096}
	chatID := "01a1caf8-a92e-77b0-8b4d-7478f1260f6f"
	data, _ := json.Marshal(map[string]any{
		"chat_id": chatID, "thread_root_id": nil, "version": 3, "body_format": "plain",
		"body": strings.Repeat("\x01", 4096), "mentions": []string{"a"},
	})
	frame := Frame{Op: "event", Seq: 7, Type: "draft.updated", ActorID: chatID, SubjectID: chatID, Data: data}
	if err := store.fit(&frame); err != nil {
		t.Fatal(err)
	}
	payload, err := wirejson.Marshal(frame)
	if err != nil || len(payload) > 4096 {
		t.Fatalf("fitted frame = %d bytes, %v", len(payload), err)
	}
	var got map[string]any
	if err := json.Unmarshal(frame.Data, &got); err != nil {
		t.Fatal(err)
	}
	if got["truncated"] != true || got["chat_id"] != chatID || got["version"] != float64(3) || got["body"] != nil || got["mentions"] != nil {
		t.Fatalf("stub = %s", frame.Data)
	}

	small := Frame{Op: "event", Seq: 8, Type: "chat.updated", Data: json.RawMessage(`{"name":"<b>"}`)}
	if err := store.fit(&small); err != nil || string(small.Data) != `{"name":"<b>"}` {
		t.Fatalf("small frame changed: %s, %v", small.Data, err)
	}
}
