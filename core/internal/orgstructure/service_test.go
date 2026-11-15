package orgstructure

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"testing"

	"github.com/comamessenger/comamessenger/core/internal/identity"
	"github.com/google/uuid"
)

func TestWritesNeedOrgManageOrMembersManage(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	hall := f.department("Зал ЛФК", nil, primary(f.staff[0].ActorID))
	position, err := f.service.CreatePosition(ctx, f.hr, CreatePositionInput{Name: "Инструктор"})
	if err != nil {
		t.Fatal(err)
	}
	before := f.orgVersion()
	plain := f.staff[1]
	writes := map[string]func(identity.User) error{
		"createDepartment": func(u identity.User) error {
			_, err := f.service.CreateDepartment(ctx, u, CreateDepartmentInput{Name: "Новый"})
			return err
		},
		"updateDepartment": func(u identity.User) error {
			_, err := f.service.UpdateDepartment(ctx, u, hall.ID, UpdateDepartmentInput{Name: ptr("Зал"), ExpectedVersion: hall.Version})
			return err
		},
		"moveDepartment": func(u identity.User) error {
			_, err := f.service.MoveDepartment(ctx, u, hall.ID, MoveDepartmentInput{Direction: "down"})
			return err
		},
		"deleteDepartment": func(u identity.User) error { return f.service.DeleteDepartment(ctx, u, hall.ID, "") },
		"setDepartmentMember": func(u identity.User) error {
			_, err := f.service.SetDepartmentMember(ctx, u, hall.ID, plain.ActorID, SetDepartmentMemberInput{Primary: true})
			return err
		},
		"removeDepartmentMember": func(u identity.User) error {
			return f.service.RemoveDepartmentMember(ctx, u, hall.ID, f.staff[0].ActorID)
		},
		"setPersonOrg": func(u identity.User) error {
			_, err := f.service.SetPerson(ctx, u, plain.ActorID, SetPersonInput{PrimaryDepartmentID: &hall.ID})
			return err
		},
		"assignPeopleOrg": func(u identity.User) error {
			_, err := f.service.AssignPeople(ctx, u, AssignPeopleInput{ActorIDs: []string{plain.ActorID}, PrimaryDepartmentID: &hall.ID})
			return err
		},
		"createPosition": func(u identity.User) error {
			_, err := f.service.CreatePosition(ctx, u, CreatePositionInput{Name: "Врач"})
			return err
		},
		"createPositions": func(u identity.User) error {
			_, err := f.service.CreatePositions(ctx, u, CreatePositionsInput{Names: []string{"Врач"}})
			return err
		},
		"updatePosition": func(u identity.User) error {
			_, err := f.service.UpdatePosition(ctx, u, position.Position.ID, UpdatePositionInput{Name: ptr("Тренер"), ExpectedVersion: 1})
			return err
		},
		"deletePosition": func(u identity.User) error { return f.service.DeletePosition(ctx, u, position.Position.ID) },
		"titleSuggestions": func(u identity.User) error {
			_, err := f.service.TitleSuggestions(ctx, u)
			return err
		},
		"createDepartmentChat": func(u identity.User) error {
			_, err := f.service.CreateDepartmentChat(ctx, u, hall.ID)
			return err
		},
		"linkDepartmentChat": func(u identity.User) error {
			_, err := f.service.LinkDepartmentChat(ctx, u, hall.ID, LinkDepartmentChatInput{ChatID: uuid.NewString()})
			return err
		},
		"unlinkDepartmentChat": func(u identity.User) error { return f.service.UnlinkDepartmentChat(ctx, u, hall.ID) },
		"listDepartmentChatMissing": func(u identity.User) error {
			_, err := f.service.DepartmentChatMissing(ctx, u, hall.ID)
			return err
		},
		"addDepartmentChatMissing": func(u identity.User) error {
			_, err := f.service.AddDepartmentChatMissing(ctx, u, hall.ID)
			return err
		},
	}
	for name, write := range writes {
		for _, refused := range []identity.User{plain, f.auditor} {
			if err := write(refused); !errors.Is(err, ErrForbidden) {
				t.Errorf("%s by %s: error = %v, want ErrForbidden", name, refused.OrgRole, err)
			}
		}
	}
	if after := f.orgVersion(); after != before {
		t.Fatalf("refused writes changed org_version %d -> %d", before, after)
	}
	// A person with only a stale session-level permission is refused by the
	// stored state too: the service re-reads the caller inside the write.
	deactivatedHR := f.hr
	f.exec(`DELETE FROM actor_permissions WHERE actor_id=$1`, f.hr.ActorID)
	f.exec(`UPDATE actors SET status='deactivated' WHERE id=$1`, f.hr.ActorID)
	if _, err := f.service.CreateDepartment(ctx, deactivatedHR, CreateDepartmentInput{Name: "Тайный"}); !errors.Is(err, ErrForbidden) {
		t.Fatalf("deactivated manager error = %v", err)
	}
	f.exec(`UPDATE actors SET status='active' WHERE id=$1`, f.hr.ActorID)
	f.exec(`INSERT INTO actor_permissions(org_id,actor_id,permission) VALUES($1,$2,'org.manage')`, f.orgID, f.hr.ActorID)
	// members.manage covers org.manage; the owner can do everything.
	for _, allowed := range []identity.User{f.admin, f.owner, f.hr} {
		if _, err := f.service.CreateDepartment(ctx, allowed, CreateDepartmentInput{Name: "Отдел " + allowed.ActorID[:8]}); err != nil {
			t.Fatalf("create by %s: %v", allowed.OrgRole, err)
		}
	}
	// Agents never read the structure.
	agent := identity.User{ActorID: f.agentID, OrgID: f.orgID, OrgRole: "member"}
	if _, err := f.service.Structure(ctx, agent); !errors.Is(err, ErrForbidden) {
		t.Fatalf("agent read error = %v", err)
	}
	if _, err := f.service.Structure(ctx, plain); err != nil {
		t.Fatalf("plain member read: %v", err)
	}
}

