package task

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"slices"
	"testing"
	"time"

	"github.com/comamessenger/comamessenger/core/internal/api"
)

// The shared examples of decision 5 (packages/core/src/fixtures/
// taskPermissions.json) give the same answers here as in the clients.
func TestPermissionsMatchSharedExamples(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("..", "..", "..", "packages", "core", "src", "fixtures", "taskPermissions.json"))
	if err != nil {
		t.Fatal(err)
	}
	var fixture struct {
		Cases []struct {
			Name     string `json:"name"`
			AuthorID string `json:"author_id"`
			Viewer   struct {
				ActorID   string  `json:"actor_id"`
				ChatRole  *string `json:"chat_role"`
				Moderator bool    `json:"moderator"`
			} `json:"viewer"`
			Task struct {
				Status   string `json:"status"`
				Assignee struct {
					Kind         string   `json:"kind"`
					ActorID      *string  `json:"actor_id"`
					CandidateIDs []string `json:"candidate_ids"`
				} `json:"assignee"`
				Items []struct {
					ID         string  `json:"id"`
					AssigneeID *string `json:"assignee_id"`
				} `json:"items"`
				NudgeCount int `json:"nudge_count"`
			} `json:"task"`
			Expect struct {
				Edit        bool     `json:"edit"`
				Reassign    bool     `json:"reassign"`
				Start       bool     `json:"start"`
				Stop        bool     `json:"stop"`
				Complete    bool     `json:"complete"`
				Reopen      bool     `json:"reopen"`
				Cancel      bool     `json:"cancel"`
				Restore     bool     `json:"restore"`
				ManageItems bool     `json:"manage_items"`
				CheckItems  []string `json:"check_items"`
				Nudge       bool     `json:"nudge"`
				Take        bool     `json:"take"`
			} `json:"expect"`
		} `json:"cases"`
	}
	if err := json.Unmarshal(raw, &fixture); err != nil {
		t.Fatal(err)
	}
	if len(fixture.Cases) < 20 {
		t.Fatalf("only %d shared examples", len(fixture.Cases))
	}
	for _, c := range fixture.Cases {
		item := &Task{Status: c.Task.Status, NudgeCount: c.Task.NudgeCount, Assignee: Assignee{
			Kind: c.Task.Assignee.Kind, ActorID: c.Task.Assignee.ActorID, CandidateIDs: c.Task.Assignee.CandidateIDs,
		}}
		for _, entry := range c.Task.Items {
			item.Items = append(item.Items, Item{ID: entry.ID, AssigneeID: entry.AssigneeID})
		}
		viewer := Viewer{ActorID: c.Viewer.ActorID, Moderator: c.Viewer.Moderator}
		if c.Viewer.ChatRole != nil {
			viewer.Member, viewer.ChatRole = true, *c.Viewer.ChatRole
		}
		got := PermissionsOf(item, c.AuthorID, viewer, DefaultLimits())
		want := Permissions{
			Edit: c.Expect.Edit, Reassign: c.Expect.Reassign, Start: c.Expect.Start, Stop: c.Expect.Stop,
			Complete: c.Expect.Complete, Reopen: c.Expect.Reopen, Cancel: c.Expect.Cancel, Restore: c.Expect.Restore,
			ManageItems: c.Expect.ManageItems, CheckItems: c.Expect.CheckItems, Nudge: c.Expect.Nudge, Take: c.Expect.Take,
		}
		if want.CheckItems == nil {
			want.CheckItems = []string{}
		}
		slices.Sort(got.CheckItems)
		slices.Sort(want.CheckItems)
		gotJSON, _ := json.Marshal(got)
		wantJSON, _ := json.Marshal(want)
		if !bytes.Equal(gotJSON, wantJSON) {
			t.Errorf("%s:\n got %s\nwant %s", c.Name, gotJSON, wantJSON)
		}
	}
}

func TestTransitions(t *testing.T) {
	allowed := map[[2]string]bool{
		{StatusOpen, StatusInProgress}: true, {StatusInProgress, StatusOpen}: true,
		{StatusOpen, StatusDone}: true, {StatusInProgress, StatusDone}: true,
		{StatusDone, StatusOpen}: true,
		{StatusOpen, StatusCanceled}: true, {StatusInProgress, StatusCanceled}: true,
		{StatusCanceled, StatusOpen}: true,
	}
	statuses := []string{StatusOpen, StatusInProgress, StatusDone, StatusCanceled}
	for _, from := range statuses {
		for _, to := range statuses {
			if got := TransitionAllowed(from, to); got != allowed[[2]string{from, to}] {
				t.Errorf("%s → %s = %v", from, to, got)
			}
		}
	}
}

