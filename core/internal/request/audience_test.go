package request_test

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"sync"
	"testing"

	"github.com/comamessenger/comamessenger/core/internal/identity"
	"github.com/comamessenger/comamessenger/core/internal/message"
	"github.com/comamessenger/comamessenger/core/internal/orgstructure"
	"github.com/comamessenger/comamessenger/core/internal/permission"
	"github.com/comamessenger/comamessenger/core/internal/request"
	"github.com/google/uuid"
)

// groupWorld adds to world a department «Зал ЛФК» (alice, bob and the
// outsider, who is not in the chat, the author herself and the deactivated
// sleepy) and a position «Врач» (alice, carol, the outsider).
type groupWorld struct {
	*world
	hallID, doctorID string
}

func newGroupWorld(t *testing.T) *groupWorld {
	t.Helper()
	w := &groupWorld{world: newWorld(t), hallID: uuid.NewString(), doctorID: uuid.NewString()}
	ctx := context.Background()
	for _, statement := range []struct {
		query string
		args  []any
	}{
		{`INSERT INTO departments (org_id, id, name) VALUES ($1, $2, 'Зал ЛФК')`, []any{w.orgID, w.hallID}},
		{`INSERT INTO positions (org_id, id, name) VALUES ($1, $2, 'Врач')`, []any{w.orgID, w.doctorID}},
		{`INSERT INTO department_members (org_id, department_id, actor_id, is_primary)
			SELECT $1, $2, unnest($3::uuid[]), true`, []any{w.orgID, w.hallID, []string{w.alice.ActorID, w.bob.ActorID, w.outsider.ActorID, w.author.ActorID, w.sleepyID}}},
		{`UPDATE actors SET position_id = $2 WHERE org_id = $1 AND id = ANY($3::uuid[])`, []any{w.orgID, w.doctorID, []string{w.alice.ActorID, w.carol.ActorID, w.outsider.ActorID}}},
	} {
		if _, err := w.pool.Exec(ctx, statement.query, statement.args...); err != nil {
			t.Fatalf("%s: %v", statement.query, err)
		}
	}
	return w
}

func (w *groupWorld) grant(t *testing.T, user identity.User) {
	t.Helper()
	if _, err := w.pool.Exec(context.Background(), `INSERT INTO actor_permissions (org_id, actor_id, permission, granted_by) VALUES ($1, $2, 'requests.address_groups', $3)`,
		w.orgID, user.ActorID, w.owner.ActorID); err != nil {
		t.Fatal(err)
	}
}

func (w *groupWorld) revoke(t *testing.T, user identity.User) {
	t.Helper()
	if _, err := w.pool.Exec(context.Background(), `DELETE FROM actor_permissions WHERE actor_id = $1 AND permission = 'requests.address_groups'`, user.ActorID); err != nil {
		t.Fatal(err)
	}
}

func (w *groupWorld) ask(author identity.User, audience request.AudienceInput, clientMsgID string) (message.Message, error) {
	if clientMsgID == "" {
		clientMsgID = uuid.NewString()
	}
	result, _, err := w.messages.CreateRequest(context.Background(), author, w.chatID, message.CreateRequestInput{
		ClientMsgID: clientMsgID, Body: "Все врачи — ознакомиться", Audience: audience,
		Answer: request.AnswerSpec{Preset: request.PresetAck},
	})
	return result, err
}

func (w *groupWorld) recipients(t *testing.T, messageID string) []string {
	t.Helper()
	rows, err := w.pool.Query(context.Background(), `SELECT actor_id::text FROM message_request_recipients WHERE message_id = $1 ORDER BY actor_id`, messageID)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	result := []string{}
	for rows.Next() {
		var value string
		if err := rows.Scan(&value); err != nil {
			t.Fatal(err)
		}
		result = append(result, value)
	}
	return result
}

func sameSet(got []string, want ...string) bool {
	if len(got) != len(want) {
		return false
	}
	seen := map[string]bool{}
	for _, value := range got {
		seen[value] = true
	}
	for _, value := range want {
		if !seen[value] {
			return false
		}
	}
	return true
}

