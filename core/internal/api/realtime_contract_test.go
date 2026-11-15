package api

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"testing"

	"github.com/santhosh-tekuri/jsonschema/v6"
)

func TestRealtimeV1FixturesMatchSchemaAndGeneratedTypes(t *testing.T) {
	protocolRoot := protocolPackageRoot(t)
	compiler := jsonschema.NewCompiler()
	compiler.AssertFormat()
	schema, err := compiler.Compile(filepath.Join(protocolRoot, "schemas", "realtime", "v1.schema.json"))
	if err != nil {
		t.Fatalf("compile realtime schema: %v", err)
	}

	fixturePaths, err := filepath.Glob(filepath.Join(protocolRoot, "fixtures", "realtime", "v1", "*.json"))
	if err != nil {
		t.Fatalf("list realtime fixtures: %v", err)
	}
	sort.Strings(fixturePaths)
	if len(fixturePaths) == 0 {
		t.Fatal("no realtime v1 fixtures found")
	}

	for _, fixturePath := range fixturePaths {
		fixturePath := fixturePath
		name := filepath.Base(fixturePath)
		t.Run(name, func(t *testing.T) {
			payload, err := os.ReadFile(fixturePath)
			if err != nil {
				t.Fatalf("read fixture: %v", err)
			}

			var document any
			if err := json.Unmarshal(payload, &document); err != nil {
				t.Fatalf("decode fixture JSON: %v", err)
			}
			if err := schema.Validate(document); err != nil {
				t.Fatalf("validate fixture against JSON Schema: %v", err)
			}

			target := generatedFixtureTarget(t, name)
			decoder := json.NewDecoder(bytes.NewReader(payload))
			decoder.DisallowUnknownFields()
			if err := decoder.Decode(target); err != nil {
				t.Fatalf("decode fixture into generated Go type: %v", err)
			}
			if strings.HasPrefix(name, "event-") {
				checkTypedEventData(t, compiler, protocolRoot, target.(*RealtimeDurableEventFrameV1))
			}
		})
	}
}

// typedEventData maps durable event types with a described payload to the
// realtime schema definition and the generated Go type of their data. An
// empty definition means the payload is described by OpenAPI only.
var typedEventData = map[string]struct {
	definition string
	target     func() any
}{
	"message.created":        {"", func() any { return &Message{} }},
	"request.assigned":       {"RequestAssignedEvent", func() any { return &RealtimeRequestAssignedEventV1{} }},
	"request.updated":        {"RequestUpdatedEvent", func() any { return &RealtimeRequestUpdatedEventV1{} }},
	"request.tally.updated":  {"RequestTallyUpdatedEvent", func() any { return &RealtimeRequestTallyUpdatedEventV1{} }},
	"request.answer.updated": {"RequestAnswerUpdatedEvent", func() any { return &RealtimeRequestAnswerUpdatedEventV1{} }},
	"request.reminded":       {"RequestRemindedEvent", func() any { return &RealtimeRequestRemindedEventV1{} }},
	"request.auto_reminded":  {"RequestAutoRemindedEvent", func() any { return &RealtimeRequestAutoRemindedEventV1{} }},
	"reminder.created":       {"ReminderEvent", func() any { return &RealtimeReminderEventV1{} }},
	"reminder.updated":       {"ReminderEvent", func() any { return &RealtimeReminderEventV1{} }},
	"reminder.deleted":       {"ReminderEvent", func() any { return &RealtimeReminderEventV1{} }},
	"reminder.fired":         {"ReminderFiredEvent", func() any { return &RealtimeReminderFiredEventV1{} }},
	"org.updated":            {"OrgUpdatedEvent", func() any { return &RealtimeOrgUpdatedEventV1{} }},
}

// checkTypedEventData validates the data of an event-*.json fixture against
// its own definition and decodes it into the generated Go type, so a field
// the contract does not describe (a comment, a note) fails the test.
func checkTypedEventData(t *testing.T, compiler *jsonschema.Compiler, protocolRoot string, frame *RealtimeDurableEventFrameV1) {
	t.Helper()
	typed, ok := typedEventData[frame.Type]
	if !ok {
		t.Fatalf("event fixture of type %s has no typed data mapping", frame.Type)
	}
	payload, err := json.Marshal(frame.Data)
	if err != nil {
		t.Fatalf("encode event data: %v", err)
	}
	if typed.definition != "" {
		schema, err := compiler.Compile(filepath.Join(protocolRoot, "schemas", "realtime", "v1.schema.json") + "#/$defs/" + typed.definition)
		if err != nil {
			t.Fatalf("compile %s: %v", typed.definition, err)
		}
		var document any
		if err := json.Unmarshal(payload, &document); err != nil {
			t.Fatalf("decode event data: %v", err)
		}
		if err := schema.Validate(document); err != nil {
			t.Fatalf("validate event data against %s: %v", typed.definition, err)
		}
	}
	decoder := json.NewDecoder(bytes.NewReader(payload))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(typed.target()); err != nil {
		t.Fatalf("decode event data into generated Go type: %v", err)
	}
}

