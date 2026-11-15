package api

import (
	"bytes"
	"encoding/json"
	"fmt"
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

			if strings.HasPrefix(name, "event-") {
				if err := validateEventFixture(compiler, schema, protocolRoot, payload); err != nil {
					t.Fatal(err)
				}
				return
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
	// task.updated: the realtime schema checks the top level, the OpenAPI
	// TaskUpdatedEvent type checks the task inside it.
	"task.updated":  {"TaskUpdatedEvent", func() any { return &TaskUpdatedEvent{} }},
	"task.notified": {"TaskNotifiedEvent", func() any { return &RealtimeTaskNotifiedEventV1{} }},
	// poll.vote.updated is a oneOf: the realtime schema picks the variant,
	// so an anonymous vote with options fails there.
	"poll.updated":             {"PollUpdatedEvent", func() any { return &RealtimePollUpdatedEventV1{} }},
	"poll.vote.updated":        {"PollVoteUpdatedEvent", func() any { return &RealtimePollVoteUpdatedEventV1{} }},
	"poll.notified":            {"PollNotifiedEvent", func() any { return &RealtimePollNotifiedEventV1{} }},
	"actor.away.updated":       {"ActorAwayUpdatedEvent", func() any { return &RealtimeActorAwayUpdatedEventV1{} }},
	"away.substitute.assigned": {"AwaySubstituteAssignedEvent", func() any { return &RealtimeAwaySubstituteAssignedEventV1{} }},
	"away.substitute.removed":  {"AwaySubstituteRemovedEvent", func() any { return &RealtimeAwaySubstituteRemovedEventV1{} }},
}

// validateEventFixture checks one event-*.json frame: the frame against the
// realtime schema, its generated Go type, the typed data and the privacy
// rules of eventPrivacyProblem.
func validateEventFixture(compiler *jsonschema.Compiler, schema *jsonschema.Schema, protocolRoot string, payload []byte) error {
	var document any
	if err := json.Unmarshal(payload, &document); err != nil {
		return fmt.Errorf("decode fixture JSON: %w", err)
	}
	if err := schema.Validate(document); err != nil {
		return fmt.Errorf("validate fixture against JSON Schema: %w", err)
	}
	var frame RealtimeDurableEventFrameV1
	decoder := json.NewDecoder(bytes.NewReader(payload))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&frame); err != nil {
		return fmt.Errorf("decode fixture into generated Go type: %w", err)
	}
	if err := checkTypedEventData(compiler, protocolRoot, &frame); err != nil {
		return err
	}
	if problem := eventPrivacyProblem(&frame); problem != "" {
		return fmt.Errorf("event %s leaks: %s", frame.Type, problem)
	}
	return nil
}

// eventPrivacyProblem catches what the schemas alone allow but a shared frame
// must never carry: per-reader state (request_viewer, poll_viewer), the counts
// of an open poll, and the voter behind poll.updated.
func eventPrivacyProblem(frame *RealtimeDurableEventFrameV1) string {
	for _, field := range []string{"request_viewer", "poll_viewer"} {
		if _, ok := frame.Data[field]; ok {
			return field + " is per reader and never goes into a frame"
		}
	}
	switch {
	case strings.HasPrefix(frame.Type, "message."):
		poll, _ := frame.Data["poll"].(map[string]any)
		if poll != nil && poll["status"] == "open" && poll["final_counts"] != nil {
			return "an open poll carries final_counts"
		}
	case frame.Type == "poll.updated":
		if frame.ActorId != nil {
			return "poll.updated names its actor, which would reveal the voter"
		}
		if frame.Data["status"] == "open" && frame.Data["final_counts"] != nil {
			return "an open poll carries final_counts"
		}
	}
	return ""
}

// checkTypedEventData validates the data of an event-*.json fixture against
// its own definition and decodes it into the generated Go type, so a field
// the contract does not describe (a comment, a note) fails the test.
func checkTypedEventData(compiler *jsonschema.Compiler, protocolRoot string, frame *RealtimeDurableEventFrameV1) error {
	typed, ok := typedEventData[frame.Type]
	if !ok {
		return fmt.Errorf("event fixture of type %s has no typed data mapping", frame.Type)
	}
	payload, err := json.Marshal(frame.Data)
	if err != nil {
		return fmt.Errorf("encode event data: %w", err)
	}
	if typed.definition != "" {
		schema, err := compiler.Compile(filepath.Join(protocolRoot, "schemas", "realtime", "v1.schema.json") + "#/$defs/" + typed.definition)
		if err != nil {
			return fmt.Errorf("compile %s: %w", typed.definition, err)
		}
		var document any
		if err := json.Unmarshal(payload, &document); err != nil {
			return fmt.Errorf("decode event data: %w", err)
		}
		if err := schema.Validate(document); err != nil {
			return fmt.Errorf("validate event data against %s: %w", typed.definition, err)
		}
	}
	decoder := json.NewDecoder(bytes.NewReader(payload))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(typed.target()); err != nil {
		return fmt.Errorf("decode event data into generated Go type: %w", err)
	}
	return nil
}

// TestRealtimeV1RequestAndReminderEventsHaveFixtures keeps a typed fixture
// for every request.*, reminder.*, org.*, task.*, poll.*, actor.away.* and
// away.* event type the protocol knows.
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
		typedPrefix := false
		for _, prefix := range []string{"request.", "reminder.", "org.", "task.", "poll.", "actor.away.", "away."} {
			typedPrefix = typedPrefix || strings.HasPrefix(eventType, prefix)
		}
		if !typedPrefix {
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
