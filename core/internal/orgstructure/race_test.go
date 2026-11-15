package orgstructure

import (
	"context"
	"errors"
	"sync"
	"testing"
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
