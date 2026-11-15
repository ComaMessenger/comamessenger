package orgstructure

import (
	"context"
	"errors"
	"sync"
	"testing"

	"github.com/google/uuid"
)

// Concurrent writes serialize on the organization lock: no deadlock, no
// half-applied state, and a move against the reverse move never makes a
// cycle.
func TestConcurrentWritesDoNotDeadlock(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	ids := make([]string, 0, len(f.staff))
	for _, person := range f.staff {
		ids = append(ids, person.ActorID)
	}
	for round := 0; round < 5; round++ {
		root := f.department("Корень", nil)
		doomed := f.department("Удаляемый", &root.ID, primary(ids[0]), primary(ids[1]))
		target := f.department("Целевой", &root.ID)
		position, err := f.service.CreatePosition(ctx, f.hr, CreatePositionInput{Name: "Должность " + root.ID[:8]})
		if err != nil {
			t.Fatal(err)
		}
		var wg sync.WaitGroup
		errs := make(chan error, 8)
		run := func(fn func() error) {
			wg.Add(1)
			go func() {
				defer wg.Done()
				errs <- fn()
			}()
		}
		run(func() error { return f.service.DeleteDepartment(ctx, f.hr, doomed.ID, target.ID) })
		run(func() error {
			_, err := f.service.AssignPeople(ctx, f.admin, AssignPeopleInput{ActorIDs: ids, AddDepartmentID: &doomed.ID, PositionID: OptionalID{Set: true, Value: &position.Position.ID}})
			if errors.Is(err, ErrDepartmentNotFound) {
				return nil // lost the race to the delete: fine
			}
			return err
		})
		run(func() error {
			_, err := f.service.SetPerson(ctx, f.owner, ids[2], SetPersonInput{PrimaryDepartmentID: &target.ID, PositionID: &position.Position.ID})
			return err
		})
		run(func() error { return f.service.DeletePosition(ctx, f.hr, position.Position.ID) })
		wg.Wait()
		close(errs)
		for err := range errs {
			if err != nil && !errors.Is(err, ErrPositionNotFound) {
				t.Fatalf("round %d: %v", round, err)
			}
		}
		// Invariants after the race: one primary per person, additional only
		// next to a primary one, nobody in a deleted department.
		var broken int
		if err := f.pool.QueryRow(ctx, `
			SELECT count(*) FROM (
				SELECT actor_id FROM department_members WHERE org_id = $1
				GROUP BY actor_id HAVING count(*) FILTER (WHERE is_primary) <> 1
			) bad`, f.orgID).Scan(&broken); err != nil {
			t.Fatal(err)
		}
		if broken != 0 {
			t.Fatalf("round %d: %d people without exactly one primary department", round, broken)
		}
		if err := f.service.DeleteDepartment(ctx, f.hr, root.ID, "none"); err != nil {
			t.Fatal(err)
		}
		if err := f.service.DeleteDepartment(ctx, f.hr, target.ID, "none"); err != nil && !errors.Is(err, ErrDepartmentNotFound) {
			t.Fatal(err)
		}
	}
}

func TestReverseMovesNeverMakeACycle(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	for round := 0; round < 10; round++ {
		a := f.department("А", nil)
		b := f.department("Б", nil)
		var wg sync.WaitGroup
		results := make([]error, 2)
		for index, pair := range [][2]Department{{a, b}, {b, a}} {
			wg.Add(1)
			go func(index int, child, parent Department) {
				defer wg.Done()
				_, results[index] = f.service.UpdateDepartment(ctx, f.hr, child.ID, UpdateDepartmentInput{ParentID: OptionalID{Set: true, Value: &parent.ID}, ExpectedVersion: child.Version})
			}(index, pair[0], pair[1])
		}
		wg.Wait()
		succeeded := 0
		for _, err := range results {
			if err == nil {
				succeeded++
			} else if !errors.Is(err, ErrCycle) && !errors.Is(err, ErrVersionConflict) {
				t.Fatalf("round %d: %v", round, err)
			}
		}
		if succeeded != 1 {
			t.Fatalf("round %d: %d moves succeeded, want exactly one", round, succeeded)
		}
		var cyclic bool
		if err := f.pool.QueryRow(ctx, `
			SELECT EXISTS (SELECT 1 FROM departments x JOIN departments y ON x.parent_id = y.id AND y.parent_id = x.id WHERE x.org_id = $1)`, f.orgID).Scan(&cyclic); err != nil {
			t.Fatal(err)
		}
		if cyclic {
			t.Fatalf("round %d: a cycle was written", round)
		}
		for _, department := range []Department{a, b} {
			if err := f.service.DeleteDepartment(ctx, f.hr, department.ID, "none"); err != nil && !errors.Is(err, ErrDepartmentNotFound) {
				t.Fatal(err)
			}
		}
	}
}

// Review findings: rights are read from the database inside the write, a
// guessed chat id is not confirmed, and lifted names are found at once.
func TestReviewFindings(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	// org.manage revoked after the session was resolved.
	f.exec(`DELETE FROM actor_permissions WHERE actor_id=$1`, f.hr.ActorID)
	_, err := f.service.CreateDepartment(ctx, f.hr, CreateDepartmentInput{Name: "После отзыва"})
	wantErr(t, err, ErrForbidden)
	_, err = f.service.TitleSuggestions(ctx, f.hr)
	wantErr(t, err, ErrForbidden)
	f.exec(`INSERT INTO actor_permissions(org_id,actor_id,permission) VALUES($1,$2,'org.manage')`, f.orgID, f.hr.ActorID)

	anna := f.staff[0]
	hall := f.department("Зал", nil, primary(anna.ActorID))
	current := mustDepartment(t, f, hall.ID)
	if _, err := f.service.UpdateDepartment(ctx, f.hr, hall.ID, UpdateDepartmentInput{LeadActorID: OptionalID{Set: true, Value: &anna.ActorID}, ExpectedVersion: current.Version}); err != nil {
		t.Fatal(err)
	}
	secret, err := f.chats.Create(ctx, f.staff[1], chatInput("Закрытая", []string{f.staff[2].ActorID}))
	if err != nil {
		t.Fatal(err)
	}
	// The department chat is the secret group (linked by its owner via SQL).
	f.exec(`UPDATE departments SET chat_id=$2 WHERE id=$1`, hall.ID, secret.ID)
	// The lead outside the chat gets the same 422 for the real id and a
	// random one.
	for _, guess := range []string{secret.ID, uuid.NewString()} {
		_, err := f.service.LinkDepartmentChat(ctx, anna, hall.ID, LinkDepartmentChatInput{ChatID: guess})
		wantErr(t, err, ErrChatInvalid)
	}
	f.exec(`UPDATE departments SET chat_id=NULL WHERE id=$1`, hall.ID)

	// Lifting a subdepartment into a parent full of «Утро», «Утро (2)»…
	root := f.department("Корень", nil)
	inner := f.department("Середина", &root.ID)
	for _, name := range []string{"Утро", "Утро (2)", "Утро (3)"} {
		f.department(name, &root.ID)
	}
	f.department("утро", &inner.ID)
	if err := f.service.DeleteDepartment(ctx, f.hr, inner.ID, "none"); err != nil {
		t.Fatal(err)
	}
	found := false
	for _, department := range f.structure(f.hr).Departments {
		if department.Name == "утро (4)" {
			found = true
		}
	}
	if !found {
		t.Fatal("lifted department not renamed to «утро (4)»")
	}
}
