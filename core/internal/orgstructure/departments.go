package orgstructure

import (
	"context"
	"fmt"
	"strings"
	"unicode/utf8"

	"github.com/comamessenger/comamessenger/core/internal/id"
	"github.com/comamessenger/comamessenger/core/internal/identity"
	"github.com/jackc/pgx/v5"
)

func (s *Service) CreateDepartment(ctx context.Context, user identity.User, input CreateDepartmentInput) (DepartmentWrite, error) {
	name, err := validateName("name", input.Name)
	if err != nil {
		return DepartmentWrite{}, err
	}
	if len(input.Members) > MaxCreateMembers {
		return DepartmentWrite{}, invalid("members", "At most %d members at once.", MaxCreateMembers)
	}
	seen := make(map[string]bool, len(input.Members))
	actorIDs := make([]string, 0, len(input.Members))
	for _, member := range input.Members {
		if err := validateID("actor_id", member.ActorID); err != nil {
			return DepartmentWrite{}, err
		}
		if seen[member.ActorID] {
			return DepartmentWrite{}, invalid("actor_id", "Each person may be listed once.")
		}
		seen[member.ActorID] = true
		actorIDs = append(actorIDs, member.ActorID)
	}
	if input.ParentID != nil {
		if err := validateID("parent_id", *input.ParentID); err != nil {
			return DepartmentWrite{}, err
		}
	}
	if input.LeadActorID != nil {
		if err := validateID("lead_actor_id", *input.LeadActorID); err != nil {
			return DepartmentWrite{}, err
		}
	}
	departmentID, err := id.New()
	if err != nil {
		return DepartmentWrite{}, err
	}
	var result DepartmentWrite
	version, err := s.write(ctx, user, writeOptions{}, func(ctx context.Context, tx pgx.Tx, work *change) error {
		var count int
		if err := tx.QueryRow(ctx, `SELECT count(*) FROM departments WHERE org_id = $1`, user.OrgID).Scan(&count); err != nil {
			return err
		}
		if count >= MaxDepartments {
			return limitReached("departments", "A workspace may have at most %d departments.", MaxDepartments)
		}
		var sortKey *int32
		if input.ParentID != nil {
			parent, err := lockDepartment(ctx, tx, user.OrgID, *input.ParentID)
			if err != nil {
				return err
			}
			depth, err := depthOf(ctx, tx, user.OrgID, parent.id)
			if err != nil {
				return err
			}
			if depth+1 > MaxDepth {
				return &Error{Kind: ErrDepthExceeded, Field: "parent_id", Message: fmt.Sprintf("Departments may be nested at most %d levels deep.", MaxDepth)}
			}
		}
		if sortKey, err = nextSortKey(ctx, tx, user.OrgID, input.ParentID); err != nil {
			return err
		}
		lead := input.LeadActorID
		people := actorIDs
		if lead != nil && !seen[*lead] {
			people = append(append([]string(nil), actorIDs...), *lead)
		}
		if err := requirePeople(ctx, tx, user.OrgID, people, "actor_id"); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `
			INSERT INTO departments(org_id, id, parent_id, name, sort_key) VALUES ($1, $2, $3, $4, $5)`,
			user.OrgID, departmentID, input.ParentID, name, sortKey); err != nil {
			return err
		}
		work.touch(ReasonDepartment)
		for _, member := range input.Members {
			if err := setMembership(ctx, tx, work, user.OrgID, member.ActorID, departmentID, member.Primary, false); err != nil {
				return err
			}
		}
		if lead != nil {
			if err := setLead(ctx, tx, work, user.OrgID, departmentID, *lead); err != nil {
				return err
			}
		}
		work.reason = ReasonDepartment
		work.audit("org.department.create", "department", departmentID, map[string]any{"name": name, "parent_id": input.ParentID, "members": len(input.Members)})
		department, err := readDepartment(ctx, tx, user, departmentID)
		result.Department = department
		return err
	})
	if err != nil {
		return DepartmentWrite{}, err
	}
	result.Version = version
	return result, nil
}

