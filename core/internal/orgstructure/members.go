package orgstructure

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
)

// membership is one row of department_members for a person, oldest first.
type membership struct {
	departmentID string
	primary      bool
}

// requirePeople checks that every id is an active person (not an agent) of
// the workspace; field names the request field for the refusal.
func requirePeople(ctx context.Context, tx pgx.Tx, orgID string, actorIDs []string, field string) error {
	if len(actorIDs) == 0 {
		return nil
	}
	for _, value := range actorIDs {
		if err := validateID(field, value); err != nil {
			return err
		}
	}
	ids := uniqueSorted(actorIDs)
	var count int
	if err := tx.QueryRow(ctx, `
		SELECT count(*) FROM actors
		WHERE org_id = $1 AND id = ANY($2::uuid[]) AND type = 'user' AND status = 'active' AND deleted_at IS NULL`,
		orgID, ids).Scan(&count); err != nil {
		return fmt.Errorf("check people: %w", err)
	}
	if count != len(ids) {
		return invalid(field, "Only active people of the workspace (not agents) may be in the org structure.")
	}
	return nil
}

func memberships(ctx context.Context, tx pgx.Tx, orgID, actorID string) ([]membership, error) {
	rows, err := tx.Query(ctx, `
		SELECT department_id, is_primary FROM department_members
		WHERE org_id = $1 AND actor_id = $2 ORDER BY created_at, department_id`, orgID, actorID)
	if err != nil {
		return nil, fmt.Errorf("read memberships: %w", err)
	}
	defer rows.Close()
	result := make([]membership, 0)
	for rows.Next() {
		var item membership
		if err := rows.Scan(&item.departmentID, &item.primary); err != nil {
			return nil, err
		}
		result = append(result, item)
	}
	return result, rows.Err()
}

// departmentRow is a department locked FOR UPDATE.
type departmentRow struct {
	id       string
	parentID *string
	name     string
	leadID   *string
	chatID   *string
	sortKey  *int32
	version  int32
}

func lockDepartment(ctx context.Context, tx pgx.Tx, orgID, departmentID string) (departmentRow, error) {
	if validateID("department_id", departmentID) != nil {
		return departmentRow{}, ErrDepartmentNotFound
	}
	var row departmentRow
	err := tx.QueryRow(ctx, `
		SELECT id, parent_id, name, lead_actor_id, chat_id, sort_key, version
		FROM departments WHERE org_id = $1 AND id = $2 FOR UPDATE`, orgID, departmentID).
		Scan(&row.id, &row.parentID, &row.name, &row.leadID, &row.chatID, &row.sortKey, &row.version)
	if errors.Is(err, pgx.ErrNoRows) {
		return departmentRow{}, ErrDepartmentNotFound
	}
	if err != nil {
		return departmentRow{}, fmt.Errorf("lock department: %w", err)
	}
	return row, nil
}

// requireDepartments checks that the departments exist (404 otherwise).
func requireDepartments(ctx context.Context, tx pgx.Tx, orgID string, departmentIDs []string) error {
	if len(departmentIDs) == 0 {
		return nil
	}
	for _, value := range departmentIDs {
		if validateID("department_id", value) != nil {
			return ErrDepartmentNotFound
		}
	}
	ids := uniqueSorted(departmentIDs)
	var count int
	if err := tx.QueryRow(ctx, `SELECT count(*) FROM departments WHERE org_id = $1 AND id = ANY($2::uuid[])`, orgID, ids).Scan(&count); err != nil {
		return fmt.Errorf("check departments: %w", err)
	}
	if count != len(ids) {
		return ErrDepartmentNotFound
	}
	return nil
}