func TestGroupAudiences(t *testing.T) {
	w := newGroupWorld(t)
	ctx := context.Background()
	department := request.AudienceInput{Kind: "department", DepartmentID: &w.hallID}
	position := request.AudienceInput{Kind: "position", PositionID: &w.doctorID}

	t.Run("without the permission: 403, nothing written", func(t *testing.T) {
		before := w.seq(t)
		for _, audience := range []request.AudienceInput{department, position} {
			if _, err := w.ask(w.author, audience, ""); !errors.Is(err, request.ErrAudienceForbidden) {
				t.Fatalf("%s err = %v", audience.Kind, err)
			}
		}
		// The session may claim the permission; the database decides.
		claimed := w.author
		claimed.Permissions = []permission.Code{permission.RequestsAddressGroups}
		if _, err := w.ask(claimed, department, ""); !errors.Is(err, request.ErrAudienceForbidden) {
			t.Fatalf("claimed permission err = %v", err)
		}
		if after := w.seq(t); after != before {
			t.Fatalf("events written: %d → %d", before, after)
		}
		// An unknown department is not revealed to someone without the right.
		missing := uuid.NewString()
		if _, err := w.ask(w.author, request.AudienceInput{Kind: "department", DepartmentID: &missing}, ""); !errors.Is(err, request.ErrAudienceForbidden) {
			t.Fatalf("unknown department without the permission err = %v", err)
		}
	})

	t.Run("a department: its active people in the chat, without the author", func(t *testing.T) {
		w.grant(t, w.author)
		defer w.revoke(t, w.author)
		created, err := w.ask(w.author, department, "")
		if err != nil {
			t.Fatal(err)
		}
		if got := w.recipients(t, created.ID); !sameSet(got, w.alice.ActorID, w.bob.ActorID) {
			t.Fatalf("recipients = %v", got)
		}
		audience := created.Request.Audience
		if audience.Kind != "department" || audience.Label != "Зал ЛФК" || audience.Count != 2 || audience.DepartmentID == nil || *audience.DepartmentID != w.hallID {
			t.Fatalf("audience = %+v", audience)
		}
		raw, _ := json.Marshal(audience)
		if string(raw) != `{"kind":"department","label":"Зал ЛФК","count":2,"department_id":"`+w.hallID+`"}` {
			t.Fatalf("json = %s", raw)
		}
		// Joining the department later asks nobody new.
		if _, err := w.pool.Exec(ctx, `INSERT INTO department_members (org_id, department_id, actor_id, is_primary) VALUES ($1, $2, $3, true)`, w.orgID, w.hallID, w.carol.ActorID); err != nil {
			t.Fatal(err)
		}
		defer w.pool.Exec(ctx, `DELETE FROM department_members WHERE actor_id = $1`, w.carol.ActorID)
		if got := w.recipients(t, created.ID); len(got) != 2 {
			t.Fatalf("recipients after joining = %v", got)
		}
		if n := w.count(t, `SELECT count(*) FROM events WHERE type = 'request.assigned' AND subject_id = $1 AND audience_actor_id = $2`, created.ID, w.outsider.ActorID); n != 0 {
			t.Fatal("the outsider was told about the request")
		}
	})

	t.Run("a position, with the permission revoked and restored", func(t *testing.T) {
		w.grant(t, w.author)
		created, err := w.ask(w.author, position, "")
		if err != nil {
			t.Fatal(err)
		}
		if got := w.recipients(t, created.ID); !sameSet(got, w.alice.ActorID, w.carol.ActorID) {
			t.Fatalf("recipients = %v", got)
		}
		raw, _ := json.Marshal(created.Request.Audience)
		if string(raw) != `{"kind":"position","label":"Врач","count":2,"position_id":"`+w.doctorID+`"}` {
			t.Fatalf("json = %s", raw)
		}
		// Revoked a moment ago: the session still lists it, the database
		// does not.
		w.revoke(t, w.author)
		claimed := w.author
		claimed.Permissions = []permission.Code{permission.RequestsAddressGroups}
		if _, err := w.ask(claimed, position, ""); !errors.Is(err, request.ErrAudienceForbidden) {
			t.Fatalf("revoked err = %v", err)
		}
		// The request already sent lives on: the permission is checked when
		// it is created only.
		if _, err := w.answer(w.alice, created.ID, 0, nil); err != nil {
			t.Fatalf("answer after revoke: %v", err)
		}
	})

	t.Run("the owner may without a grant, an administrator may not", func(t *testing.T) {
		if _, err := w.ask(w.owner, department, ""); err != nil {
			t.Fatalf("owner err = %v", err)
		}
		if _, err := w.pool.Exec(ctx, `UPDATE actors SET org_role = 'admin' WHERE id = $1`, w.admin.ActorID); err != nil {
			t.Fatal(err)
		}
		administrator := w.admin
		administrator.OrgRole = "admin"
		if _, err := w.ask(administrator, department, ""); !errors.Is(err, request.ErrAudienceForbidden) {
			t.Fatalf("administrator err = %v", err)
		}
	})

	t.Run("unknown groups, empty groups, people and chat unchanged", func(t *testing.T) {
		w.grant(t, w.author)
		defer w.revoke(t, w.author)
		missing := uuid.NewString()
		if _, err := w.ask(w.author, request.AudienceInput{Kind: "department", DepartmentID: &missing}, ""); !errors.Is(err, request.ErrDepartmentMissing) {
			t.Fatalf("unknown department err = %v", err)
		}
		if _, err := w.ask(w.author, request.AudienceInput{Kind: "position", PositionID: &missing}, ""); !errors.Is(err, request.ErrPositionMissing) {
			t.Fatalf("unknown position err = %v", err)
		}
		emptyID := uuid.NewString()
		if _, err := w.pool.Exec(ctx, `INSERT INTO departments (org_id, id, name) VALUES ($1, $2, 'Склад')`, w.orgID, emptyID); err != nil {
			t.Fatal(err)
		}
		if _, err := w.pool.Exec(ctx, `INSERT INTO department_members (org_id, department_id, actor_id, is_primary) VALUES ($1, $2, $3, false)`, w.orgID, emptyID, w.outsider.ActorID); err != nil {
			t.Fatal(err)
		}
		if _, err := w.ask(w.author, request.AudienceInput{Kind: "department", DepartmentID: &emptyID}, ""); !errors.Is(err, request.ErrAudienceEmpty) {
			t.Fatalf("nobody of the department in the chat err = %v", err)
		}
		for name, audience := range map[string]request.AudienceInput{
			"department with actor_ids":   {Kind: "department", DepartmentID: &w.hallID, ActorIDs: []string{w.alice.ActorID}},
			"department with position_id": {Kind: "department", DepartmentID: &w.hallID, PositionID: &w.doctorID},
			"position with department_id": {Kind: "position", PositionID: &w.doctorID, DepartmentID: &w.hallID},
			"department id not a UUID":    {Kind: "department", DepartmentID: ptr("hall")},
			"people with department_id":   {Kind: "people", ActorIDs: []string{w.alice.ActorID}, DepartmentID: &w.hallID},
		} {
			if _, err := w.ask(w.author, audience, ""); !errors.Is(err, request.ErrInvalid) {
				t.Fatalf("%s err = %v", name, err)
			}
		}
		created, err := w.ask(w.author, request.AudienceInput{Kind: "chat"}, "")
		if err != nil {
			t.Fatal(err)
		}
		raw, _ := json.Marshal(created.Request.Audience)
		if strings.Contains(string(raw), "department_id") || strings.Contains(string(raw), "position_id") {
			t.Fatalf("chat audience json = %s", raw)
		}
	})

	t.Run("replays and conflicts", func(t *testing.T) {
		w.grant(t, w.author)
		defer w.revoke(t, w.author)
		clientMsgID := uuid.NewString()
		first, err := w.ask(w.author, department, clientMsgID)
		if err != nil {
			t.Fatal(err)
		}
		again, err := w.ask(w.author, department, clientMsgID)
		if err != nil || again.ID != first.ID {
			t.Fatalf("replay: %v %v", again.ID, err)
		}
		otherID := uuid.NewString()
		if _, err := w.pool.Exec(ctx, `INSERT INTO departments (org_id, id, name) VALUES ($1, $2, 'Бассейн')`, w.orgID, otherID); err != nil {
			t.Fatal(err)
		}
		if _, err := w.ask(w.author, request.AudienceInput{Kind: "department", DepartmentID: &otherID}, clientMsgID); !errors.Is(err, message.ErrIdempotencyConflict) {
			t.Fatalf("other department err = %v", err)
		}
	})

	t.Run("deleting the department keeps the label and the answers", func(t *testing.T) {
		w.grant(t, w.author)
		defer w.revoke(t, w.author)
		created, err := w.ask(w.author, department, "")
		if err != nil {
			t.Fatal(err)
		}
		if _, err := w.answer(w.bob, created.ID, 0, nil); err != nil {
			t.Fatal(err)
		}
		if _, err := w.pool.Exec(ctx, `DELETE FROM departments WHERE id = $1`, w.hallID); err != nil {
			t.Fatal(err)
		}
		reread, err := w.messages.Get(ctx, w.author, created.ID)
		if err != nil {
			t.Fatal(err)
		}
		audience := reread.Request.Audience
		if audience.Label != "Зал ЛФК" || audience.DepartmentID != nil || reread.Request.AnsweredCount != 1 {
			t.Fatalf("after delete = %+v %+v", audience, reread.Request)
		}
		raw, _ := json.Marshal(audience)
		if !strings.Contains(string(raw), `"department_id":null`) {
			t.Fatalf("json = %s", raw)
		}
		if _, err := w.answer(w.alice, created.ID, 0, nil); err != nil {
			t.Fatalf("answer after delete: %v", err)
		}
	})
}