func TestCyclesDepthNamesAndLimits(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	root := f.department("Реабилитация", nil)
	child := f.department("Зал ЛФК", &root.ID)
	grandchild := f.department("Утро", &child.ID)

	// Itself and a descendant as the parent are cycles.
	for _, parent := range []string{root.ID, child.ID, grandchild.ID} {
		_, err := f.service.UpdateDepartment(ctx, f.hr, root.ID, UpdateDepartmentInput{ParentID: OptionalID{Set: true, Value: &parent}, ExpectedVersion: root.Version})
		wantErr(t, err, ErrCycle)
	}
	// Names are unique among siblings ignoring case, not across levels.
	_, err := f.service.CreateDepartment(ctx, f.hr, CreateDepartmentInput{Name: "  зал лфк ", ParentID: &root.ID})
	wantErr(t, err, ErrNameTaken)
	if _, err := f.service.CreateDepartment(ctx, f.hr, CreateDepartmentInput{Name: "Зал ЛФК"}); err != nil {
		t.Fatalf("same name at another level: %v", err)
	}
	_, err = f.service.CreateDepartment(ctx, f.hr, CreateDepartmentInput{Name: "   "})
	wantErr(t, err, ErrInvalid)
	_, err = f.service.CreateDepartment(ctx, f.hr, CreateDepartmentInput{Name: string(make([]rune, 61))})
	wantErr(t, err, ErrInvalid)

	// Depth: 8 levels, the 9th is refused, also by moving a subtree.
	parent := grandchild.ID
	for level := 4; level <= MaxDepth; level++ {
		parent = f.department(fmt.Sprintf("Уровень %d", level), &parent).ID
	}
	_, err = f.service.CreateDepartment(ctx, f.hr, CreateDepartmentInput{Name: "Слишком глубоко", ParentID: &parent})
	wantErr(t, err, ErrDepthExceeded)
	other := f.department("Отдельно", nil)
	sub := f.department("Под отдельным", &other.ID)
	_ = sub
	current := mustDepartment(t, f, other.ID)
	_, err = f.service.UpdateDepartment(ctx, f.hr, other.ID, UpdateDepartmentInput{ParentID: OptionalID{Set: true, Value: &parent}, ExpectedVersion: current.Version})
	wantErr(t, err, ErrDepthExceeded)

	// A stale version is a conflict.
	_, err = f.service.UpdateDepartment(ctx, f.hr, root.ID, UpdateDepartmentInput{Name: ptr("Новое"), ExpectedVersion: root.Version + 5})
	wantErr(t, err, ErrVersionConflict)

	// Limits: 500 departments and 300 positions per workspace.
	f.exec(`INSERT INTO departments(org_id,id,name) SELECT $1, gen_random_uuid(), 'Заполнение '||g FROM generate_series(1, $2::int) g`, f.orgID, MaxDepartments-countDepartments(t, f))
	_, err = f.service.CreateDepartment(ctx, f.hr, CreateDepartmentInput{Name: "Пятьсот первый"})
	wantErr(t, err, ErrLimitReached)
	var detailed *Error
	if !errors.As(err, &detailed) || detailed.Limit != "departments" {
		t.Fatalf("limit details = %#v", detailed)
	}
	f.exec(`INSERT INTO positions(org_id,id,name) SELECT $1, gen_random_uuid(), 'Должность '||g FROM generate_series(1, 299) g`, f.orgID)
	if _, err := f.service.CreatePosition(ctx, f.hr, CreatePositionInput{Name: "Последняя"}); err != nil {
		t.Fatal(err)
	}
	_, err = f.service.CreatePosition(ctx, f.hr, CreatePositionInput{Name: "Лишняя"})
	wantErr(t, err, ErrLimitReached)
	_, err = f.service.CreatePosition(ctx, f.hr, CreatePositionInput{Name: "должность 1"})
	wantErr(t, err, ErrLimitReached)
}

