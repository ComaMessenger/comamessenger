package message

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strings"
	"sync"
	"testing"

	"github.com/comamessenger/comamessenger/core/internal/chat"
	"github.com/comamessenger/comamessenger/core/internal/identity"
	"github.com/comamessenger/comamessenger/core/internal/orgstructure"
	"github.com/comamessenger/comamessenger/core/internal/permission"
	"github.com/comamessenger/comamessenger/core/internal/testdb"
	"github.com/jackc/pgx/v5/pgxpool"
)

// mentionWorld: a rehab centre with «Реабилитация» and its subdepartment
// «Зал ЛФК». In the group chat: the author (a member of «Реабилитация»
// herself), anna (primary in «Реабилитация»), boris (primary in «Зал
// ЛФК»), vera (primary elsewhere, additional in «Зал ЛФК»), dina
// (deactivated, in «Реабилитация»), carol (in no department) and an agent.
// gleb is in «Реабилитация» but not in the chat. A database holds one
// workspace, so otherOrgDeptID is an id that is no department here.
type mentionWorld struct {
	pool                          *pgxpool.Pool
	service                       *Service
	orgID, chatID, otherOrgDeptID string
	rehabID, hallID, officeID     string
	author, owner                 identity.User
	anna, boris, vera, gleb       identity.User
	carol, dina                   identity.User
	agentID, runID                string
}

func newMentionWorld(t *testing.T) *mentionWorld {
	t.Helper()
	pool := testdb.New(t)
	ctx := context.Background()
	w := &mentionWorld{pool: pool, service: NewService(pool, 64*1024, 100, nil), orgID: mustID(t), chatID: mustID(t),
		rehabID: mustID(t), hallID: mustID(t), officeID: mustID(t), otherOrgDeptID: mustID(t), agentID: mustID(t), runID: mustID(t)}
	person := func(role string) identity.User {
		return identity.User{ActorID: mustID(t), OrgID: w.orgID, OrgRole: role, Status: "active"}
	}
	w.author, w.owner = person("member"), person("owner")
	w.anna, w.boris, w.vera, w.gleb, w.carol, w.dina = person("member"), person("member"), person("member"), person("member"), person("member"), person("member")
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	exec := func(query string, args ...any) {
		t.Helper()
		if _, err := tx.Exec(ctx, query, args...); err != nil {
			t.Fatalf("%s: %v", query, err)
		}
	}
	exec(`INSERT INTO organizations (id, name, slug) VALUES ($1, 'Опора', 'opora')`, w.orgID)
	for handle, user := range map[string]identity.User{"author": w.author, "owner": w.owner, "anna": w.anna, "boris": w.boris, "vera": w.vera, "gleb": w.gleb, "carol": w.carol, "dina": w.dina} {
		exec(`INSERT INTO actors (id, org_id, type, org_role, display_name, handle) VALUES ($1, $2, 'user', $3, $4, $5)`, user.ActorID, w.orgID, user.OrgRole, handle, handle)
	}
	exec(`UPDATE actors SET status = 'deactivated' WHERE id = $1`, w.dina.ActorID)
	exec(`INSERT INTO actors (id, org_id, type, org_role, display_name, handle) VALUES ($1, $2, 'agent', 'member', 'Помощник', 'helper')`, w.agentID, w.orgID)
	exec(`INSERT INTO agents(actor_id,org_id,owner_actor_id,kind,enabled,allowed_scopes,published_version) VALUES($1,$2,$3,'builtin',true,ARRAY['messages:write'],1)`, w.agentID, w.orgID, w.owner.ActorID)
	exec(`INSERT INTO chats (id, org_id, kind, visibility, name, created_by) VALUES ($1, $2, 'group', 'private', 'Смена', $3)`, w.chatID, w.orgID, w.owner.ActorID)
	exec(`INSERT INTO chat_members (chat_id, actor_id, org_id, role) VALUES ($1, $2, $3, 'owner')`, w.chatID, w.owner.ActorID, w.orgID)
	for _, member := range []string{w.author.ActorID, w.anna.ActorID, w.boris.ActorID, w.vera.ActorID, w.carol.ActorID, w.dina.ActorID, w.agentID} {
		exec(`INSERT INTO chat_members (chat_id, actor_id, org_id, role) VALUES ($1, $2, $3, 'member')`, w.chatID, member, w.orgID)
	}
	exec(`INSERT INTO departments (org_id, id, name) VALUES ($1, $2, 'Реабилитация'), ($1, $3, 'Офис')`, w.orgID, w.rehabID, w.officeID)
	exec(`INSERT INTO departments (org_id, id, parent_id, name) VALUES ($1, $2, $3, 'Зал ЛФК')`, w.orgID, w.hallID, w.rehabID)
	for _, row := range []struct {
		department, actor string
		primary           bool
	}{
		{w.rehabID, w.author.ActorID, true}, {w.rehabID, w.anna.ActorID, true}, {w.rehabID, w.gleb.ActorID, true},
		{w.rehabID, w.dina.ActorID, true}, {w.hallID, w.boris.ActorID, true}, {w.officeID, w.vera.ActorID, true},
		{w.hallID, w.vera.ActorID, false},
	} {
		exec(`INSERT INTO department_members (org_id, department_id, actor_id, is_primary) VALUES ($1, $2, $3, $4)`, w.orgID, row.department, row.actor, row.primary)
	}
	exec(`INSERT INTO agent_runs(id,org_id,agent_id,correlation_id,chat_id,input) VALUES($1,$2,$3,gen_random_uuid(),$4,'{"trigger_type":"manual"}')`, w.runID, w.orgID, w.agentID, w.chatID)
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	return w
}

