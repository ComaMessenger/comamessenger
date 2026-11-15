package orgstructure

import (
	"bytes"
	"encoding/json"

	"github.com/comamessenger/comamessenger/core/internal/chat"
)

// Limits of the org structure (phase 6.5, «Лимиты»).
const (
	MaxDepartments           = 500
	MaxPositions             = 300
	MaxAdditionalDepartments = 10
	MaxDepth                 = 8
	MaxNameLength            = 60
	MaxCreateMembers         = 200
	MaxAssignPeople          = 200
	MaxBulkPositions         = 100
	MaxTitleSuggestions      = 200
)

// Reasons carried by org.updated.
const (
	ReasonDepartment   = "department"
	ReasonPosition     = "position"
	ReasonMembership   = "membership"
	ReasonPersonStatus = "person_status"
)

type Department struct {
	ID           string  `json:"id"`
	ParentID     *string `json:"parent_id"`
	Name         string  `json:"name"`
	LeadActorID  *string `json:"lead_actor_id"`
	ChatID       *string `json:"chat_id"`
	HasChat      bool    `json:"has_chat"`
	ChatArchived bool    `json:"chat_archived"`
	SortKey      *int32  `json:"sort_key"`
	Version      int32   `json:"version"`
}

type Position struct {
	ID      string `json:"id"`
	Name    string `json:"name"`
	SortKey *int32 `json:"sort_key"`
	Version int32  `json:"version"`
}

type Person struct {
	ActorID                 string   `json:"actor_id"`
	PrimaryDepartmentID     *string  `json:"primary_department_id"`
	AdditionalDepartmentIDs []string `json:"additional_department_ids"`
	PositionID              *string  `json:"position_id"`
}

type Structure struct {
	Version     int64        `json:"version"`
	Departments []Department `json:"departments"`
	Positions   []Position   `json:"positions"`
	People      []Person     `json:"people"`
}

type MemberInput struct {
	ActorID string `json:"actor_id"`
	Primary bool   `json:"primary"`
}

type CreateDepartmentInput struct {
	Name        string        `json:"name"`
	ParentID    *string       `json:"parent_id"`
	LeadActorID *string       `json:"lead_actor_id"`
	Members     []MemberInput `json:"members"`
}

// OptionalID tells a field left out from an explicit null.
type OptionalID struct {
	Set   bool
	Value *string
}

func (o *OptionalID) UnmarshalJSON(data []byte) error {
	o.Set = true
	if bytes.Equal(bytes.TrimSpace(data), []byte("null")) {
		o.Value = nil
		return nil
	}
	var value string
	if err := json.Unmarshal(data, &value); err != nil {
		return err
	}
	o.Value = &value
	return nil
}

type UpdateDepartmentInput struct {
	Name            *string    `json:"name"`
	ParentID        OptionalID `json:"parent_id"`
	LeadActorID     OptionalID `json:"lead_actor_id"`
	ExpectedVersion int32      `json:"expected_version"`
}

type MoveDepartmentInput struct {
	Direction string `json:"direction"`
}

type DepartmentWrite struct {
	Department Department `json:"department"`
	Version    int64      `json:"version"`
}

type SetDepartmentMemberInput struct {
	Primary      bool `json:"primary"`
	KeepPrevious bool `json:"keep_previous"`
}

type SetPersonInput struct {
	PrimaryDepartmentID     *string  `json:"primary_department_id"`
	AdditionalDepartmentIDs []string `json:"additional_department_ids"`
	PositionID              *string  `json:"position_id"`
	ExpectedOrgVersion      *int64   `json:"expected_org_version"`
}

type PersonWrite struct {
	Person  Person `json:"person"`
	Version int64  `json:"version"`
}

type AssignPeopleInput struct {
	ActorIDs            []string   `json:"actor_ids"`
	PrimaryDepartmentID *string    `json:"primary_department_id"`
	AddDepartmentID     *string    `json:"add_department_id"`
	PositionID          OptionalID `json:"position_id"`
}

type AssignPeopleResult struct {
	People  []Person `json:"people"`
	Version int64    `json:"version"`
}

type CreatePositionInput struct {
	Name string `json:"name"`
}

type CreatePositionsInput struct {
	Names []string `json:"names"`
}

type UpdatePositionInput struct {
	Name            *string `json:"name"`
	ExpectedVersion int32   `json:"expected_version"`
}

type PositionWrite struct {
	Position Position `json:"position"`
	Version  int64    `json:"version"`
}

type CreatePositionsResult struct {
	Created []Position `json:"created"`
	Skipped []string   `json:"skipped"`
	Version int64      `json:"version"`
}

type TitleSuggestion struct {
	Title    string   `json:"title"`
	Count    int      `json:"count"`
	ActorIDs []string `json:"actor_ids"`
}

type TitleSuggestionList struct {
	Suggestions []TitleSuggestion `json:"suggestions"`
}

type LinkDepartmentChatInput struct {
	ChatID string `json:"chat_id"`
}

type DepartmentChatResult struct {
	Chat       chat.Chat  `json:"chat"`
	Department Department `json:"department"`
	Version    int64      `json:"version"`
}

type DepartmentChatMissing struct {
	Actors []chat.Actor `json:"actors"`
}

type DepartmentChatAddMissingResult struct {
	Added int `json:"added"`
}
