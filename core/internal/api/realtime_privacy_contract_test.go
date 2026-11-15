package api

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
	"testing"

	"github.com/santhosh-tekuri/jsonschema/v6"
)

// TestRealtimeV1PollAndAwayLeaksAreRejected takes the valid poll and away
// fixtures, adds what a shared or third-party frame must never carry and
// checks that the contract rejects every such frame: a vote of an anonymous
// poll, the counts of an open poll, the voter behind poll.updated, per-reader
// poll state, the auto-reply text and mute_push of an away status.
func TestRealtimeV1PollAndAwayLeaksAreRejected(t *testing.T) {
	protocolRoot := protocolPackageRoot(t)
	compiler := jsonschema.NewCompiler()
	compiler.AssertFormat()
	schema, err := compiler.Compile(filepath.Join(protocolRoot, "schemas", "realtime", "v1.schema.json"))
	if err != nil {
		t.Fatalf("compile realtime schema: %v", err)
	}

	const someone = "0198c180-3c4d-7e5f-8a6b-7c8d9e0f1a23"
	leaks := []struct {
		name    string
		fixture string
		mutate  func(frame, data map[string]any)
	}{
		{"anonymous vote carries options", "event-poll-vote-updated-anonymous.json", func(_, data map[string]any) {
			data["options"] = []any{1}
		}},
		{"anonymous vote carries an option index", "event-poll-vote-updated-anonymous.json", func(_, data map[string]any) {
			data["option"] = 1
		}},
		{"ordinary vote also carries voted", "event-poll-vote-updated.json", func(_, data map[string]any) {
			data["voted"] = true
		}},
		{"poll.updated names the voter", "event-poll-updated-open.json", func(frame, _ map[string]any) {
			frame["actor_id"] = someone
		}},
		{"poll.updated of an open poll carries final_counts", "event-poll-updated-open.json", func(_, data map[string]any) {
			data["final_counts"] = []any{1, 0, 0}
		}},
		{"poll.updated carries counts", "event-poll-updated-open.json", func(_, data map[string]any) {
			data["counts"] = []any{1, 0, 0}
		}},
		{"poll.updated lists voters", "event-poll-updated-open.json", func(_, data map[string]any) {
			data["voter_ids"] = []any{someone}
		}},
		{"message.created of an open poll carries counts", "event-message-poll.json", func(_, data map[string]any) {
			data["poll"].(map[string]any)["counts"] = []any{1, 0, 0}
		}},
		{"message.created of an open poll carries final_counts", "event-message-poll.json", func(_, data map[string]any) {
			data["poll"].(map[string]any)["final_counts"] = []any{1, 0, 0}
		}},
		{"message.created carries poll_viewer", "event-message-poll.json", func(_, data map[string]any) {
			data["poll_viewer"] = map[string]any{"voted": true, "my_options": []any{0}}
		}},
		{"message.created poll carries voters", "event-message-poll.json", func(_, data map[string]any) {
			data["poll"].(map[string]any)["voters"] = []any{someone}
		}},
		{"poll.notified carries the question", "event-poll-notified.json", func(_, data map[string]any) {
			data["question"] = "Когда удобнее субботник?"
		}},
		{"actor.away.updated carries the auto-reply", "event-actor-away-updated.json", func(_, data map[string]any) {
			data["away"].(map[string]any)["autoreply"] = map[string]any{"enabled": true, "text": "Я в отпуске до 30 ноября"}
		}},
		{"actor.away.updated carries the auto-reply text", "event-actor-away-updated.json", func(_, data map[string]any) {
			data["away"].(map[string]any)["autoreply_text"] = "Я в отпуске до 30 ноября"
		}},
		{"actor.away.updated carries mute_push", "event-actor-away-updated.json", func(_, data map[string]any) {
			data["away"].(map[string]any)["mute_push"] = true
		}},
		{"actor.away.updated carries the auto-reply next to away", "event-actor-away-updated.json", func(_, data map[string]any) {
			data["autoreply_text"] = "Я в отпуске до 30 ноября"
		}},
		{"away.substitute.assigned carries the auto-reply text", "event-away-substitute-assigned.json", func(_, data map[string]any) {
			data["autoreply_text"] = "Я в отпуске до 30 ноября"
		}},
		{"away.substitute.removed carries the away status", "event-away-substitute-removed.json", func(_, data map[string]any) {
			data["away"] = map[string]any{"kind": "vacation"}
		}},
	}
	for _, leak := range leaks {
		t.Run(leak.name, func(t *testing.T) {
			payload, err := os.ReadFile(filepath.Join(protocolRoot, "fixtures", "realtime", "v1", leak.fixture))
			if err != nil {
				t.Fatalf("read fixture: %v", err)
			}
			if err := validateEventFixture(compiler, schema, protocolRoot, payload); err != nil {
				t.Fatalf("the unchanged fixture must pass: %v", err)
			}
			var frame map[string]any
			if err := json.Unmarshal(payload, &frame); err != nil {
				t.Fatalf("decode fixture: %v", err)
			}
			leak.mutate(frame, frame["data"].(map[string]any))
			mutated, err := json.Marshal(frame)
			if err != nil {
				t.Fatalf("encode mutated fixture: %v", err)
			}
			if err := validateEventFixture(compiler, schema, protocolRoot, mutated); err == nil {
				t.Fatal("the contract accepted a leaking frame")
			}
		})
	}
}

// TestRESTPollAndAwayShapesStayPublic pins the fields of the objects every
// reader gets: the shared poll of a message has no counts of an open poll and
// no choice, and the away status other people see has no auto-reply and no
// mute_push. Adding a field here is a privacy decision, not a refactoring.
func TestRESTPollAndAwayShapesStayPublic(t *testing.T) {
	jsonFields := func(value any) []string {
		var names []string
		kind := reflect.TypeOf(value)
		for index := 0; index < kind.NumField(); index++ {
			names = append(names, strings.Split(kind.Field(index).Tag.Get("json"), ",")[0])
		}
		sort.Strings(names)
		return names
	}
	pinned := []struct {
		name  string
		value any
		want  []string
	}{
		{"MessagePoll", MessagePoll{}, []string{"anonymous", "closed_at", "closed_reason", "due_at", "final_counts", "member_count", "multiple", "options", "question", "status", "version", "voter_count"}},
		{"AwayPublic", AwayPublic{}, []string{"active", "ends_at", "kind", "label", "notifications_off", "starts_at", "substitute_id"}},
	}
	for _, item := range pinned {
		if got := jsonFields(item.value); !reflect.DeepEqual(got, item.want) {
			t.Errorf("%s fields = %v, want %v", item.name, got, item.want)
		}
	}
	public := reflect.TypeOf(&AwayPublic{})
	for _, owner := range []any{User{}, ActorSummary{}, ChatMember{}, OrganizationMember{}} {
		field, ok := reflect.TypeOf(owner).FieldByName("Away")
		if !ok || field.Type != public {
			t.Errorf("%T.Away must be *AwayPublic, got %v", owner, field.Type)
		}
	}
	if field, _ := reflect.TypeOf(SubstitutingEntry{}).FieldByName("Away"); field.Type != public.Elem() {
		t.Errorf("SubstitutingEntry.Away must be AwayPublic, got %v", field.Type)
	}
}