func (w *mentionWorld) send(t *testing.T, author identity.User, actorIDs, departmentIDs []string) (Message, error) {
	t.Helper()
	result, _, err := w.service.Create(context.Background(), author, w.chatID, CreateInput{
		ClientMsgID: mustID(t), Body: "@[Зал ЛФК](x), завтра в 8:30 планёрка", BodyFormat: "plain",
		MentionedActorIDs: actorIDs, MentionedDepartmentIDs: departmentIDs,
	})
	return result, err
}

func sortedIDs(values ...string) []string {
	result := append([]string{}, values...)
	sort.Strings(result)
	return result
}

func sameIDs(got, want []string) bool {
	return strings.Join(sortedIDs(got...), ",") == strings.Join(sortedIDs(want...), ",")
}

func departmentsOf(t *testing.T, message Message) ([]string, []DepartmentMention) {
	t.Helper()
	if message.MentionedDepartmentIDs == nil || message.MentionedDepartments == nil {
		t.Fatalf("message %s has no department fields: %+v", message.ID, message)
	}
	return *message.MentionedDepartmentIDs, *message.MentionedDepartments
}

func TestDepartmentMentions(t *testing.T) {
	w := newMentionWorld(t)
	ctx := context.Background()

	t.Run("a department notifies only its active people in the chat, without the author", func(t *testing.T) {
		created, err := w.send(t, w.author, nil, []string{w.rehabID})
		if err != nil {
			t.Fatal(err)
		}
		// anna (Реабилитация), boris (Зал ЛФК, a subdepartment), vera
		// (additional in Зал ЛФК). Not the author, not gleb (outside the
		// chat), not dina (deactivated), not carol, not the agent.
		want := []string{w.anna.ActorID, w.boris.ActorID, w.vera.ActorID}
		if !sameIDs(created.MentionedActorIDs, want) {
			t.Fatalf("mentioned = %v, want %v", created.MentionedActorIDs, want)
		}
		ids, departments := departmentsOf(t, created)
		if !sameIDs(ids, []string{w.rehabID}) || len(departments) != 1 || departments[0] != (DepartmentMention{DepartmentID: w.rehabID, NotifiedCount: 3}) {
			t.Fatalf("departments = %v %+v", ids, departments)
		}
		var stored []string
		if err := w.pool.QueryRow(ctx, `SELECT mentioned_actor_ids FROM messages WHERE id = $1`, created.ID).Scan(&stored); err != nil {
			t.Fatal(err)
		}
		if !sameIDs(stored, want) {
			t.Fatalf("stored mentions = %v", stored)
		}
		// Every reader and every realtime frame gets the same fields.
		got, err := w.service.Get(ctx, w.carol, created.ID)
		if err != nil {
			t.Fatal(err)
		}
		if _, departments := departmentsOf(t, got); len(departments) != 1 || departments[0].NotifiedCount != 3 {
			t.Fatalf("read departments = %+v", departments)
		}
		page, err := w.service.List(ctx, w.carol, w.chatID, ListOptions{})
		if err != nil {
			t.Fatal(err)
		}
		if listed := page.Messages[len(page.Messages)-1]; listed.ID != created.ID || listed.MentionedDepartments == nil || len(*listed.MentionedDepartments) != 1 {
			t.Fatalf("listed = %+v", listed)
		}
		raw, _ := json.Marshal(Message{ID: created.ID, ChatID: w.chatID, MentionedActorIDs: created.MentionedActorIDs})
		data := json.RawMessage(raw)
		tx, err := w.pool.Begin(ctx)
		if err != nil {
			t.Fatal(err)
		}
		defer tx.Rollback(ctx)
		if err := CompleteEventMessages(ctx, tx, w.orgID, []EventMessage{{Data: &data}}); err != nil {
			t.Fatal(err)
		}
		if !strings.Contains(string(data), `"mentioned_department_ids":["`+w.rehabID+`"]`) || !strings.Contains(string(data), `"mentioned_departments":[{"department_id":"`+w.rehabID+`","notified_count":3}]`) {
			t.Fatalf("frame = %s", data)
		}
	})

	t.Run("a message without departments carries empty lists", func(t *testing.T) {
		created, err := w.send(t, w.author, []string{w.carol.ActorID}, nil)
		if err != nil {
			t.Fatal(err)
		}
		if ids, departments := departmentsOf(t, created); len(ids) != 0 || len(departments) != 0 {
			t.Fatalf("departments = %v %v", ids, departments)
		}
		raw, _ := json.Marshal(created)
		if !strings.Contains(string(raw), `"mentioned_department_ids":[]`) || !strings.Contains(string(raw), `"mentioned_departments":[]`) {
			t.Fatalf("json = %s", raw)
		}
	})

	t.Run("people and departments add up, without repeats", func(t *testing.T) {
		created, err := w.send(t, w.author, []string{w.carol.ActorID, w.boris.ActorID}, []string{w.hallID, w.rehabID})
		if err != nil {
			t.Fatal(err)
		}
		want := []string{w.carol.ActorID, w.anna.ActorID, w.boris.ActorID, w.vera.ActorID}
		if !sameIDs(created.MentionedActorIDs, want) {
			t.Fatalf("mentioned = %v, want %v", created.MentionedActorIDs, want)
		}
		_, departments := departmentsOf(t, created)
		counts := map[string]int{}
		for _, item := range departments {
			counts[item.DepartmentID] = item.NotifiedCount
		}
		if counts[w.hallID] != 2 || counts[w.rehabID] != 3 || len(counts) != 2 {
			t.Fatalf("counts = %v", counts)
		}
	})

	t.Run("a department with nobody in the chat is accepted and notifies nobody", func(t *testing.T) {
		if _, err := w.pool.Exec(ctx, `INSERT INTO department_members (org_id, department_id, actor_id, is_primary) VALUES ($1, $2, $3, false)`, w.orgID, w.officeID, w.gleb.ActorID); err != nil {
			t.Fatal(err)
		}
		if _, err := w.pool.Exec(ctx, `DELETE FROM department_members WHERE department_id = $1 AND actor_id = $2`, w.officeID, w.vera.ActorID); err != nil {
			t.Fatal(err)
		}
		created, err := w.send(t, w.author, nil, []string{w.officeID})
		if err != nil {
			t.Fatal(err)
		}
		if len(created.MentionedActorIDs) != 0 {
			t.Fatalf("mentioned = %v (gleb is outside the chat)", created.MentionedActorIDs)
		}
		if _, departments := departmentsOf(t, created); len(departments) != 1 || departments[0].NotifiedCount != 0 {
			t.Fatalf("departments = %+v", departments)
		}
	})

	t.Run("an older client's department id among the people is moved", func(t *testing.T) {
		created, err := w.send(t, w.author, []string{strings.ToUpper(w.hallID), w.carol.ActorID}, nil)
		if err != nil {
			t.Fatal(err)
		}
		if !sameIDs(created.MentionedActorIDs, []string{w.carol.ActorID, w.boris.ActorID, w.vera.ActorID}) {
			t.Fatalf("mentioned = %v", created.MentionedActorIDs)
		}
		if ids, _ := departmentsOf(t, created); !sameIDs(ids, []string{w.hallID}) {
			t.Fatalf("departments = %v", ids)
		}
	})

	t.Run("unknown and foreign departments are refused", func(t *testing.T) {
		for name, ids := range map[string][]string{"unknown": {mustID(t)}, "another workspace": {w.otherOrgDeptID}, "not a UUID": {"hall"}} {
			_, err := w.send(t, w.author, nil, ids)
			var field *FieldError
			if !errors.As(err, &field) || field.Field != "mentioned_department_ids" || !errors.Is(err, ErrInvalid) {
				t.Fatalf("%s: err = %v", name, err)
			}
		}
		// A foreign department sent as a person is not a department here:
		// it is checked as a person and refused.
		if _, err := w.send(t, w.author, []string{w.otherOrgDeptID}, nil); !errors.Is(err, ErrInvalid) {
			t.Fatalf("foreign department as a person: err = %v", err)
		}
		// People are still checked as before.
		if _, err := w.send(t, w.author, []string{w.gleb.ActorID}, []string{w.rehabID}); !errors.Is(err, ErrInvalid) {
			t.Fatalf("a person outside the chat: err = %v", err)
		}
	})

	t.Run("at most ten departments", func(t *testing.T) {
		many := make([]string, 0, 11)
		for index := range 11 {
			departmentID := mustID(t)
			if _, err := w.pool.Exec(ctx, `INSERT INTO departments (org_id, id, name) VALUES ($1, $2, $3)`, w.orgID, departmentID, fmt.Sprintf("Отдел %d", index)); err != nil {
				t.Fatal(err)
			}
			many = append(many, departmentID)
		}
		var field *FieldError
		if _, err := w.send(t, w.author, nil, many); !errors.As(err, &field) || field.Field != "mentioned_department_ids" {
			t.Fatalf("11 departments: err = %v", err)
		}
		// Ten plus one moved from the people is eleven as well.
		if _, err := w.send(t, w.author, many[10:], many[:10]); !errors.As(err, &field) {
			t.Fatalf("10 + 1 moved: err = %v", err)
		}
		if _, err := w.send(t, w.author, nil, many[:10]); err != nil {
			t.Fatalf("10 departments: %v", err)
		}
	})

	t.Run("the replay of the same command is idempotent, another department is a conflict", func(t *testing.T) {
		input := CreateInput{ClientMsgID: mustID(t), Body: "@Зал ЛФК", BodyFormat: "plain", MentionedDepartmentIDs: []string{w.hallID}}
		first, created, err := w.service.Create(ctx, w.author, w.chatID, input)
		if err != nil || !created {
			t.Fatalf("first: created=%v err=%v", created, err)
		}
		again, created, err := w.service.Create(ctx, w.author, w.chatID, input)
		if err != nil || created || again.ID != first.ID {
			t.Fatalf("replay: created=%v err=%v", created, err)
		}
		if ids, departments := departmentsOf(t, again); !sameIDs(ids, []string{w.hallID}) || len(departments) != 1 {
			t.Fatalf("replay departments = %v %v", ids, departments)
		}
		input.MentionedDepartmentIDs = []string{w.rehabID}
		if _, _, err := w.service.Create(ctx, w.author, w.chatID, input); !errors.Is(err, ErrIdempotencyConflict) {
			t.Fatalf("other department: err = %v", err)
		}
	})

	t.Run("a department in a thread reply notifies but does not subscribe its people", func(t *testing.T) {
		root, err := w.send(t, w.owner, nil, nil)
		if err != nil {
			t.Fatal(err)
		}
		reply, _, err := w.service.Create(ctx, w.author, w.chatID, CreateInput{ClientMsgID: mustID(t), Body: "в тред", BodyFormat: "plain",
			ThreadRootID: &root.ID, MentionedActorIDs: []string{w.carol.ActorID}, MentionedDepartmentIDs: []string{w.hallID}})
		if err != nil {
			t.Fatal(err)
		}
		if !sameIDs(reply.MentionedActorIDs, []string{w.carol.ActorID, w.boris.ActorID, w.vera.ActorID}) {
			t.Fatalf("mentioned = %v", reply.MentionedActorIDs)
		}
		assertCount(t, w.pool, `SELECT count(*) FROM thread_followers WHERE thread_root_id = $1 AND actor_id = ANY($2::uuid[])`, 0, root.ID, []string{w.boris.ActorID, w.vera.ActorID})
		assertCount(t, w.pool, `SELECT count(*) FROM thread_followers WHERE thread_root_id = $1 AND actor_id = $2`, 1, root.ID, w.carol.ActorID)
	})

	t.Run("an agent may mention a department like a person", func(t *testing.T) {
		agent := identity.User{ActorID: w.agentID, OrgID: w.orgID, OrgRole: "member", Status: "active"}
		created, _, err := w.service.CreateForAgentRun(ctx, agent, w.chatID, CreateInput{
			ClientMsgID: mustID(t), Body: "Напоминание для зала", BodyFormat: "plain", MentionedDepartmentIDs: []string{w.hallID},
		}, AgentProvenance{RunID: w.runID})
		if err != nil {
			t.Fatal(err)
		}
		if !sameIDs(created.MentionedActorIDs, []string{w.boris.ActorID, w.vera.ActorID}) {
			t.Fatalf("mentioned = %v", created.MentionedActorIDs)
		}
	})
}