// Agents never send requests, to a group or otherwise.
func TestGroupAudienceAgent(t *testing.T) {
	w := newGroupWorld(t)
	agent := identity.User{ActorID: w.agentID, OrgID: w.orgID, OrgRole: "member", Status: "active"}
	hall := w.hallID
	if _, err := w.ask(agent, request.AudienceInput{Kind: "department", DepartmentID: &hall}, ""); !errors.Is(err, message.ErrForbidden) && !errors.Is(err, request.ErrAudienceForbidden) {
		t.Fatalf("agent err = %v", err)
	}
}

// A request to a department races the deletion of the department and a
// change of its members: no deadlock, and each request is either refused
// as missing or written with the members it saw.
func TestGroupAudienceRacesOrgWrites(t *testing.T) {
	w := newGroupWorld(t)
	ctx := context.Background()
	w.grant(t, w.author)
	hall := w.hallID
	owner := w.owner
	owner.Permissions = permission.Effective("owner", nil)
	org := orgstructure.NewService(w.pool, w.chats, nil)
	var wait sync.WaitGroup
	errs := make(chan error, 32)
	for index := range 10 {
		wait.Add(2)
		go func() {
			defer wait.Done()
			_, err := w.ask(w.author, request.AudienceInput{Kind: "department", DepartmentID: &hall}, "")
			if err != nil && !errors.Is(err, request.ErrDepartmentMissing) && !errors.Is(err, request.ErrAudienceEmpty) && !errors.Is(err, request.ErrLimitReached) {
				errs <- err
			}
		}()
		go func() {
			defer wait.Done()
			var err error
			if index == 7 {
				err = org.DeleteDepartment(ctx, owner, hall, "")
			} else if index%2 == 0 {
				err = org.RemoveDepartmentMember(ctx, owner, hall, w.bob.ActorID)
			} else {
				_, err = org.SetDepartmentMember(ctx, owner, hall, w.bob.ActorID, orgstructure.SetDepartmentMemberInput{Primary: true})
			}
			if errors.Is(err, orgstructure.ErrDepartmentNotFound) || errors.Is(err, orgstructure.ErrInvalid) {
				err = nil
			}
			if err != nil {
				errs <- err
			}
		}()
	}
	wait.Wait()
	close(errs)
	for err := range errs {
		t.Error(err)
	}
	if n := w.count(t, `SELECT count(*) FROM message_requests WHERE audience_kind = 'department' AND audience_department_id IS NOT NULL`); n != 0 {
		t.Fatalf("%d requests still point at the deleted department", n)
	}
}

// Department mentions in the question work as in an ordinary message.
func TestRequestBodyMentionsDepartment(t *testing.T) {
	w := newGroupWorld(t)
	created, _, err := w.messages.CreateRequest(context.Background(), w.author, w.chatID, message.CreateRequestInput{
		ClientMsgID: uuid.NewString(), Body: "@[Зал ЛФК](x) — кто завтра?", MentionedDepartmentIDs: []string{w.hallID},
		Audience: request.AudienceInput{Kind: "chat"}, Answer: request.AnswerSpec{Preset: request.PresetYesNo},
	})
	if err != nil {
		t.Fatal(err)
	}
	if !sameSet(created.MentionedActorIDs, w.alice.ActorID, w.bob.ActorID) || created.MentionedDepartments == nil || len(*created.MentionedDepartments) != 1 {
		t.Fatalf("mentions = %v %v", created.MentionedActorIDs, created.MentionedDepartments)
	}
}