func (s *Service) UpdateDepartment(ctx context.Context, user identity.User, departmentID string, input UpdateDepartmentInput) (DepartmentWrite, error) {
	if input.ExpectedVersion < 1 {
		return DepartmentWrite{}, invalid("expected_version", "expected_version is required")
	}
	if input.Name == nil && !input.ParentID.Set && !input.LeadActorID.Set {
		return DepartmentWrite{}, invalid("name", "No changes supplied.")
	}
	var name string
	if input.Name != nil {
		var err error
		if name, err = validateName("name", *input.Name); err != nil {
			return DepartmentWrite{}, err
		}
	}
	if input.ParentID.Value != nil {
		if err := validateID("parent_id", *input.ParentID.Value); err != nil {
			return DepartmentWrite{}, err
		}
	}
	if input.LeadActorID.Value != nil {
		if err := validateID("lead_actor_id", *input.LeadActorID.Value); err != nil {
			return DepartmentWrite{}, err
		}
	}
	var result DepartmentWrite
	version, err := s.write(ctx, user, writeOptions{}, func(ctx context.Context, tx pgx.Tx, work *change) error {
		row, err := lockDepartment(ctx, tx, user.OrgID, departmentID)
		if err != nil {
			return err
		}
		if row.version != input.ExpectedVersion {
			return &Error{Kind: ErrVersionConflict, Field: "expected_version", Message: "The department changed. Reload and try again."}
		}
		changes := map[string]any{}
		if input.Name != nil && name != row.name {
			if _, err := tx.Exec(ctx, `UPDATE departments SET name = $3 WHERE org_id = $1 AND id = $2`, user.OrgID, row.id, name); err != nil {
				return err
			}
			changes["name"] = map[string]any{"from": row.name, "to": name}
		}
		if input.ParentID.Set && !sameID(input.ParentID.Value, row.parentID) {
			if err := reparent(ctx, tx, user.OrgID, row, input.ParentID.Value); err != nil {
				return err
			}
			changes["parent_id"] = map[string]any{"from": row.parentID, "to": input.ParentID.Value}
		}
		if input.LeadActorID.Set && !sameID(input.LeadActorID.Value, row.leadID) {
			if input.LeadActorID.Value == nil {
				if _, err := tx.Exec(ctx, `UPDATE departments SET lead_actor_id = NULL WHERE org_id = $1 AND id = $2`, user.OrgID, row.id); err != nil {
					return err
				}
			} else {
				if err := requirePeople(ctx, tx, user.OrgID, []string{*input.LeadActorID.Value}, "lead_actor_id"); err != nil {
					return err
				}
				if err := setLead(ctx, tx, work, user.OrgID, row.id, *input.LeadActorID.Value); err != nil {
					return err
				}
			}
			changes["lead_actor_id"] = map[string]any{"from": row.leadID, "to": input.LeadActorID.Value}
		}
		if len(changes) > 0 {
			if _, err := tx.Exec(ctx, `UPDATE departments SET version = version + 1, updated_at = now() WHERE org_id = $1 AND id = $2`, user.OrgID, row.id); err != nil {
				return err
			}
			work.touch(ReasonDepartment)
			work.reason = ReasonDepartment
			work.audit("org.department.update", "department", row.id, map[string]any{"changes": changes})
		}
		department, err := readDepartment(ctx, tx, user, row.id)
		result.Department = department
		return err
	})
	if err != nil {
		return DepartmentWrite{}, err
	}
	result.Version = version
	return result, nil
}