func TestDepartmentMentionEdits(t *testing.T) {
	w := newMentionWorld(t)
	ctx := context.Background()
	created, err := w.send(t, w.author, []string{w.carol.ActorID}, []string{w.hallID})
	if err != nil {
		t.Fatal(err)
	}
	edit := func(version int, actorIDs, departmentIDs *[]string) Message {
		t.Helper()
		updated, err := w.service.Update(ctx, w.author, created.ID, UpdateInput{Body: "исправлено", BodyFormat: "plain", ExpectedVersion: version,
			MentionedActorIDs: actorIDs, MentionedDepartmentIDs: departmentIDs})
		if err != nil {
			t.Fatal(err)
		}
		return updated
	}

	// Without mention fields the mentions stay as they were.
	updated := edit(1, nil, nil)
	if ids, _ := departmentsOf(t, updated); !sameIDs(ids, []string{w.hallID}) || !sameIDs(updated.MentionedActorIDs, []string{w.carol.ActorID, w.boris.ActorID, w.vera.ActorID}) {
		t.Fatalf("kept = %v %v", ids, updated.MentionedActorIDs)
	}

	// The edit expands again, against the chat as it is now: anna joined
	// «Зал ЛФК», vera left the chat.
	if _, err := w.pool.Exec(ctx, `INSERT INTO department_members (org_id, department_id, actor_id, is_primary) VALUES ($1, $2, $3, false)`, w.orgID, w.hallID, w.anna.ActorID); err != nil {
		t.Fatal(err)
	}
	if _, err := w.pool.Exec(ctx, `DELETE FROM chat_members WHERE chat_id = $1 AND actor_id = $2`, w.chatID, w.vera.ActorID); err != nil {
		t.Fatal(err)
	}
	updated = edit(2, &[]string{}, &[]string{w.hallID})
	if !sameIDs(updated.MentionedActorIDs, []string{w.anna.ActorID, w.boris.ActorID}) {
		t.Fatalf("re-expanded = %v", updated.MentionedActorIDs)
	}
	if _, departments := departmentsOf(t, updated); len(departments) != 1 || departments[0].NotifiedCount != 2 {
		t.Fatalf("departments = %+v", departments)
	}

	// An older client sends only the people, the department token among
	// them.
	updated = edit(3, &[]string{w.rehabID}, nil)
	if ids, _ := departmentsOf(t, updated); !sameIDs(ids, []string{w.rehabID}) {
		t.Fatalf("moved = %v", ids)
	}
	// Only people: the departments are gone.
	updated = edit(4, &[]string{w.carol.ActorID}, nil)
	if ids, departments := departmentsOf(t, updated); len(ids) != 0 || len(departments) != 0 || !sameIDs(updated.MentionedActorIDs, []string{w.carol.ActorID}) {
		t.Fatalf("cleared = %v %v %v", ids, departments, updated.MentionedActorIDs)
	}
	// The revisions keep what each version mentioned.
	rows, err := w.pool.Query(ctx, `SELECT version, mentioned_department_ids FROM message_revisions WHERE message_id = $1 ORDER BY version`, created.ID)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	want := map[int][]string{1: {w.hallID}, 2: {w.hallID}, 3: {w.hallID}, 4: {w.rehabID}}
	seen := 0
	for rows.Next() {
		var version int
		var ids []string
		if err := rows.Scan(&version, &ids); err != nil {
			t.Fatal(err)
		}
		if !sameIDs(ids, want[version]) {
			t.Fatalf("revision %d departments = %v, want %v", version, ids, want[version])
		}
		seen++
	}
	if seen != 4 {
		t.Fatalf("revisions = %d", seen)
	}
	// Edits refuse what creation refuses.
	many := make([]string, 11)
	for index := range many {
		many[index] = mustID(t)
	}
	if _, err := w.service.Update(ctx, w.author, created.ID, UpdateInput{Body: "x", BodyFormat: "plain", ExpectedVersion: 5, MentionedDepartmentIDs: &many}); !errors.Is(err, ErrInvalid) {
		t.Fatalf("11 departments on edit: err = %v", err)
	}
	if _, err := w.service.Update(ctx, w.author, created.ID, UpdateInput{Body: "x", BodyFormat: "plain", ExpectedVersion: 5, MentionedDepartmentIDs: &[]string{w.otherOrgDeptID}}); !errors.Is(err, ErrInvalid) {
		t.Fatalf("foreign department on edit: err = %v", err)
	}
}

