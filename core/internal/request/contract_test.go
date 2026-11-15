package request

import (
	"bytes"
	"encoding/json"
	"testing"
	"time"

	"github.com/comamessenger/comamessenger/core/internal/api"
)

// The server's request payloads decode into the generated contract types
// with no unknown field: a leak of an extra field (a comment, a recipient)
// into an event fails here as well as in the fixture tests.
func TestPayloadsMatchContract(t *testing.T) {
	now := time.Now().UTC()
	reason := "author"
	cases := []struct {
		name  string
		value any
		into  any
	}{
		{"request.assigned", assignedEvent{MessageID: "0198c17d-b55b-78d5-b099-f973dd1f265c", ChatID: "0198c17d-a0ac-71f0-aeef-96228a975b85", DueAt: &now}, &api.RealtimeRequestAssignedEventV1{}},
		{"request.updated", updatedEvent{MessageID: "0198c17d-b55b-78d5-b099-f973dd1f265c", ChatID: "0198c17d-a0ac-71f0-aeef-96228a975b85", Status: "closed", ClosedReason: &reason, AnsweredCount: 1, WaitingCount: 2, Version: 3}, &api.RealtimeRequestUpdatedEventV1{}},
		{"request.tally.updated", tallyEvent{MessageID: "0198c17d-b55b-78d5-b099-f973dd1f265c", ChatID: "0198c17d-a0ac-71f0-aeef-96228a975b85", Tally: []int{1, 0}, WaitingCount: 2, Version: 3}, &api.RealtimeRequestTallyUpdatedEventV1{}},
		{"request.answer.updated", answerEvent{MessageID: "0198c17d-b55b-78d5-b099-f973dd1f265c", ChatID: "0198c17d-a0ac-71f0-aeef-96228a975b85", Option: 1, HasComment: true, Version: 2}, &api.RealtimeRequestAnswerUpdatedEventV1{}},
		{"request.reminded", remindedEvent{MessageID: "0198c17d-b55b-78d5-b099-f973dd1f265c", ChatID: "0198c17d-a0ac-71f0-aeef-96228a975b85", Kind: "auto"}, &api.RealtimeRequestRemindedEventV1{}},
		{"request.auto_reminded", autoRemindedEvent{MessageID: "0198c17d-b55b-78d5-b099-f973dd1f265c", ChatID: "0198c17d-a0ac-71f0-aeef-96228a975b85", Reminded: 2, AnsweredCount: 1, WaitingCount: 2}, &api.RealtimeRequestAutoRemindedEventV1{}},
		{"MessageRequest", Summary{Status: "open", Answer: AnswerSpec{Preset: "custom", Options: []string{"a", "b"}}, Audience: Audience{Kind: "chat"}, Version: 1}, &api.MessageRequest{}},
		{"MessageRequest department", Summary{Status: "open", Answer: AnswerSpec{Preset: "ack"}, Audience: Audience{Kind: "department", Label: "Зал ЛФК", Count: 2, DepartmentID: ptrString("0198c17d-b55b-78d5-b099-f973dd1f265c")}, Version: 1}, &api.MessageRequest{}},
		{"MessageRequest deleted position", Summary{Status: "open", Answer: AnswerSpec{Preset: "ack"}, Audience: Audience{Kind: "position", Label: "Врач", Count: 2}, Version: 1}, &api.MessageRequest{}},
		{"RequestState", State{
			Request: Summary{Status: "open", Answer: AnswerSpec{Preset: "ack"}, Audience: Audience{Kind: "people", Label: "Анна", Count: 1}, Version: 1},
			Viewer:  Viewer{Role: "recipient", Answer: &ViewerAnswer{Option: 0, AnsweredAt: now, Version: 2}, CanAnswer: true},
		}, &api.RequestState{}},
		{"RequestAnswerPage", AnswerPage{Items: []AnswerItem{{ActorID: "0198c17d-b55b-78d5-b099-f973dd1f265c", State: "waiting"}}, Counts: AnswerCounts{Options: []int{0}}}, &api.RequestAnswerPage{}},
		{"RequestRemindResult", RemindResult{Reminded: 1, NextRemindAt: &now}, &api.RequestRemindResult{}},
	}
	for _, c := range cases {
		raw, err := json.Marshal(c.value)
		if err != nil {
			t.Fatal(err)
		}
		decoder := json.NewDecoder(bytes.NewReader(raw))
		decoder.DisallowUnknownFields()
		if err := decoder.Decode(c.into); err != nil {
			t.Errorf("%s does not match the contract: %v\n%s", c.name, err, raw)
		}
	}
}

func ptrString(value string) *string { return &value }