func mustDepartment(t *testing.T, f *fixture, departmentID string) Department {
	t.Helper()
	department, ok := departmentOf(f.structure(f.hr), departmentID)
	if !ok {
		t.Fatalf("department %s not found", departmentID)
	}
	return department
}

func countDepartments(t *testing.T, f *fixture) int {
	t.Helper()
	var count int
	if err := f.pool.QueryRow(context.Background(), `SELECT count(*) FROM departments WHERE org_id=$1`, f.orgID).Scan(&count); err != nil {
		t.Fatal(err)
	}
	return count
}

func TestAdditionalDepartmentLimit(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	person := f.staff[0].ActorID
	home := f.department("Дом", nil, primary(person))
	ids := []string{}
	for index := 0; index < MaxAdditionalDepartments; index++ {
		ids = append(ids, f.department(fmt.Sprintf("Совмещение %d", index), nil, additional(person)).ID)
	}
	extra := f.department("Ещё одно", nil)
	_, err := f.service.SetDepartmentMember(ctx, f.hr, extra.ID, person, SetDepartmentMemberInput{})
	wantErr(t, err, ErrLimitReached)
	// Moving the primary department while keeping the previous one would
	// make 11 additional ones.
	_, err = f.service.SetDepartmentMember(ctx, f.hr, extra.ID, person, SetDepartmentMemberInput{Primary: true, KeepPrevious: true})
	wantErr(t, err, ErrLimitReached)
	// Without keeping it, it is fine.
	written, err := f.service.SetDepartmentMember(ctx, f.hr, extra.ID, person, SetDepartmentMemberInput{Primary: true})
	if err != nil {
		t.Fatal(err)
	}
	if *written.Person.PrimaryDepartmentID != extra.ID || len(written.Person.AdditionalDepartmentIDs) != MaxAdditionalDepartments || slices.Contains(written.Person.AdditionalDepartmentIDs, home.ID) {
		t.Fatalf("person = %+v", written.Person)
	}
	_, err = f.service.SetPerson(ctx, f.hr, person, SetPersonInput{PrimaryDepartmentID: &home.ID, AdditionalDepartmentIDs: append(ids, extra.ID)})
	wantErr(t, err, ErrLimitReached)
}