// The server's task payloads decode into the generated contract types with
// no unknown field.
func TestPayloadsMatchContract(t *testing.T) {
	now := time.Now().UTC()
	actor, chat, message := "0198c17d-b55b-78d5-b099-f973dd1f265c", "0198c17d-a0ac-71f0-aeef-96228a975b85", "0198c17d-a0ac-71f0-aeef-96228a975b86"
	department := "0198c17d-a0ac-71f0-aeef-96228a975b87"
	person := &Task{Title: "Купить", Status: "open", Assignee: Assignee{Kind: "person", ActorID: &actor, CandidateIDs: []string{}, InChat: true},
		Items: []Item{{ID: actor, Text: "Пункт", AssigneeID: &actor, AssigneeInChat: true}}, Version: 1,
		Source: &Source{MessageID: message, AuthorID: actor, Excerpt: "Текст"}}
	queue := &Task{Title: "Отделу", Status: "in_progress", Assignee: Assignee{Kind: "department", Label: "Кухня", CandidateIDs: []string{actor},
		DepartmentID: OptionalID{Set: true, Value: &department}}, Items: []Item{}, DueAt: &now, RemindBeforeDue: true, Version: 3}
	reason := "author"
	closed := &Task{Title: "Отменена", Status: "canceled", CanceledReason: &reason, StatusChangedAt: &now, StatusChangedBy: &actor,
		Assignee: Assignee{Kind: "position", Label: "Повар", PositionID: OptionalID{Set: true}}, Items: []Item{}, Version: 4}
	cases := []struct {
		name  string
		value any
		into  any
	}{
		{"MessageTask person", person, &api.MessageTask{}},
		{"MessageTask queue", queue, &api.MessageTask{}},
		{"MessageTask closed", closed, &api.MessageTask{}},
		{"TaskUpdatedEvent", map[string]any{"message_id": message, "chat_id": chat, "task": queue}, &api.TaskUpdatedEvent{}},
		{"task.notified", notifiedEvent{MessageID: message, ChatID: chat, Kind: "assigned", ByActorID: &actor, DueAt: &now}, &api.RealtimeTaskNotifiedEventV1{}},
		{"task.notified system", notifiedEvent{MessageID: message, ChatID: chat, Kind: "overdue"}, &api.RealtimeTaskNotifiedEventV1{}},
		{"ChatTaskCounts", ChatCounts{Open: 1, Mine: 1}, &api.ChatTaskCounts{}},
		{"TaskNudgeResult", NudgeResult{NextNudgeAt: &now}, &api.TaskNudgeResult{}},
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
	// The department id is only on its kind.
	raw, _ := json.Marshal(person)
	if bytes.Contains(raw, []byte("department_id")) || bytes.Contains(raw, []byte("position_id")) {
		t.Fatalf("person task carries queue ids: %s", raw)
	}
	raw, _ = json.Marshal(closed)
	if !bytes.Contains(raw, []byte(`"position_id":null`)) {
		t.Fatalf("position task without position_id: %s", raw)
	}
}

func TestBodyAndNormalize(t *testing.T) {
	if Body("Купить", "") != "Купить" || Body("Купить", "Молоко") != "Купить\n\nМолоко" {
		t.Fatal("body")
	}
	now := time.Now().UTC()
	actor := "0198c17d-b55b-78d5-b099-f973dd1f265c"
	base := CreateSpec{Title: " Купить ", Assignee: AssigneeInput{Kind: "person", ActorID: &actor}}
	plan, err := Normalize(base, now)
	if err != nil || plan.Title != "Купить" {
		t.Fatalf("plan = %+v, %v", plan, err)
	}
	soon := now.Add(4 * time.Minute)
	later := now.Add(50 * time.Minute)
	far := now.Add(366 * 24 * time.Hour)
	for name, spec := range map[string]CreateSpec{
		"empty title":       {Title: " ", Assignee: base.Assignee},
		"long title":        {Title: string(make([]rune, 201)), Assignee: base.Assignee},
		"due too soon":      {Title: "x", Assignee: base.Assignee, DueAt: &soon},
		"due too far":       {Title: "x", Assignee: base.Assignee, DueAt: &far},
		"remind without":    {Title: "x", Assignee: base.Assignee, RemindBeforeDue: true},
		"remind under hour": {Title: "x", Assignee: base.Assignee, DueAt: &later, RemindBeforeDue: true},
		"bad kind":          {Title: "x", Assignee: AssigneeInput{Kind: "chat"}},
		"person no id":      {Title: "x", Assignee: AssigneeInput{Kind: "person"}},
		"empty item":        {Title: "x", Assignee: base.Assignee, Items: []ItemInput{{Text: " "}}},
	} {
		var field *InvalidError
		if _, err := Normalize(spec, now); err == nil || !asInvalid(err, &field) {
			t.Errorf("%s: %v", name, err)
		}
	}
	items := make([]ItemInput, 31)
	for index := range items {
		items[index] = ItemInput{Text: "x"}
	}
	if _, err := Normalize(CreateSpec{Title: "x", Assignee: base.Assignee, Items: items}, now); err == nil {
		t.Fatal("31 items accepted")
	}
}

func asInvalid(err error, target **InvalidError) bool {
	value, ok := err.(*InvalidError)
	*target = value
	return ok
}