// reparent moves a department under parentID (nil: top level), refusing a
// cycle and a tree deeper than MaxDepth.
func reparent(ctx context.Context, tx pgx.Tx, orgID string, row departmentRow, parentID *string) error {
	if parentID != nil {
		if *parentID == row.id {
			return &Error{Kind: ErrCycle, Field: "parent_id", Message: "A department cannot be inside itself."}
		}
		if _, err := lockDepartment(ctx, tx, orgID, *parentID); err != nil {
			return err
		}
		var descendant bool
		if err := tx.QueryRow(ctx, `
			WITH RECURSIVE below AS (
				SELECT id FROM departments WHERE org_id = $1 AND parent_id = $2
				UNION
				SELECT d.id FROM departments d JOIN below ON d.parent_id = below.id WHERE d.org_id = $1
			)
			SELECT EXISTS (SELECT 1 FROM below WHERE id = $3)`, orgID, row.id, *parentID).Scan(&descendant); err != nil {
			return fmt.Errorf("check department cycle: %w", err)
		}
		if descendant {
			return &Error{Kind: ErrCycle, Field: "parent_id", Message: "A department cannot be inside its own subdepartment."}
		}
		depth, err := depthOf(ctx, tx, orgID, *parentID)
		if err != nil {
			return err
		}
		height, err := heightOf(ctx, tx, orgID, row.id)
		if err != nil {
			return err
		}
		if depth+height > MaxDepth {
			return &Error{Kind: ErrDepthExceeded, Field: "parent_id", Message: fmt.Sprintf("Departments may be nested at most %d levels deep.", MaxDepth)}
		}
	}
	sortKey, err := nextSortKey(ctx, tx, orgID, parentID)
	if err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `UPDATE departments SET parent_id = $3, sort_key = $4 WHERE org_id = $1 AND id = $2`, orgID, row.id, parentID, sortKey); err != nil {
		return err
	}
	return nil
}

