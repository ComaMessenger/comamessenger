package request

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/comamessenger/comamessenger/core/internal/identity"
	"github.com/comamessenger/comamessenger/core/internal/orgstructure"
	"github.com/comamessenger/comamessenger/core/internal/permission"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// The department and position audiences (phase 6.5 wave 2). A request to
// a department asks its active people (with subdepartments, primary and
// additional members) who are active members of the chat; to a position,
// the active people who hold it and are members of the chat. The author is
// left out. The list is fixed at the moment of sending like any other
// audience. Addressing a group needs requests.address_groups in the
// author's effective permissions, read from the database inside the send
// transaction: a permission revoked a moment ago is not trusted from the
// session.

var (
	ErrAudienceForbidden = errors.New("request audience needs requests.address_groups")
	ErrDepartmentMissing = errors.New("request department not found")
	ErrPositionMissing   = errors.New("request position not found")
)

// normalizeGroupAudience checks a department or position audience without
// the database and fills plan.
func normalizeGroupAudience(audience AudienceInput, plan *Plan) error {
	if len(audience.ActorIDs) > 0 {
		return invalid("audience", "audience %s takes no actor_ids", audience.Kind)
	}
	var field string
	var value *string
	switch audience.Kind {
	case "department":
		if audience.PositionID != nil {
			return invalid("audience", "audience department takes only department_id")
		}
		field, value = "audience.department_id", audience.DepartmentID
	default:
		if audience.DepartmentID != nil {
			return invalid("audience", "audience position takes only position_id")
		}
		field, value = "audience.position_id", audience.PositionID
	}
	if value == nil {
		return invalid(field, "audience %s needs %s", audience.Kind, field[len("audience."):])
	}
	parsed, err := uuid.Parse(*value)
	if err != nil {
		return invalid(field, "%s must be a UUID", field[len("audience."):])
	}
	if audience.Kind == "department" {
		plan.DepartmentID = parsed.String()
	} else {
		plan.PositionID = parsed.String()
	}
	return nil
}

// resolveGroupTx checks the author's right to address groups, finds the
// department or position and expands it into people of the chat without
// the author. Runs under the organization lock taken by the send path, the
// same lock every write of the org structure takes, so the structure read
// here is the one in force when the request is written.
func resolveGroupTx(ctx context.Context, tx pgx.Tx, user identity.User, chatID string, plan Plan) ([]string, string, error) {
	var role string
	var stored []string
	err := tx.QueryRow(ctx, `
		SELECT org_role, ARRAY(SELECT permission FROM actor_permissions WHERE org_id = $1 AND actor_id = $2)
		FROM actors WHERE org_id = $1 AND id = $2 AND type = 'user' AND status = 'active' AND deleted_at IS NULL`,
		user.OrgID, user.ActorID).Scan(&role, &stored)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, "", ErrForbidden
	}
	if err != nil {
		return nil, "", fmt.Errorf("load request author permissions: %w", err)
	}
	granted := make([]permission.Code, len(stored))
	for index, code := range stored {
		granted[index] = permission.Code(code)
	}
	if !permission.Allows(role, granted, permission.RequestsAddressGroups) {
		return nil, "", ErrAudienceForbidden
	}

	var name string
	var departments, positions []string
	if plan.AudienceKind == "department" {
		err = tx.QueryRow(ctx, `SELECT name FROM departments WHERE org_id = $1 AND id = $2`, user.OrgID, plan.DepartmentID).Scan(&name)
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, "", ErrDepartmentMissing
		}
		departments = []string{plan.DepartmentID}
	} else {
		err = tx.QueryRow(ctx, `SELECT name FROM positions WHERE org_id = $1 AND id = $2`, user.OrgID, plan.PositionID).Scan(&name)
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, "", ErrPositionMissing
		}
		positions = []string{plan.PositionID}
	}
	if err != nil {
		return nil, "", fmt.Errorf("load request audience group: %w", err)
	}
	people, err := orgstructure.Expand(ctx, tx, user.OrgID, departments, positions, chatID)
	if err != nil {
		return nil, "", fmt.Errorf("expand request audience: %w", err)
	}
	result := make([]string, 0, len(people))
	for _, actorID := range people {
		if actorID != user.ActorID {
			result = append(result, actorID)
		}
	}
	return result, truncateRunes(name, MaxLabelRunes), nil
}

// MarshalJSON writes department_id only for the department kind and
// position_id only for the position kind, as null once the group is
// deleted (components/schemas/RequestAudience).
func (a Audience) MarshalJSON() ([]byte, error) {
	wire := struct {
		Kind         string          `json:"kind"`
		Label        string          `json:"label"`
		Count        int             `json:"count"`
		DepartmentID json.RawMessage `json:"department_id,omitempty"`
		PositionID   json.RawMessage `json:"position_id,omitempty"`
	}{Kind: a.Kind, Label: a.Label, Count: a.Count}
	var err error
	switch a.Kind {
	case "department":
		wire.DepartmentID, err = json.Marshal(a.DepartmentID)
	case "position":
		wire.PositionID, err = json.Marshal(a.PositionID)
	}
	if err != nil {
		return nil, err
	}
	return json.Marshal(wire)
}