// TestRealtimeV1RequestAndReminderEventsHaveFixtures keeps a typed fixture
// for every request.*, reminder.* and org.* event type the protocol knows.
func TestRealtimeV1RequestAndReminderEventsHaveFixtures(t *testing.T) {
	protocolRoot := protocolPackageRoot(t)
	raw, err := os.ReadFile(filepath.Join(protocolRoot, "schemas", "realtime", "v1.schema.json"))
	if err != nil {
		t.Fatalf("read realtime schema: %v", err)
	}
	var schema struct {
		Defs struct {
			KnownDurableEventType struct {
				Enum []string `json:"enum"`
			} `json:"KnownDurableEventType"`
		} `json:"$defs"`
	}
	if err := json.Unmarshal(raw, &schema); err != nil {
		t.Fatalf("decode realtime schema: %v", err)
	}
	covered := map[string]bool{}
	fixturePaths, err := filepath.Glob(filepath.Join(protocolRoot, "fixtures", "realtime", "v1", "event-*.json"))
	if err != nil {
		t.Fatalf("list event fixtures: %v", err)
	}
	for _, fixturePath := range fixturePaths {
		payload, err := os.ReadFile(fixturePath)
		if err != nil {
			t.Fatalf("read fixture: %v", err)
		}
		var frame struct {
			Type string `json:"type"`
		}
		if err := json.Unmarshal(payload, &frame); err != nil {
			t.Fatalf("decode fixture %s: %v", fixturePath, err)
		}
		covered[frame.Type] = true
	}
	for _, eventType := range schema.Defs.KnownDurableEventType.Enum {
		if !strings.HasPrefix(eventType, "request.") && !strings.HasPrefix(eventType, "reminder.") && !strings.HasPrefix(eventType, "org.") {
			continue
		}
		if _, ok := typedEventData[eventType]; !ok {
			t.Errorf("event %s has no typed data mapping", eventType)
		}
		if !covered[eventType] {
			t.Errorf("event %s has no fixture in fixtures/realtime/v1", eventType)
		}
	}
}

func TestRealtimeV1SchemaRejectsUnknownFields(t *testing.T) {
	compiler := jsonschema.NewCompiler()
	schema, err := compiler.Compile(filepath.Join(protocolPackageRoot(t), "schemas", "realtime", "v1.schema.json"))
	if err != nil {
		t.Fatalf("compile realtime schema: %v", err)
	}

	invalid := map[string]any{
		"op":         "ack",
		"seq":        42,
		"unexpected": true,
	}
	if err := schema.Validate(invalid); err == nil {
		t.Fatal("schema accepted a frame with an unknown field")
	}
}

func generatedFixtureTarget(t *testing.T, name string) any {
	t.Helper()
	switch name {
	case "ack.json":
		return &RealtimeAckFrameV1{}
	case "auth.json":
		return &RealtimeAuthFrameV1{}
	case "event.json":
		return &RealtimeDurableEventFrameV1{}
	case "hello.json":
		return &RealtimeHelloFrameV1{}
	case "resync-required.json":
		return &RealtimeResyncRequiredFrameV1{}
	case "typing.json", "typing-action.json":
		return &RealtimeTypingEventFrameV1{}
	case "presence.json":
		return &RealtimePresenceEventFrameV1{}
	case "presence-snapshot.json":
		return &RealtimePresenceSnapshotFrameV1{}
	default:
		if strings.HasPrefix(name, "event-") {
			return &RealtimeDurableEventFrameV1{}
		}
		t.Fatalf("fixture %s has no generated Go type mapping", name)
		return nil
	}
}

func protocolPackageRoot(t *testing.T) string {
	t.Helper()
	_, filename, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("resolve realtime contract test path")
	}
	return filepath.Clean(filepath.Join(filepath.Dir(filename), "..", "..", "..", "packages", "protocol"))
}