// setLead makes a person the lead; a lead outside the department becomes an
// additional member (or primary, without any department).
func setLead(ctx context.Context, tx pgx.Tx, work *change, orgID, departmentID, actorID string) error {
	var member bool
	if err := tx.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM department_members WHERE org_id = $1 AND department_id = $2 AND actor_id = $3)`, orgID, departmentID, actorID).Scan(&member); err != nil {
		return err
	}
	if !member {
		if err := setMembership(ctx, tx, work, orgID, actorID, departmentID, false, false); err != nil {
			return err
		}
	}
	if _, err := tx.Exec(ctx, `UPDATE departments SET lead_actor_id = $3 WHERE org_id = $1 AND id = $2`, orgID, departmentID, actorID); err != nil {
		return err
	}
	work.touch(ReasonDepartment)
	return nil
}

// depthOf is the level of a department, 1 for a top-level one.
func depthOf(ctx context.Context, tx pgx.Tx, orgID, departmentID string) (int, error) {
	var depth int
	err := tx.QueryRow(ctx, `
		WITH RECURSIVE up AS (
			SELECT id, parent_id, 1 AS level FROM departments WHERE org_id = $1 AND id = $2
			UNION ALL
			SELECT d.id, d.parent_id, up.level + 1 FROM departments d JOIN up ON d.id = up.parent_id
			WHERE d.org_id = $1 AND up.level <= $3
		)
		SELECT COALESCE(max(level), 0) FROM up`, orgID, departmentID, MaxDepth+1).Scan(&depth)
	if err != nil {
		return 0, fmt.Errorf("department depth: %w", err)
	}
	return depth, nil
}

// heightOf is the number of levels of a subtree, 1 for a department without
// subdepartments.
func heightOf(ctx context.Context, tx pgx.Tx, orgID, departmentID string) (int, error) {
	var height int
	err := tx.QueryRow(ctx, `
		WITH RECURSIVE down AS (
			SELECT id, 1 AS level FROM departments WHERE org_id = $1 AND id = $2
			UNION ALL
			SELECT d.id, down.level + 1 FROM departments d JOIN down ON d.parent_id = down.id
			WHERE d.org_id = $1 AND down.level <= $3
		)
		SELECT COALESCE(max(level), 0) FROM down`, orgID, departmentID, MaxDepth+1).Scan(&height)
	if err != nil {
		return 0, fmt.Errorf("department height: %w", err)
	}
	return height, nil
}

// nextSortKey keeps a manual order of siblings: a department added among
// siblings that were ordered by hand goes last; otherwise all go by name.
func nextSortKey(ctx context.Context, tx pgx.Tx, orgID string, parentID *string) (*int32, error) {
	var next *int32
	err := tx.QueryRow(ctx, `
		SELECT max(sort_key) + 1 FROM departments
		WHERE org_id = $1 AND parent_id IS NOT DISTINCT FROM $2::uuid AND sort_key IS NOT NULL`, orgID, parentID).Scan(&next)
	if err != nil {
		return nil, fmt.Errorf("next sort key: %w", err)
	}
	return next, nil
}

func (s *Service) MoveDepartment(ctx context.Context, user identity.User, departmentID string, input MoveDepartmentInput) (DepartmentWrite, error) {
	if input.Direction != "up" && input.Direction != "down" {
		return DepartmentWrite{}, invalid("direction", "direction must be up or down")
	}
	var result DepartmentWrite
	version, err := s.write(ctx, user, writeOptions{}, func(ctx context.Context, tx pgx.Tx, work *change) error {
		row, err := lockDepartment(ctx, tx, user.OrgID, departmentID)
		if err != nil {
			return err
		}
		rows, err := tx.Query(ctx, `
			SELECT id, sort_key FROM departments
			WHERE org_id = $1 AND parent_id IS NOT DISTINCT FROM $2::uuid
			ORDER BY sort_key NULLS LAST, lower(name), id FOR UPDATE`, user.OrgID, row.parentID)
		if err != nil {
			return err
		}
		type sibling struct {
			id      string
			sortKey *int32
		}
		siblings := make([]sibling, 0)
		for rows.Next() {
			var item sibling
			if err := rows.Scan(&item.id, &item.sortKey); err != nil {
				rows.Close()
				return err
			}
			siblings = append(siblings, item)
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return err
		}
		index := -1
		for position, item := range siblings {
			if item.id == row.id {
				index = position
			}
		}
		target := index - 1
		if input.Direction == "down" {
			target = index + 1
		}
		if index < 0 || target < 0 || target >= len(siblings) {
			department, err := readDepartment(ctx, tx, user, row.id)
			result.Department = department
			return err
		}
		siblings[index], siblings[target] = siblings[target], siblings[index]
		for position, item := range siblings {
			if item.sortKey != nil && int(*item.sortKey) == position {
				continue
			}
			if _, err := tx.Exec(ctx, `
				UPDATE departments SET sort_key = $3, version = version + 1, updated_at = now()
				WHERE org_id = $1 AND id = $2`, user.OrgID, item.id, position); err != nil {
				return err
			}
		}
		work.touch(ReasonDepartment)
		work.audit("org.department.move", "department", row.id, map[string]any{"direction": input.Direction})
		department, err := readDepartment(ctx, tx, user, row.id)
		result.Department = department
		return err
	})
	if err != nil {
		return DepartmentWrite{}, err
	}
	result.Version = version
	return result, nil
}

// DeleteDepartment applies decision 12: subdepartments go to the parent,
// primary members to membersTo ("" — the parent, "none" — nowhere), where
// without a target a person's oldest additional department becomes primary;
// additional memberships and the chat link go with the row.
func (s *Service) DeleteDepartment(ctx context.Context, user identity.User, departmentID, membersTo string) error {
	membersTo = strings.TrimSpace(membersTo)
	if membersTo != "" && membersTo != "none" {
		if err := validateID("members_to", membersTo); err != nil {
			return err
		}
	}
	_, err := s.write(ctx, user, writeOptions{}, func(ctx context.Context, tx pgx.Tx, work *change) error {
		row, err := lockDepartment(ctx, tx, user.OrgID, departmentID)
		if err != nil {
			return err
		}
		var target *string
		switch membersTo {
		case "":
			target = row.parentID
		case "none":
		default:
			if membersTo == row.id {
				return invalid("members_to", "members_to must not be the deleted department.")
			}
			if _, err := lockDepartment(ctx, tx, user.OrgID, membersTo); err != nil {
				if err == ErrDepartmentNotFound {
					return invalid("members_to", "members_to must be an existing department.")
				}
				return err
			}
			var inside bool
			if err := tx.QueryRow(ctx, `
				WITH RECURSIVE below AS (
					SELECT id FROM departments WHERE org_id = $1 AND parent_id = $2
					UNION
					SELECT d.id FROM departments d JOIN below ON d.parent_id = below.id WHERE d.org_id = $1
				)
				SELECT EXISTS (SELECT 1 FROM below WHERE id = $3)`, user.OrgID, row.id, membersTo).Scan(&inside); err != nil {
				return err
			}
			if inside {
				return invalid("members_to", "members_to must not be inside the deleted department.")
			}
			target = &membersTo
		}
		// Subdepartments move to the parent. A name already taken there
		// gets a number, so the delete never fails on names.
		children, err := childrenOf(ctx, tx, user.OrgID, row.id)
		if err != nil {
			return err
		}
		for _, child := range children {
			name, err := freeName(ctx, tx, user.OrgID, row.parentID, child.name, child.id)
			if err != nil {
				return err
			}
			sortKey, err := nextSortKey(ctx, tx, user.OrgID, row.parentID)
			if err != nil {
				return err
			}
			if _, err := tx.Exec(ctx, `
				UPDATE departments SET parent_id = $3, name = $4, sort_key = $5, version = version + 1, updated_at = now()
				WHERE org_id = $1 AND id = $2`, user.OrgID, child.id, row.parentID, name, sortKey); err != nil {
				return err
			}
		}
		primaries, err := tx.Query(ctx, `
			SELECT actor_id FROM department_members WHERE org_id = $1 AND department_id = $2 AND is_primary ORDER BY actor_id`, user.OrgID, row.id)
		if err != nil {
			return err
		}
		moving := make([]string, 0)
		for primaries.Next() {
			var actorID string
			if err := primaries.Scan(&actorID); err != nil {
				primaries.Close()
				return err
			}
			moving = append(moving, actorID)
		}
		primaries.Close()
		if err := primaries.Err(); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `DELETE FROM department_members WHERE org_id = $1 AND department_id = $2`, user.OrgID, row.id); err != nil {
			return err
		}
		for _, actorID := range moving {
			if target != nil {
				if err := setMembership(ctx, tx, work, user.OrgID, actorID, *target, true, false); err != nil {
					return err
				}
			} else if err := promoteOldest(ctx, tx, user.OrgID, actorID); err != nil {
				return err
			}
		}
		if _, err := tx.Exec(ctx, `DELETE FROM departments WHERE org_id = $1 AND id = $2`, user.OrgID, row.id); err != nil {
			return err
		}
		work.touch(ReasonDepartment)
		work.reason = ReasonDepartment
		work.audit("org.department.delete", "department", row.id, map[string]any{
			"name": row.name, "members_to": target, "moved_members": len(moving), "subdepartments": len(children), "had_chat": row.chatID != nil,
		})
		return nil
	})
	return err
}

type childRow struct {
	id   string
	name string
}

func childrenOf(ctx context.Context, tx pgx.Tx, orgID, departmentID string) ([]childRow, error) {
	rows, err := tx.Query(ctx, `
		SELECT id, name FROM departments WHERE org_id = $1 AND parent_id = $2
		ORDER BY sort_key NULLS LAST, lower(name), id FOR UPDATE`, orgID, departmentID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := make([]childRow, 0)
	for rows.Next() {
		var item childRow
		if err := rows.Scan(&item.id, &item.name); err != nil {
			return nil, err
		}
		result = append(result, item)
	}
	return result, rows.Err()
}

// freeName returns name, or «name (2)», «name (3)»… when a sibling under
// parentID other than self already has it.
func freeName(ctx context.Context, tx pgx.Tx, orgID string, parentID *string, name, self string) (string, error) {
	candidate := name
	for attempt := 2; attempt < MaxDepartments+2; attempt++ {
		var taken bool
		if err := tx.QueryRow(ctx, `
			SELECT EXISTS (SELECT 1 FROM departments
			WHERE org_id = $1 AND parent_id IS NOT DISTINCT FROM $2::uuid AND id <> $4
			  AND lower(btrim(name)) = lower(btrim($3)))`, orgID, parentID, candidate, self).Scan(&taken); err != nil {
			return "", err
		}
		if !taken {
			return candidate, nil
		}
		suffix := fmt.Sprintf(" (%d)", attempt)
		base := []rune(name)
		if limit := MaxNameLength - utf8.RuneCountInString(suffix); len(base) > limit {
			base = base[:limit]
		}
		candidate = strings.TrimSpace(string(base)) + suffix
	}
	return "", nameTaken("name")
}

func sameID(left, right *string) bool {
	if left == nil || right == nil {
		return left == nil && right == nil
	}
	return strings.EqualFold(*left, *right)
}
