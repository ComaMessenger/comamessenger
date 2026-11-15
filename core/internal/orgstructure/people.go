package orgstructure

import (
	"context"
	"fmt"

	"github.com/comamessenger/comamessenger/core/internal/identity"
	"github.com/jackc/pgx/v5"
)

func (s *Service) SetDepartmentMember(ctx context.Context, user identity.User, departmentID, actorID string, input SetDepartmentMemberInput) (PersonWrite, error) {
	if err := validateID("actor_id", actorID); err != nil {
		return PersonWrite{}, err
	}
	var result PersonWrite
	version, err := s.write(ctx, user, writeOptions{lockActors: []string{actorID}}, func(ctx context.Context, tx pgx.Tx, work *change) error {
		row, err := lockDepartment(ctx, tx, user.OrgID, departmentID)
		if err != nil {
			return err
		}
		if err := requirePeople(ctx, tx, user.OrgID, []string{actorID}, "actor_id"); err != nil {
			return err
		}
		if err := setMembership(ctx, tx, work, user.OrgID, actorID, row.id, input.Primary, input.KeepPrevious); err != nil {
			return err
		}
		if work.changed {
			work.audit("org.member.set", "actor", actorID, map[string]any{"department_id": row.id, "primary": input.Primary, "keep_previous": input.KeepPrevious})
		}
		person, err := readPerson(ctx, tx, user.OrgID, actorID)
		result.Person = person
		return err
	})
	if err != nil {
		return PersonWrite{}, err
	}
	result.Version = version
	return result, nil
}

func (s *Service) RemoveDepartmentMember(ctx context.Context, user identity.User, departmentID, actorID string) error {
	if err := validateID("actor_id", actorID); err != nil {
		return err
	}
	_, err := s.write(ctx, user, writeOptions{lockActors: []string{actorID}}, func(ctx context.Context, tx pgx.Tx, work *change) error {
		row, err := lockDepartment(ctx, tx, user.OrgID, departmentID)
		if err != nil {
			return err
		}
		removed, err := removeMembership(ctx, tx, work, user.OrgID, actorID, row.id)
		if err != nil {
			return err
		}
		if removed {
			work.audit("org.member.remove", "actor", actorID, map[string]any{"department_id": row.id})
		}
		return nil
	})
	return err
}