func TestMembershipInvariants(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	anna, boris := f.staff[0].ActorID, f.staff[1].ActorID
	reception := f.department("Ресепшн", nil, primary(anna))
	hall := f.department("Зал ЛФК", nil)

	// An additional department for a person without one becomes primary.
	written, err := f.service.SetDepartmentMember(ctx, f.hr, hall.ID, boris, SetDepartmentMemberInput{})
	if err != nil {
		t.Fatal(err)
	}
	if written.Person.PrimaryDepartmentID == nil || *written.Person.PrimaryDepartmentID != hall.ID {
		t.Fatalf("first membership not primary: %+v", written.Person)
	}
	// keep_previous keeps the old primary as additional.
	written, err = f.service.SetDepartmentMember(ctx, f.hr, hall.ID, anna, SetDepartmentMemberInput{Primary: true, KeepPrevious: true})
	if err != nil {
		t.Fatal(err)
	}
	if *written.Person.PrimaryDepartmentID != hall.ID || !slices.Equal(written.Person.AdditionalDepartmentIDs, []string{reception.ID}) {
		t.Fatalf("keep_previous: %+v", written.Person)
	}
	// Turning the primary into additional promotes the oldest additional.
	written, err = f.service.SetDepartmentMember(ctx, f.hr, hall.ID, anna, SetDepartmentMemberInput{})
	if err != nil {
		t.Fatal(err)
	}
	if *written.Person.PrimaryDepartmentID != reception.ID || !slices.Equal(written.Person.AdditionalDepartmentIDs, []string{hall.ID}) {
		t.Fatalf("demote: %+v", written.Person)
	}
	// Removing the primary promotes the remaining additional.
	if err := f.service.RemoveDepartmentMember(ctx, f.hr, reception.ID, anna); err != nil {
		t.Fatal(err)
	}
	person, _ := personOf(f.structure(f.hr), anna)
	if person.PrimaryDepartmentID == nil || *person.PrimaryDepartmentID != hall.ID || len(person.AdditionalDepartmentIDs) != 0 {
		t.Fatalf("after removal: %+v", person)
	}
	// Removing a non-member changes nothing.
	before := f.orgVersion()
	if err := f.service.RemoveDepartmentMember(ctx, f.hr, reception.ID, anna); err != nil {
		t.Fatal(err)
	}
	if f.orgVersion() != before {
		t.Fatal("no-op removal raised the version")
	}

	// A lead outside the department becomes an additional member; a lead
	// who leaves the department is cleared.
	current := mustDepartment(t, f, reception.ID)
	updated, err := f.service.UpdateDepartment(ctx, f.hr, reception.ID, UpdateDepartmentInput{LeadActorID: OptionalID{Set: true, Value: &boris}, ExpectedVersion: current.Version})
	if err != nil {
		t.Fatal(err)
	}
	if updated.Department.LeadActorID == nil || *updated.Department.LeadActorID != boris {
		t.Fatalf("lead = %+v", updated.Department)
	}
	person, _ = personOf(f.structure(f.hr), boris)
	if *person.PrimaryDepartmentID != hall.ID || !slices.Equal(person.AdditionalDepartmentIDs, []string{reception.ID}) {
		t.Fatalf("lead membership: %+v", person)
	}
	if err := f.service.RemoveDepartmentMember(ctx, f.hr, reception.ID, boris); err != nil {
		t.Fatal(err)
	}
	if lead := mustDepartment(t, f, reception.ID).LeadActorID; lead != nil {
		t.Fatalf("lead kept after leaving: %v", *lead)
	}
	// Moving the primary away from a department one leads also clears it.
	current = mustDepartment(t, f, hall.ID)
	if _, err := f.service.UpdateDepartment(ctx, f.hr, hall.ID, UpdateDepartmentInput{LeadActorID: OptionalID{Set: true, Value: &boris}, ExpectedVersion: current.Version}); err != nil {
		t.Fatal(err)
	}
	if _, err := f.service.SetDepartmentMember(ctx, f.hr, reception.ID, boris, SetDepartmentMemberInput{Primary: true}); err != nil {
		t.Fatal(err)
	}
	if lead := mustDepartment(t, f, hall.ID).LeadActorID; lead != nil {
		t.Fatal("lead kept after the primary department moved")
	}

	// Agents and deactivated people are not people of the structure.
	for _, actorID := range []string{f.agentID, f.formerID, uuid.NewString()} {
		_, err := f.service.SetDepartmentMember(ctx, f.hr, hall.ID, actorID, SetDepartmentMemberInput{Primary: true})
		wantErr(t, err, ErrInvalid)
		var detailed *Error
		if !errors.As(err, &detailed) || detailed.Field != "actor_id" {
			t.Fatalf("field = %#v", detailed)
		}
		_, err = f.service.CreateDepartment(ctx, f.hr, CreateDepartmentInput{Name: "С агентом", Members: []MemberInput{primary(actorID)}})
		wantErr(t, err, ErrInvalid)
	}
	_, err = f.service.SetPerson(ctx, f.hr, anna, SetPersonInput{AdditionalDepartmentIDs: []string{hall.ID}})
	wantErr(t, err, ErrInvalid)
	_, err = f.service.SetPerson(ctx, f.hr, anna, SetPersonInput{PrimaryDepartmentID: &hall.ID, AdditionalDepartmentIDs: []string{hall.ID}})
	wantErr(t, err, ErrInvalid)
	_, err = f.service.SetPerson(ctx, f.hr, anna, SetPersonInput{PrimaryDepartmentID: ptr(uuid.NewString())})
	wantErr(t, err, ErrDepartmentNotFound)
	_, err = f.service.SetPerson(ctx, f.hr, anna, SetPersonInput{PositionID: ptr(uuid.NewString())})
	wantErr(t, err, ErrPositionNotFound)
	if _, err := f.pool.Exec(ctx, `UPDATE actors SET position_id=(SELECT id FROM positions LIMIT 1) WHERE id=$1`, f.agentID); err == nil {
		// No positions exist: the update is a no-op either way; the CHECK
		// is exercised below with a real position.
	}
	position, err := f.service.CreatePosition(ctx, f.hr, CreatePositionInput{Name: "Инструктор"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.pool.Exec(ctx, `UPDATE actors SET position_id=$2 WHERE id=$1`, f.agentID, position.Position.ID); err == nil {
		t.Fatal("an agent got a position")
	}
}

func TestSetPersonAndAssignPeople(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	hall := f.department("Зал ЛФК", nil)
	pool := f.department("Бассейн", nil)
	office := f.department("Офис", nil)
	position, err := f.service.CreatePosition(ctx, f.hr, CreatePositionInput{Name: "Инструктор"})
	if err != nil {
		t.Fatal(err)
	}
	anna := f.staff[0].ActorID
	version := f.orgVersion()
	written, err := f.service.SetPerson(ctx, f.hr, anna, SetPersonInput{PrimaryDepartmentID: &hall.ID, AdditionalDepartmentIDs: []string{pool.ID, office.ID}, PositionID: &position.Position.ID, ExpectedOrgVersion: &version})
	if err != nil {
		t.Fatal(err)
	}
	if written.Version != version+1 || *written.Person.PrimaryDepartmentID != hall.ID || !slices.Equal(written.Person.AdditionalDepartmentIDs, []string{pool.ID, office.ID}) || *written.Person.PositionID != position.Position.ID {
		t.Fatalf("set person = %+v", written)
	}
	// The stale version is refused.
	_, err = f.service.SetPerson(ctx, f.hr, anna, SetPersonInput{ExpectedOrgVersion: &version})
	wantErr(t, err, ErrVersionConflict)
	// Swapping primary and additional keeps the membership age.
	written, err = f.service.SetPerson(ctx, f.hr, anna, SetPersonInput{PrimaryDepartmentID: &office.ID, AdditionalDepartmentIDs: []string{hall.ID}, PositionID: nil})
	if err != nil {
		t.Fatal(err)
	}
	if *written.Person.PrimaryDepartmentID != office.ID || !slices.Equal(written.Person.AdditionalDepartmentIDs, []string{hall.ID}) || written.Person.PositionID != nil {
		t.Fatalf("swap = %+v", written.Person)
	}
	// Same assignment again: no new version.
	again, err := f.service.SetPerson(ctx, f.hr, anna, SetPersonInput{PrimaryDepartmentID: &office.ID, AdditionalDepartmentIDs: []string{hall.ID}})
	if err != nil {
		t.Fatal(err)
	}
	if again.Version != written.Version {
		t.Fatalf("no-op set person raised the version %d -> %d", written.Version, again.Version)
	}

	// Mass assignment: one version step and one event for 6 people.
	events := len(f.orgEvents())
	before := f.orgVersion()
	ids := []string{}
	for _, person := range f.staff {
		ids = append(ids, person.ActorID)
	}
	result, err := f.service.AssignPeople(ctx, f.hr, AssignPeopleInput{ActorIDs: ids, PrimaryDepartmentID: &pool.ID, AddDepartmentID: &hall.ID, PositionID: OptionalID{Set: true, Value: &position.Position.ID}})
	if err != nil {
		t.Fatal(err)
	}
	if result.Version != before+1 || len(f.orgEvents()) != events+1 || len(result.People) != len(ids) {
		t.Fatalf("assign: version %d (before %d), events %d -> %d, people %d", result.Version, before, events, len(f.orgEvents()), len(result.People))
	}
	for _, person := range result.People {
		if *person.PrimaryDepartmentID != pool.ID || !slices.Contains(person.AdditionalDepartmentIDs, hall.ID) || *person.PositionID != position.Position.ID {
			t.Fatalf("assigned person = %+v", person)
		}
	}
	// add_department_id never demotes a primary department; position null clears.
	result, err = f.service.AssignPeople(ctx, f.hr, AssignPeopleInput{ActorIDs: ids[:1], AddDepartmentID: &pool.ID, PositionID: OptionalID{Set: true}})
	if err != nil {
		t.Fatal(err)
	}
	if *result.People[0].PrimaryDepartmentID != pool.ID || result.People[0].PositionID != nil {
		t.Fatalf("add own primary = %+v", result.People[0])
	}
	_, err = f.service.AssignPeople(ctx, f.hr, AssignPeopleInput{ActorIDs: []string{anna, f.agentID}, PrimaryDepartmentID: &hall.ID})
	wantErr(t, err, ErrInvalid)
	_, err = f.service.AssignPeople(ctx, f.hr, AssignPeopleInput{ActorIDs: []string{anna}})
	wantErr(t, err, ErrInvalid)
	tooMany := make([]string, MaxAssignPeople+1)
	for index := range tooMany {
		tooMany[index] = uuid.NewString()
	}
	_, err = f.service.AssignPeople(ctx, f.hr, AssignPeopleInput{ActorIDs: tooMany, PrimaryDepartmentID: &hall.ID})
	wantErr(t, err, ErrInvalid)
}

func TestDeleteDepartmentMovesPeopleAndSubdepartments(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	anna, boris, vera, gleb := f.staff[0].ActorID, f.staff[1].ActorID, f.staff[2].ActorID, f.staff[3].ActorID
	root := f.department("Реабилитация", nil)
	hall := f.department("Зал ЛФК", &root.ID, primary(anna), primary(boris), additional(vera))
	f.department("Утро", &hall.ID)
	f.department("Утро", &root.ID) // the lifted «Утро» must get another name
	office := f.department("Офис", nil, primary(vera))
	if _, err := f.service.SetDepartmentMember(ctx, f.hr, office.ID, boris, SetDepartmentMemberInput{}); err != nil {
		t.Fatal(err)
	}

	// Default: primary members go to the parent.
	if err := f.service.DeleteDepartment(ctx, f.hr, hall.ID, ""); err != nil {
		t.Fatal(err)
	}
	structure := f.structure(f.hr)
	if _, ok := departmentOf(structure, hall.ID); ok {
		t.Fatal("department not deleted")
	}
	for _, actorID := range []string{anna, boris} {
		person, _ := personOf(structure, actorID)
		if person.PrimaryDepartmentID == nil || *person.PrimaryDepartmentID != root.ID {
			t.Fatalf("%s not moved to the parent: %+v", actorID, person)
		}
	}
	person, _ := personOf(structure, vera)
	if *person.PrimaryDepartmentID != office.ID || len(person.AdditionalDepartmentIDs) != 0 {
		t.Fatalf("additional membership not dropped: %+v", person)
	}
	names := []string{}
	for _, department := range structure.Departments {
		if department.ParentID != nil && *department.ParentID == root.ID {
			names = append(names, department.Name)
		}
	}
	slices.Sort(names)
	if !slices.Equal(names, []string{"Утро", "Утро (2)"}) {
		t.Fatalf("lifted subdepartments = %v", names)
	}

	// members_to=none: the oldest additional becomes primary, else nothing.
	if err := f.service.DeleteDepartment(ctx, f.hr, root.ID, "none"); err != nil {
		t.Fatal(err)
	}
	structure = f.structure(f.hr)
	if person, ok := personOf(structure, anna); ok {
		t.Fatalf("anna kept a department: %+v", person)
	}
	person, _ = personOf(structure, boris)
	if person.PrimaryDepartmentID == nil || *person.PrimaryDepartmentID != office.ID {
		t.Fatalf("boris oldest additional not promoted: %+v", person)
	}

	// members_to=<id>: an explicit target; invalid targets are refused.
	sport := f.department("Спорт", nil, primary(gleb))
	inner := f.department("Внутри", &sport.ID)
	for _, target := range []string{sport.ID, inner.ID, uuid.NewString(), "garbage"} {
		err := f.service.DeleteDepartment(ctx, f.hr, sport.ID, target)
		wantErr(t, err, ErrInvalid)
	}
	if err := f.service.DeleteDepartment(ctx, f.hr, sport.ID, office.ID); err != nil {
		t.Fatal(err)
	}
	person, _ = personOf(f.structure(f.hr), gleb)
	if *person.PrimaryDepartmentID != office.ID {
		t.Fatalf("gleb not moved to members_to: %+v", person)
	}
	err := f.service.DeleteDepartment(ctx, f.hr, sport.ID, "")
	wantErr(t, err, ErrDepartmentNotFound)
}

func TestOrgVersionAndEvents(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	start := f.orgVersion()
	hall := f.department("Зал ЛФК", nil, primary(f.staff[0].ActorID), additional(f.staff[1].ActorID))
	if got := f.orgVersion(); got != start+1 {
		t.Fatalf("create with members raised the version by %d", got-start)
	}
	events := f.orgEvents()
	if len(events) != 1 || events[0].Version != start+1 || events[0].Reason != ReasonDepartment {
		t.Fatalf("events = %+v", events)
	}
	// Moving the only department changes nothing.
	moved, err := f.service.MoveDepartment(ctx, f.hr, hall.ID, MoveDepartmentInput{Direction: "up"})
	if err != nil {
		t.Fatal(err)
	}
	if moved.Version != start+1 || len(f.orgEvents()) != 1 {
		t.Fatal("no-op move raised the version")
	}
	position, err := f.service.CreatePosition(ctx, f.hr, CreatePositionInput{Name: "Врач"})
	if err != nil {
		t.Fatal(err)
	}
	if position.Version != start+2 || f.orgEvents()[1].Reason != ReasonPosition {
		t.Fatalf("position write = %+v, events %+v", position, f.orgEvents())
	}
	if len(f.wakeup) != 2 {
		t.Fatalf("dispatcher woken %d times", len(f.wakeup))
	}
	var audits int
	if err := f.pool.QueryRow(ctx, `SELECT count(*) FROM audit_log WHERE org_id=$1 AND action LIKE 'org.%'`, f.orgID).Scan(&audits); err != nil {
		t.Fatal(err)
	}
	if audits != 2 {
		t.Fatalf("audit entries = %d", audits)
	}
}

func TestMoveDepartmentOrdersSiblings(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	b := f.department("Бассейн", nil)
	a := f.department("Администрация", nil)
	v := f.department("Вестибюль", nil)
	// By name: Администрация, Бассейн, Вестибюль. Move Вестибюль up.
	if _, err := f.service.MoveDepartment(ctx, f.hr, v.ID, MoveDepartmentInput{Direction: "up"}); err != nil {
		t.Fatal(err)
	}
	order := []string{}
	for _, department := range f.structure(f.hr).Departments {
		order = append(order, department.ID)
	}
	if !slices.Equal(order, []string{a.ID, v.ID, b.ID}) {
		t.Fatalf("order = %v", order)
	}
	// A new sibling goes last once the order is manual.
	z := f.department("Аптека", nil)
	order = order[:0]
	for _, department := range f.structure(f.hr).Departments {
		order = append(order, department.ID)
	}
	if !slices.Equal(order, []string{a.ID, v.ID, b.ID, z.ID}) {
		t.Fatalf("order after create = %v", order)
	}
	_, err := f.service.MoveDepartment(ctx, f.hr, a.ID, MoveDepartmentInput{Direction: "left"})
	wantErr(t, err, ErrInvalid)
}

func TestPositionsAndTitleSuggestions(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	f.exec(`UPDATE actors SET title='Инструктор' WHERE id = ANY($1::uuid[])`, []string{f.staff[0].ActorID, f.staff[1].ActorID})
	f.exec(`UPDATE actors SET title='инструктор ' WHERE id=$1`, f.staff[2].ActorID)
	f.exec(`UPDATE actors SET title='Врач' WHERE id=$1`, f.staff[3].ActorID)
	f.exec(`UPDATE actors SET title='Врач' WHERE id=$1`, f.formerID)
	suggestions, err := f.service.TitleSuggestions(ctx, f.hr)
	if err != nil {
		t.Fatal(err)
	}
	if len(suggestions.Suggestions) != 2 || suggestions.Suggestions[0].Title != "Инструктор" || suggestions.Suggestions[0].Count != 3 || suggestions.Suggestions[1].Count != 1 {
		t.Fatalf("suggestions = %+v", suggestions)
	}
	created, err := f.service.CreatePositions(ctx, f.hr, CreatePositionsInput{Names: []string{"Инструктор", "ВРАЧ", "врач", "Администратор"}})
	if err != nil {
		t.Fatal(err)
	}
	if len(created.Created) != 3 || !slices.Equal(created.Skipped, []string{"врач"}) {
		t.Fatalf("bulk = %+v", created)
	}
	again, err := f.service.CreatePositions(ctx, f.hr, CreatePositionsInput{Names: []string{"инструктор"}})
	if err != nil {
		t.Fatal(err)
	}
	if len(again.Created) != 0 || again.Version != created.Version {
		t.Fatalf("all skipped = %+v", again)
	}
	suggestions, err = f.service.TitleSuggestions(ctx, f.hr)
	if err != nil {
		t.Fatal(err)
	}
	if len(suggestions.Suggestions) != 0 {
		t.Fatalf("suggestions after creation = %+v", suggestions)
	}
	var instructor Position
	for _, position := range created.Created {
		if position.Name == "Инструктор" {
			instructor = position
		}
	}
	if _, err := f.service.AssignPeople(ctx, f.hr, AssignPeopleInput{ActorIDs: []string{f.staff[0].ActorID}, PositionID: OptionalID{Set: true, Value: &instructor.ID}}); err != nil {
		t.Fatal(err)
	}
	_, err = f.service.UpdatePosition(ctx, f.hr, instructor.ID, UpdatePositionInput{Name: ptr("администратор"), ExpectedVersion: instructor.Version})
	wantErr(t, err, ErrNameTaken)
	renamed, err := f.service.UpdatePosition(ctx, f.hr, instructor.ID, UpdatePositionInput{Name: ptr("Инструктор ЛФК"), ExpectedVersion: instructor.Version})
	if err != nil {
		t.Fatal(err)
	}
	if renamed.Position.Version != instructor.Version+1 {
		t.Fatalf("renamed = %+v", renamed)
	}
	_, err = f.service.UpdatePosition(ctx, f.hr, instructor.ID, UpdatePositionInput{Name: ptr("Ещё"), ExpectedVersion: instructor.Version})
	wantErr(t, err, ErrVersionConflict)
	if err := f.service.DeletePosition(ctx, f.hr, instructor.ID); err != nil {
		t.Fatal(err)
	}
	if _, ok := personOf(f.structure(f.hr), f.staff[0].ActorID); ok {
		t.Fatal("position kept after deletion")
	}
	wantErr(t, f.service.DeletePosition(ctx, f.hr, instructor.ID), ErrPositionNotFound)
}

func TestExpand(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	anna, boris, vera, gleb, dina := f.staff[0].ActorID, f.staff[1].ActorID, f.staff[2].ActorID, f.staff[3].ActorID, f.staff[4].ActorID
	root := f.department("Реабилитация", nil, primary(anna))
	hall := f.department("Зал ЛФК", &root.ID, primary(boris), additional(anna))
	f.department("Утро", &hall.ID, primary(vera))
	other := f.department("Офис", nil, primary(gleb), additional(vera))
	f.exec(`INSERT INTO department_members(org_id,department_id,actor_id,is_primary) VALUES($1,$2,$3,true)`, f.orgID, hall.ID, f.formerID)
	position, err := f.service.CreatePosition(ctx, f.hr, CreatePositionInput{Name: "Врач"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.service.AssignPeople(ctx, f.hr, AssignPeopleInput{ActorIDs: []string{dina, gleb}, PositionID: OptionalID{Set: true, Value: &position.Position.ID}}); err != nil {
		t.Fatal(err)
	}
	f.exec(`UPDATE actors SET position_id=$2 WHERE id=$1`, f.formerID, position.Position.ID)

	everyone := []string{anna, boris, vera, gleb, dina, f.agentID, f.hr.ActorID}
	group, err := f.chats.Create(ctx, f.owner, chatInput("Все", everyone))
	if err != nil {
		t.Fatal(err)
	}
	// The deactivated person stays a chat member.
	f.exec(`INSERT INTO chat_members(chat_id,actor_id,org_id,role) VALUES($1,$2,$3,'member')`, group.ID, f.formerID, f.orgID)
	small, err := f.chats.Create(ctx, f.owner, chatInput("Двое", []string{boris, gleb}))
	if err != nil {
		t.Fatal(err)
	}
	sorted := func(values ...string) []string { slices.Sort(values); return values }

	got, err := Expand(ctx, f.pool, f.orgID, []string{root.ID}, nil, group.ID)
	if err != nil {
		t.Fatal(err)
	}
	// Nested and additional members, each once; the deactivated person is
	// left out.
	if want := sorted(anna, boris, vera); !slices.Equal(got, want) {
		t.Fatalf("root = %v, want %v", got, want)
	}
	got, _ = Expand(ctx, f.pool, f.orgID, []string{hall.ID, other.ID}, []string{position.Position.ID}, group.ID)
	if want := sorted(anna, boris, vera, gleb, dina); !slices.Equal(got, want) {
		t.Fatalf("hall+office+position = %v, want %v", got, want)
	}
	// Only people of the chat.
	got, _ = Expand(ctx, f.pool, f.orgID, []string{root.ID}, []string{position.Position.ID}, small.ID)
	if want := sorted(boris, gleb); !slices.Equal(got, want) {
		t.Fatalf("small chat = %v, want %v", got, want)
	}
	// Without a chat Expand refuses: the chat intersection is mandatory.
	if _, err := Expand(ctx, f.pool, f.orgID, []string{root.ID}, nil, ""); !errors.Is(err, ErrInvalid) {
		t.Fatalf("expand without chat error = %v", err)
	}
	// Another workspace's ids expand to nobody.
	got, _ = Expand(ctx, f.pool, uuid.NewString(), []string{root.ID}, nil, group.ID)
	if len(got) != 0 {
		t.Fatalf("foreign org = %v", got)
	}
	// A cycle written behind the service's back does not loop.
	f.exec(`UPDATE departments SET parent_id=$2 WHERE id=$1`, root.ID, hall.ID)
	got, err = Expand(ctx, f.pool, f.orgID, []string{root.ID}, nil, group.ID)
	if err != nil || !slices.Equal(got, sorted(anna, boris, vera)) {
		t.Fatalf("cyclic expand = %v, %v", got, err)
	}
}

func TestStructureVisibility(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	anna, boris := f.staff[0], f.staff[1]
	hall := f.department("Зал ЛФК", nil, primary(anna.ActorID), primary(boris.ActorID))
	current := mustDepartment(t, f, hall.ID)
	if _, err := f.service.UpdateDepartment(ctx, f.hr, hall.ID, UpdateDepartmentInput{LeadActorID: OptionalID{Set: true, Value: &anna.ActorID}, ExpectedVersion: current.Version}); err != nil {
		t.Fatal(err)
	}
	created, err := f.service.CreateDepartmentChat(ctx, anna, hall.ID)
	if err != nil {
		t.Fatal(err)
	}
	// boris is in the chat; the owner and an outsider are not.
	for viewer, want := range map[*identity.User]bool{&anna: true, &boris: true, &f.owner: false, &f.staff[2]: false} {
		department, _ := departmentOf(f.structure(*viewer), hall.ID)
		if !department.HasChat || (department.ChatID != nil) != want {
			t.Fatalf("viewer %s: department = %+v", viewer.ActorID, department)
		}
		if want && *department.ChatID != created.Chat.ID {
			t.Fatalf("chat id = %v", *department.ChatID)
		}
	}
	// The write responses follow the same rule: a manager outside the chat
	// never learns its id.
	written, err := f.service.UpdateDepartment(ctx, f.owner, hall.ID, UpdateDepartmentInput{Name: ptr("Зал"), ExpectedVersion: mustDepartment(t, f, hall.ID).Version})
	if err != nil {
		t.Fatal(err)
	}
	if written.Department.ChatID != nil || !written.Department.HasChat {
		t.Fatalf("manager outside the chat got %+v", written.Department)
	}
	moved, err := f.service.MoveDepartment(ctx, f.owner, hall.ID, MoveDepartmentInput{Direction: "up"})
	if err != nil || moved.Department.ChatID != nil {
		t.Fatalf("move response leaks chat: %+v %v", moved.Department, err)
	}
	// An archived chat shows as archived.
	if err := f.chats.Archive(ctx, anna, created.Chat.ID); err != nil {
		t.Fatal(err)
	}
	department, _ := departmentOf(f.structure(f.staff[2]), hall.ID)
	if !department.ChatArchived || department.ChatID != nil {
		t.Fatalf("archived = %+v", department)
	}
}

func chatInput(name string, members []string) chatCreateInput {
	return chatCreateInput{Kind: "group", Visibility: "private", Name: name, MemberIDs: members}
}
