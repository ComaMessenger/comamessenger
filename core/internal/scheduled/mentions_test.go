package scheduled

import (
	"context"
	"errors"
	"sort"
	"strings"
	"testing"

	"github.com/google/uuid"
)

// A scheduled message keeps the department, not its people: they are
// whoever is in the department and in the chat when it is sent.
func TestScheduledDepartmentMentionExpandsWhenSent(t *testing.T) {
	w := newWorld(t)
	ctx := context.Background()
	hallID, officeID := uuid.NewString(), uuid.NewString()
	w.exec(t, `INSERT INTO departments (org_id, id, name) VALUES ($1, $2, 'Зал ЛФК'), ($1, $3, 'Офис')`, w.orgID, hallID, officeID)
	w.exec(t, `INSERT INTO department_members (org_id, department_id, actor_id, is_primary) VALUES ($1, $2, $3, true)`, w.orgID, hallID, w.author.User.ActorID)

	// An older client puts the department among the people: it is stored
	// as a department.
	input := w.input("@Зал ЛФК, планёрка в 8:30")
	input.MentionedActorIDs = []string{hallID}
	item := w.create(t, w.groupID, input)
	if len(item.MentionedActorIDs) != 0 || strings.Join(item.MentionedDepartmentIDs, ",") != hallID {
		t.Fatalf("stored mentions = %v / %v", item.MentionedActorIDs, item.MentionedDepartmentIDs)
	}
	// Nobody of the department but the author is in the chat yet. Then
	// «other» joins the department and the owner joins it as an
	// additional member: both are in the chat at the time of sending.
	w.exec(t, `INSERT INTO department_members (org_id, department_id, actor_id, is_primary) VALUES ($1, $2, $3, true), ($1, $2, $4, false)`,
		w.orgID, hallID, w.other.User.ActorID, w.owner.User.ActorID)
	w.makeDue(t, item.ID)
	w.deliver(t, item)
	sent := w.load(t, item.ID)
	if sent.Status != StatusSent || sent.MessageID == nil || len(sent.MentionedDepartmentIDs) != 0 {
		t.Fatalf("after send = %+v", sent)
	}
	var mentioned, departments []string
	var notes string
	if err := w.pool.QueryRow(ctx, `SELECT mentioned_actor_ids, mentioned_department_ids, mentioned_departments::text FROM messages WHERE id = $1`, *sent.MessageID).Scan(&mentioned, &departments, &notes); err != nil {
		t.Fatal(err)
	}
	sort.Strings(mentioned)
	want := []string{w.other.User.ActorID, w.owner.User.ActorID}
	sort.Strings(want)
	if strings.Join(mentioned, ",") != strings.Join(want, ",") || strings.Join(departments, ",") != hallID || !strings.Contains(notes, `"notified_count": 2`) {
		t.Fatalf("sent mentions = %v %v %s", mentioned, departments, notes)
	}

	// Editing a pending message replaces people and departments together.
	second := w.create(t, w.groupID, w.input("потом"))
	departmentsOnly := []string{officeID}
	updated, err := w.service.Update(ctx, w.author, second.ID, UpdateInput{ExpectedVersion: second.Version, MentionedDepartmentIDs: &departmentsOnly})
	if err != nil || strings.Join(updated.MentionedDepartmentIDs, ",") != officeID {
		t.Fatalf("update = %+v err = %v", updated.MentionedDepartmentIDs, err)
	}
	unknown := []string{uuid.NewString()}
	if _, err := w.service.Update(ctx, w.author, second.ID, UpdateInput{ExpectedVersion: updated.Version, MentionedDepartmentIDs: &unknown}); !errors.Is(err, ErrInvalid) {
		t.Fatalf("unknown department err = %v", err)
	}
	many := make([]string, 11)
	for index := range many {
		many[index] = uuid.NewString()
	}
	tooMany := w.input("x")
	tooMany.MentionedDepartmentIDs = many
	if _, _, err := w.service.Create(ctx, w.author, w.groupID, tooMany); !errors.Is(err, ErrInvalid) {
		t.Fatalf("11 departments err = %v", err)
	}

	// The department is deleted before the time comes: the message fails
	// like one whose mentioned person left, and keeps its text.
	w.exec(t, `DELETE FROM departments WHERE id = $1`, officeID)
	w.makeDue(t, second.ID)
	w.deliver(t, second)
	failed := w.load(t, second.ID)
	if failed.Status != StatusFailed || failed.FailureReason == nil || *failed.FailureReason != ReasonReferenceUnavailable || failed.Body != "потом" {
		t.Fatalf("after the department was deleted = %s %v", failed.Status, failed.FailureReason)
	}
}