func requirePosition(ctx context.Context, tx pgx.Tx, orgID, positionID string) error {
	if validateID("position_id", positionID) != nil {
		return ErrPositionNotFound
	}
	var exists bool
	if err := tx.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM positions WHERE org_id = $1 AND id = $2)`, orgID, positionID).Scan(&exists); err != nil {
		return fmt.Errorf("check position: %w", err)
	}
	if !exists {
		return ErrPositionNotFound
	}
	return nil
}

// setMembership adds a person to a department or changes the kind of the
// membership, keeping the invariants: at most one primary department, an
// additional one only next to a primary one, at most 10 additional ones, and a
// lead is a member of the department they lead.
//
// primary moves the primary department here; the previous primary one stays
// as an additional one with keepPrevious, otherwise that membership is
// dropped (and its lead cleared when it was this person). Not primary makes
// the department an additional one; for a person without any department it
// becomes the primary one, and turning the primary department into an
// additional one promotes the oldest other additional department, if any.
func setMembership(ctx context.Context, tx pgx.Tx, work *change, orgID, actorID, departmentID string, primary, keepPrevious bool) error {
	current, err := memberships(ctx, tx, orgID, actorID)
	if err != nil {
		return err
	}
	var existing *membership
	var previousPrimary *membership
	additional := 0
	for index := range current {
		if current[index].departmentID == departmentID {
			existing = &current[index]
		}
		if current[index].primary {
			previousPrimary = &current[index]
		} else {
			additional++
		}
	}
	if primary {
		if existing != nil && existing.primary {
			return nil
		}
		if previousPrimary != nil {
			if keepPrevious {
				count := additional + 1
				if existing != nil {
					count-- // it stops being additional
				}
				if count > MaxAdditionalDepartments {
					return limitReached("additional_departments", "A person may have at most %d additional departments.", MaxAdditionalDepartments)
				}
				if _, err := tx.Exec(ctx, `UPDATE department_members SET is_primary = false WHERE department_id = $1 AND actor_id = $2`, previousPrimary.departmentID, actorID); err != nil {
					return fmt.Errorf("demote primary department: %w", err)
				}
			} else if err := dropMembership(ctx, tx, orgID, actorID, previousPrimary.departmentID); err != nil {
				return err
			}
		}
		if existing != nil {
			if _, err := tx.Exec(ctx, `UPDATE department_members SET is_primary = true WHERE department_id = $1 AND actor_id = $2`, departmentID, actorID); err != nil {
				return fmt.Errorf("promote department: %w", err)
			}
		} else if _, err := tx.Exec(ctx, `
			INSERT INTO department_members(org_id, department_id, actor_id, is_primary) VALUES ($1, $2, $3, true)`,
			orgID, departmentID, actorID); err != nil {
			return fmt.Errorf("add primary membership: %w", err)
		}
		work.touch(ReasonMembership)
		return nil
	}
	if existing != nil {
		if !existing.primary {
			return nil
		}
		// The primary department becomes additional: the oldest other
		// additional department takes its place. Without one it stays
		// primary — an additional department needs a primary one.
		var promote string
		for _, item := range current {
			if !item.primary {
				promote = item.departmentID
				break
			}
		}
		if promote == "" {
			return nil
		}
		if _, err := tx.Exec(ctx, `UPDATE department_members SET is_primary = false WHERE department_id = $1 AND actor_id = $2`, departmentID, actorID); err != nil {
			return fmt.Errorf("demote primary department: %w", err)
		}
		if _, err := tx.Exec(ctx, `UPDATE department_members SET is_primary = true WHERE department_id = $1 AND actor_id = $2`, promote, actorID); err != nil {
			return fmt.Errorf("promote additional department: %w", err)
		}
		work.touch(ReasonMembership)
		return nil
	}
	isPrimary := previousPrimary == nil
	if !isPrimary && additional >= MaxAdditionalDepartments {
		return limitReached("additional_departments", "A person may have at most %d additional departments.", MaxAdditionalDepartments)
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO department_members(org_id, department_id, actor_id, is_primary) VALUES ($1, $2, $3, $4)`,
		orgID, departmentID, actorID, isPrimary); err != nil {
		return fmt.Errorf("add membership: %w", err)
	}
	work.touch(ReasonMembership)
	return nil
}

// removeMembership drops a membership; the oldest additional department
// becomes primary when it was the primary one, and the lead of the
// department is cleared when it was this person. It reports whether the
// person was a member.
func removeMembership(ctx context.Context, tx pgx.Tx, work *change, orgID, actorID, departmentID string) (bool, error) {
	var wasPrimary bool
	err := tx.QueryRow(ctx, `
		DELETE FROM department_members WHERE org_id = $1 AND department_id = $2 AND actor_id = $3 RETURNING is_primary`,
		orgID, departmentID, actorID).Scan(&wasPrimary)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, fmt.Errorf("remove membership: %w", err)
	}
	if err := clearLead(ctx, tx, orgID, departmentID, actorID); err != nil {
		return false, err
	}
	if wasPrimary {
		if err := promoteOldest(ctx, tx, orgID, actorID); err != nil {
			return false, err
		}
	}
	work.touch(ReasonMembership)
	return true, nil
}

// dropMembership deletes a membership without promoting anything (the
// caller sets the new primary department) and clears the lead.
func dropMembership(ctx context.Context, tx pgx.Tx, orgID, actorID, departmentID string) error {
	if _, err := tx.Exec(ctx, `DELETE FROM department_members WHERE org_id = $1 AND department_id = $2 AND actor_id = $3`, orgID, departmentID, actorID); err != nil {
		return fmt.Errorf("drop membership: %w", err)
	}
	return clearLead(ctx, tx, orgID, departmentID, actorID)
}

func clearLead(ctx context.Context, tx pgx.Tx, orgID, departmentID, actorID string) error {
	if _, err := tx.Exec(ctx, `
		UPDATE departments SET lead_actor_id = NULL, version = version + 1, updated_at = now()
		WHERE org_id = $1 AND id = $2 AND lead_actor_id = $3`, orgID, departmentID, actorID); err != nil {
		return fmt.Errorf("clear department lead: %w", err)
	}
	return nil
}

func promoteOldest(ctx context.Context, tx pgx.Tx, orgID, actorID string) error {
	if _, err := tx.Exec(ctx, `
		UPDATE department_members SET is_primary = true
		WHERE (department_id, actor_id) = (
			SELECT department_id, actor_id FROM department_members
			WHERE org_id = $1 AND actor_id = $2 AND NOT is_primary
			  AND NOT EXISTS (SELECT 1 FROM department_members p WHERE p.org_id = $1 AND p.actor_id = $2 AND p.is_primary)
			ORDER BY created_at, department_id LIMIT 1)`, orgID, actorID); err != nil {
		return fmt.Errorf("promote additional department: %w", err)
	}
	return nil
}

func readPerson(ctx context.Context, tx pgx.Tx, orgID, actorID string) (Person, error) {
	people, err := readPeople(ctx, tx, orgID, []string{actorID})
	if err != nil {
		return Person{}, err
	}
	if len(people) != 1 {
		return Person{}, invalid("actor_id", "The person is not an active person of the workspace.")
	}
	return people[0], nil
}
