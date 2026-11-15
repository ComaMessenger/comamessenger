package workspace

import (
	"context"
	"errors"
	"sync"
	"testing"

	"github.com/comamessenger/comamessenger/core/internal/chat"
	"github.com/comamessenger/comamessenger/core/internal/orgstructure"
)

func orgUpdatedEvents(t *testing.T, f delegationFixture) int {
	t.Helper()
	var count int
	if err := f.service.repository.pool.QueryRow(context.Background(), `SELECT count(*) FROM events WHERE org_id=$1 AND type='org.updated'`, f.owner.OrgID).Scan(&count); err != nil {
		t.Fatal(err)
	}
	return count
}

// Decision 13: a deactivated person stays in the structure hidden, and the
// change of status is an org.updated when the person is in the structure.
func TestDeactivationUpdatesTheOrgStructure(t *testing.T) {
	f := newDelegationFixture(t)
	ctx := t.Context()
	pool := f.service.repository.pool
	var woken []int64
	f.service.SetAfterCommit(func(_ string, seq int64) { woken = append(woken, seq) })
	org := orgstructure.NewService(pool, chat.NewService(pool), nil)
	department, err := org.CreateDepartment(ctx, f.owner, orgstructure.CreateDepartmentInput{Name: "Зал ЛФК", LeadActorID: &f.memberID})
	if err != nil {
		t.Fatal(err)
	}
	deactivated, active := "deactivated", "active"

	// The colleague administrator has no assignment: no event.
	events := orgUpdatedEvents(t, f)
	if _, err := f.service.UpdateMember(ctx, f.owner, f.colleague.ActorID, UpdateMemberInput{Status: &deactivated}); err != nil {
		t.Fatal(err)
	}
	if got := orgUpdatedEvents(t, f); got != events {
		t.Fatalf("org.updated without assignment: %d -> %d", events, got)
	}

	// The lead and member of the department: one event each way.
	if _, err := f.service.UpdateMember(ctx, f.admin, f.memberID, UpdateMemberInput{Status: &deactivated}); err != nil {
		t.Fatal(err)
	}
	if got := orgUpdatedEvents(t, f); got != events+1 || len(woken) != 1 {
		t.Fatalf("org.updated after deactivation: %d -> %d, woken %v", events, got, woken)
	}
	structure, err := org.Structure(ctx, f.owner)
	if err != nil {
		t.Fatal(err)
	}
	if len(structure.People) != 0 || structure.Departments[0].LeadActorID != nil {
		t.Fatalf("deactivated person visible: %+v", structure)
	}
	if _, err := f.service.UpdateMember(ctx, f.admin, f.memberID, UpdateMemberInput{Status: &active}); err != nil {
		t.Fatal(err)
	}
	if got := orgUpdatedEvents(t, f); got != events+2 {
		t.Fatalf("org.updated after reactivation: %d", got)
	}
	structure, err = org.Structure(ctx, f.owner)
	if err != nil {
		t.Fatal(err)
	}
	if len(structure.People) != 1 || structure.People[0].PrimaryDepartmentID == nil || *structure.People[0].PrimaryDepartmentID != department.Department.ID ||
		structure.Departments[0].LeadActorID == nil || *structure.Departments[0].LeadActorID != f.memberID {
		t.Fatalf("not restored: %+v", structure)
	}
	// A role-only change is not a status change: no event.
	member := "member"
	if _, err := f.service.UpdateMember(ctx, f.owner, f.memberID, UpdateMemberInput{Role: &member}); err != nil {
		t.Fatal(err)
	}
	if got := orgUpdatedEvents(t, f); got != events+2 {
		t.Fatalf("org.updated after a no-op role change: %d", got)
	}
}

// Deactivation (member row, then organization row) against org writes that
// change the same person's row: both orders end without a deadlock error.
func TestDeactivationAgainstOrgWrites(t *testing.T) {
	f := newDelegationFixture(t)
	ctx := t.Context()
	pool := f.service.repository.pool
	org := orgstructure.NewService(pool, chat.NewService(pool), nil)
	department, err := org.CreateDepartment(ctx, f.owner, orgstructure.CreateDepartmentInput{Name: "Зал ЛФК", Members: []orgstructure.MemberInput{{ActorID: f.memberID, Primary: true}}})
	if err != nil {
		t.Fatal(err)
	}
	position, err := org.CreatePosition(ctx, f.owner, orgstructure.CreatePositionInput{Name: "Инструктор"})
	if err != nil {
		t.Fatal(err)
	}
	for round := 0; round < 10; round++ {
		status := "deactivated"
		if round%2 == 1 {
			status = "active"
		}
		var wg sync.WaitGroup
		errs := make([]error, 2)
		wg.Add(2)
		go func() {
			defer wg.Done()
			_, errs[0] = f.service.UpdateMember(ctx, f.owner, f.memberID, UpdateMemberInput{Status: &status})
		}()
		go func() {
			defer wg.Done()
			var positionID *string
			if round%3 != 0 {
				positionID = &position.Position.ID
			}
			_, errs[1] = org.SetPerson(ctx, f.admin, f.memberID, orgstructure.SetPersonInput{PrimaryDepartmentID: &department.Department.ID, PositionID: positionID})
			if errors.Is(errs[1], orgstructure.ErrInvalid) {
				errs[1] = nil // the person was already deactivated: refused, not deadlocked
			}
		}()
		wg.Wait()
		for _, err := range errs {
			if err != nil {
				t.Fatalf("round %d: %v", round, err)
			}
		}
	}
}
