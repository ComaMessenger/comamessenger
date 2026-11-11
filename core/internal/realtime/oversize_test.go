package realtime

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"

	"github.com/comamessenger/comamessenger/core/internal/message"
)

// A message whose frame would exceed WS_MAX_FRAME_BYTES no longer closes
// every recipient's connection, live or on replay: it arrives as a stub
// (truncated: true) and the full message is loaded by REST. Text of "<"
// is no longer inflated six times by HTML escaping and arrives whole.
func TestRealtimeOversizedMessageArrivesAsStubAndKeepsTheConnection(t *testing.T) {
	harness := newRealtimeHarness(t, realtimeTestConfig())
	connection, _ := harness.connect(t, 0)
	defer connection.CloseNow()
	connection.SetReadLimit(1 << 20)

	angles := strings.Repeat("<", 64*1024)
	// Control characters still take six bytes each: 64 KiB of them is a
	// 384 KiB frame against a 256 KiB limit.
	controls := strings.Repeat("\x01", 64*1024)
	whole := harness.createMessage(t, harness.messages, angles)
	first := readEvent(t, connection, 3*time.Second)
	assertMessageFrame(t, first.Data, whole.ID, angles, false)

	huge := harness.createMessage(t, harness.messages, controls)
	stub := readEvent(t, connection, 3*time.Second)
	if stub.Seq != huge.CreatedSeq || stub.Type != "message.created" {
		t.Fatalf("stub frame = %+v", stub)
	}
	assertMessageFrame(t, stub.Data, huge.ID, "", true)

	after := harness.createMessage(t, harness.messages, "после")
	next := readEvent(t, connection, 3*time.Second)
	assertMessageFrame(t, next.Data, after.ID, "после", false)
	if err := wsjson.Write(context.Background(), connection, ackFrame{Op: "ack", Seq: next.Seq}); err != nil {
		t.Fatal(err)
	}
	_ = connection.Close(websocket.StatusNormalClosure, "offline")

	// Replay from the start: the same three frames, the connection survives.
	replayed, _ := harness.connect(t, 0)
	defer replayed.CloseNow()
	replayed.SetReadLimit(1 << 20)
	for _, want := range []struct {
		id, body  string
		truncated bool
	}{{whole.ID, angles, false}, {huge.ID, "", true}, {after.ID, "после", false}} {
		frame := readEvent(t, replayed, 3*time.Second)
		assertMessageFrame(t, frame.Data, want.id, want.body, want.truncated)
	}

	// The client loads the stubbed message by REST, whole.
	window, err := harness.messages.Context(context.Background(), harness.user, huge.ID, 3)
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, item := range window.Messages {
		if item.ID == huge.ID {
			found = item.Body == controls
		}
	}
	if !found {
		t.Fatal("REST context lacks the full truncated message")
	}
}

func assertMessageFrame(t *testing.T, data json.RawMessage, id, body string, truncated bool) {
	t.Helper()
	var got message.Message
	if err := json.Unmarshal(data, &got); err != nil {
		t.Fatal(err)
	}
	if got.ID != id || got.Body != body || got.Truncated != truncated {
		t.Fatalf("frame message id=%s body=%d bytes truncated=%v, want id=%s body=%d bytes truncated=%v", got.ID, len(got.Body), got.Truncated, id, len(body), truncated)
	}
	if got.Files == nil || got.MentionedActorIDs == nil || got.Version < 1 || got.CreatedSeq < 1 || got.ChatID == "" {
		t.Fatalf("frame lacks the Message shape: %s", truncate(string(data)))
	}
}

func truncate(value string) string {
	if len(value) > 300 {
		return value[:300] + "…"
	}
	return value
}