// Writes of the org structure and sends with @department take the
// organization lock in the same order: run them against each other.
func TestDepartmentMentionsRaceOrgWrites(t *testing.T) {
	w := newMentionWorld(t)
	ctx := context.Background()
	owner := w.owner
	owner.Permissions = permission.Effective("owner", nil)
	org := orgstructure.NewService(w.pool, chat.NewService(w.pool), nil)
	var wait sync.WaitGroup
	errs := make(chan error, 64)
	for index := range 8 {
		wait.Add(2)
		go func() {
			defer wait.Done()
			if _, err := w.send(t, w.author, nil, []string{w.rehabID, w.hallID}); err != nil {
				errs <- fmt.Errorf("send %d: %w", index, err)
			}
		}()
		go func() {
			defer wait.Done()
			var err error
			if index%2 == 0 {
				err = org.RemoveDepartmentMember(ctx, owner, w.hallID, w.boris.ActorID)
			} else {
				_, err = org.SetDepartmentMember(ctx, owner, w.hallID, w.boris.ActorID, orgstructure.SetDepartmentMemberInput{Primary: true})
			}
			if err != nil && !errors.Is(err, orgstructure.ErrInvalid) {
				errs <- fmt.Errorf("org write %d: %w", index, err)
			}
		}()
	}
	wait.Wait()
	close(errs)
	for err := range errs {
		t.Error(err)
	}
	// Deleting the department while messages mention it keeps them readable.
	if err := org.DeleteDepartment(ctx, owner, w.hallID, ""); err != nil {
		t.Fatal(err)
	}
	page, err := w.service.List(ctx, w.carol, w.chatID, ListOptions{})
	if err != nil || len(page.Messages) != 8 {
		t.Fatalf("messages = %d err = %v", len(page.Messages), err)
	}
	// A new mention of the deleted department is refused.
	if _, err := w.send(t, w.author, nil, []string{w.hallID}); !errors.Is(err, ErrInvalid) {
		t.Fatalf("deleted department: err = %v", err)
	}
}