// SetPerson replaces the whole assignment of one person.
func (s *Service) SetPerson(ctx context.Context, user identity.User, actorID string, input SetPersonInput) (PersonWrite, error) {
	if err := validateID("actor_id", actorID); err != nil {
		return PersonWrite{}, err
	}
	if input.AdditionalDepartmentIDs == nil {
		input.AdditionalDepartmentIDs = []string{}
	}
	if len(input.AdditionalDepartmentIDs) > MaxAdditionalDepartments {
		return PersonWrite{}, limitReached("additional_departments", "A person may have at most %d additional departments.", MaxAdditionalDepartments)
	}
	if input.PrimaryDepartmentID == nil && len(input.AdditionalDepartmentIDs) > 0 {
		return PersonWrite{}, invalid("additional_department_ids", "Additional departments need a primary department.")
	}
	seen := map[string]bool{}
	if input.PrimaryDepartmentID != nil {
		if err := validateID("primary_department_id", *input.PrimaryDepartmentID); err != nil {
			return PersonWrite{}, err
		}
		seen[*input.PrimaryDepartmentID] = true
	}
	for _, departmentID := range input.AdditionalDepartmentIDs {
		if err := validateID("additional_department_ids", departmentID); err != nil {
			return PersonWrite{}, err
		}
		if seen[departmentID] {
			return PersonWrite{}, invalid("additional_department_ids", "A department may be listed once and not next to the primary one.")
		}
		seen[departmentID] = true
	}
	if input.PositionID != nil {
		if err := validateID("position_id", *input.PositionID); err != nil {
			return PersonWrite{}, err
		}
	}
	var result PersonWrite
	version, err := s.write(ctx, user, writeOptions{lockActors: []string{actorID}}, func(ctx context.Context, tx pgx.Tx, work *change) error {
		if input.ExpectedOrgVersion != nil {
			var current int64
			if err := tx.QueryRow(ctx, `SELECT org_version FROM organizations WHERE id = $1`, user.OrgID).Scan(&current); err != nil {
				return err
			}
			if current != *input.ExpectedOrgVersion {
				return &Error{Kind: ErrVersionConflict, Field: "expected_org_version", Message: "The org structure changed. Reload and try again."}
			}
		}
		if err := requirePeople(ctx, tx, user.OrgID, []string{actorID}, "actor_id"); err != nil {
			return err
		}
		wanted := append([]string(nil), input.AdditionalDepartmentIDs...)
		if input.PrimaryDepartmentID != nil {
			wanted = append(wanted, *input.PrimaryDepartmentID)
		}
		if err := requireDepartments(ctx, tx, user.OrgID, wanted); err != nil {
			return err
		}
		if input.PositionID != nil {
			if err := requirePosition(ctx, tx, user.OrgID, *input.PositionID); err != nil {
				return err
			}
		}
		before, err := readPerson(ctx, tx, user.OrgID, actorID)
		if err != nil {
			return err
		}
		current, err := memberships(ctx, tx, user.OrgID, actorID)
		if err != nil {
			return err
		}
		keep := map[string]bool{}
		for _, departmentID := range wanted {
			keep[departmentID] = true
		}
		for _, item := range current {
			if !keep[item.departmentID] {
				if err := dropMembership(ctx, tx, user.OrgID, actorID, item.departmentID); err != nil {
					return err
				}
			}
		}
		if _, err := tx.Exec(ctx, `UPDATE department_members SET is_primary = false WHERE org_id = $1 AND actor_id = $2 AND is_primary AND department_id IS DISTINCT FROM $3::uuid`, user.OrgID, actorID, input.PrimaryDepartmentID); err != nil {
			return err
		}
		if input.PrimaryDepartmentID != nil {
			if _, err := tx.Exec(ctx, `
				INSERT INTO department_members(org_id, department_id, actor_id, is_primary) VALUES ($1, $2, $3, true)
				ON CONFLICT (department_id, actor_id) DO UPDATE SET is_primary = true`, user.OrgID, *input.PrimaryDepartmentID, actorID); err != nil {
				return err
			}
		}
		for _, departmentID := range input.AdditionalDepartmentIDs {
			if _, err := tx.Exec(ctx, `
				INSERT INTO department_members(org_id, department_id, actor_id, is_primary) VALUES ($1, $2, $3, false)
				ON CONFLICT (department_id, actor_id) DO UPDATE SET is_primary = false`, user.OrgID, departmentID, actorID); err != nil {
				return err
			}
		}
		if _, err := tx.Exec(ctx, `UPDATE actors SET position_id = $3 WHERE org_id = $1 AND id = $2 AND position_id IS DISTINCT FROM $3::uuid`, user.OrgID, actorID, input.PositionID); err != nil {
			return err
		}
		after, err := readPerson(ctx, tx, user.OrgID, actorID)
		if err != nil {
			return err
		}
		result.Person = after
		if !samePerson(before, after) {
			work.touch(ReasonMembership)
			work.audit("org.person.set", "actor", actorID, map[string]any{"from": before, "to": after})
		}
		return nil
	})
	if err != nil {
		return PersonWrite{}, err
	}
	result.Version = version
	return result, nil
}

func (s *Service) AssignPeople(ctx context.Context, user identity.User, input AssignPeopleInput) (AssignPeopleResult, error) {
	if len(input.ActorIDs) < 1 || len(input.ActorIDs) > MaxAssignPeople {
		return AssignPeopleResult{}, invalid("actor_ids", "actor_ids must list 1 to %d people.", MaxAssignPeople)
	}
	seen := map[string]bool{}
	for _, actorID := range input.ActorIDs {
		if err := validateID("actor_ids", actorID); err != nil {
			return AssignPeopleResult{}, err
		}
		if seen[actorID] {
			return AssignPeopleResult{}, invalid("actor_ids", "Each person may be listed once.")
		}
		seen[actorID] = true
	}
	if input.PrimaryDepartmentID == nil && input.AddDepartmentID == nil && !input.PositionID.Set {
		return AssignPeopleResult{}, invalid("actor_ids", "Nothing to assign.")
	}
	for field, value := range map[string]*string{"primary_department_id": input.PrimaryDepartmentID, "add_department_id": input.AddDepartmentID, "position_id": input.PositionID.Value} {
		if value != nil {
			if err := validateID(field, *value); err != nil {
				return AssignPeopleResult{}, err
			}
		}
	}
	var result AssignPeopleResult
	version, err := s.write(ctx, user, writeOptions{lockActors: input.ActorIDs}, func(ctx context.Context, tx pgx.Tx, work *change) error {
		if err := requirePeople(ctx, tx, user.OrgID, input.ActorIDs, "actor_ids"); err != nil {
			return err
		}
		for _, departmentID := range []*string{input.PrimaryDepartmentID, input.AddDepartmentID} {
			if departmentID != nil {
				if _, err := lockDepartment(ctx, tx, user.OrgID, *departmentID); err != nil {
					return err
				}
			}
		}
		if input.PositionID.Value != nil {
			if err := requirePosition(ctx, tx, user.OrgID, *input.PositionID.Value); err != nil {
				return err
			}
		}
		ordered := uniqueSorted(input.ActorIDs)
		for _, actorID := range ordered {
			if input.PrimaryDepartmentID != nil {
				if err := setMembership(ctx, tx, work, user.OrgID, actorID, *input.PrimaryDepartmentID, true, false); err != nil {
					return err
				}
			}
			if input.AddDepartmentID != nil {
				if err := setMembershipIfAbsent(ctx, tx, work, user.OrgID, actorID, *input.AddDepartmentID); err != nil {
					return err
				}
			}
		}
		if input.PositionID.Set {
			command, err := tx.Exec(ctx, `
				UPDATE actors SET position_id = $3 WHERE org_id = $1 AND id = ANY($2::uuid[]) AND position_id IS DISTINCT FROM $3::uuid`,
				user.OrgID, ordered, input.PositionID.Value)
			if err != nil {
				return err
			}
			if command.RowsAffected() > 0 {
				work.touch(ReasonMembership)
			}
		}
		if work.changed {
			work.audit("org.people.assign", "organization", user.OrgID, map[string]any{
				"actor_ids": ordered, "primary_department_id": input.PrimaryDepartmentID, "add_department_id": input.AddDepartmentID,
				"position_set": input.PositionID.Set, "position_id": input.PositionID.Value,
			})
		}
		people, err := readPeople(ctx, tx, user.OrgID, ordered)
		result.People = people
		return err
	})
	if err != nil {
		return AssignPeopleResult{}, err
	}
	result.Version = version
	return result, nil
}

// setMembershipIfAbsent adds the department unless the person is already in
// it (as primary or additional).
func setMembershipIfAbsent(ctx context.Context, tx pgx.Tx, work *change, orgID, actorID, departmentID string) error {
	var member bool
	if err := tx.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM department_members WHERE org_id = $1 AND department_id = $2 AND actor_id = $3)`, orgID, departmentID, actorID).Scan(&member); err != nil {
		return fmt.Errorf("check membership: %w", err)
	}
	if member {
		return nil
	}
	return setMembership(ctx, tx, work, orgID, actorID, departmentID, false, false)
}

func samePerson(left, right Person) bool {
	if !sameID(left.PrimaryDepartmentID, right.PrimaryDepartmentID) || !sameID(left.PositionID, right.PositionID) || len(left.AdditionalDepartmentIDs) != len(right.AdditionalDepartmentIDs) {
		return false
	}
	set := map[string]bool{}
	for _, value := range left.AdditionalDepartmentIDs {
		set[value] = true
	}
	for _, value := range right.AdditionalDepartmentIDs {
		if !set[value] {
			return false
		}
	}
	return true
}
