package task

import (
	"encoding/json"
	"slices"
)

// Viewer is the reader's standing in the chat of a task, read from the
// database on every action (never from the session).
type Viewer struct {
	ActorID  string
	Member   bool   // an active member of the chat now
	ChatRole string // chat_members.role; "" for non-members
	// Moderator: a workspace moderator with chats.moderate; counts as a chat
	// admin while a member of the chat.
	Moderator bool
}

// Admin is a chat owner or admin, or a moderator in the chat.
func (v Viewer) Admin() bool {
	if !v.Member || v.ChatRole == "" {
		return false
	}
	return v.ChatRole == "owner" || v.ChatRole == "admin" || v.Moderator
}

// Permissions is decision 5's table for one reader. Clients compute the
// same from MessageTask (packages/core taskPermissions); the shared examples
// are packages/core/src/fixtures/taskPermissions.json.
type Permissions struct {
	Edit        bool
	Reassign    bool
	Start       bool
	Stop        bool
	Complete    bool
	Reopen      bool
	Cancel      bool
	Restore     bool
	ManageItems bool
	CheckItems  []string
	Nudge       bool
	Take        bool
}

// PermissionsOf computes what viewer may do with t, whose message was
// written by authorID. A closed task is frozen: only «Вернуть в работу»
// (done) and «Вернуть» (canceled) remain.
func PermissionsOf(t *Task, authorID string, viewer Viewer, limits Limits) Permissions {
	var result Permissions
	result.CheckItems = []string{}
	if !viewer.Member || viewer.ChatRole == "" {
		return result
	}
	me := viewer.ActorID
	admin := viewer.Admin()
	author := authorID == me
	responsible := t.Assignee.ActorID != nil && *t.Assignee.ActorID == me
	manager := author || admin
	worker := manager || responsible
	active := Active(t.Status)
	result.Edit = manager && active
	result.Reassign = manager && active
	result.Start = worker && t.Status == StatusOpen
	result.Stop = worker && t.Status == StatusInProgress
	result.Complete = worker && active
	result.Reopen = worker && t.Status == StatusDone
	result.Cancel = manager && active
	result.Restore = manager && t.Status == StatusCanceled
	result.ManageItems = worker && active
	if active {
		for _, item := range t.Items {
			if worker || (item.AssigneeID != nil && *item.AssigneeID == me) {
				result.CheckItems = append(result.CheckItems, item.ID)
			}
		}
	}
	someone := false
	if t.Queue() {
		someone = slices.ContainsFunc(t.Assignee.CandidateIDs, func(id string) bool { return id != me })
	} else {
		someone = t.Assignee.ActorID != nil && *t.Assignee.ActorID != me
	}
	result.Nudge = manager && active && someone && t.NudgeCount < limits.NudgeMax
	result.Take = active && t.Queue() && slices.Contains(t.Assignee.CandidateIDs, me)
	return result
}

// CanCheck reports whether the viewer may mark the item done or not done.
func (p Permissions) CanCheck(itemID string) bool { return slices.Contains(p.CheckItems, itemID) }

// TransitionAllowed: open ↔ in_progress, open | in_progress → done | canceled,
// done → open, canceled → open.
func TransitionAllowed(from, to string) bool {
	if from == to {
		return false
	}
	switch from {
	case StatusOpen:
		return to == StatusInProgress || to == StatusDone || to == StatusCanceled
	case StatusInProgress:
		return to == StatusOpen || to == StatusDone || to == StatusCanceled
	case StatusDone, StatusCanceled:
		return to == StatusOpen
	}
	return false
}

// CanSetStatus reports whether the permissions allow the move from → to.
func (p Permissions) CanSetStatus(from, to string) bool {
	if !TransitionAllowed(from, to) {
		return false
	}
	switch to {
	case StatusInProgress:
		return p.Start
	case StatusDone:
		return p.Complete
	case StatusCanceled:
		return p.Cancel
	case StatusOpen:
		switch from {
		case StatusInProgress:
			return p.Stop
		case StatusDone:
			return p.Reopen
		default:
			return p.Restore
		}
	}
	return false
}

// MarshalJSON writes department_id and position_id only for their kind.
func (a Assignee) MarshalJSON() ([]byte, error) {
	candidates := a.CandidateIDs
	if candidates == nil {
		candidates = []string{}
	}
	value := map[string]any{
		"kind": a.Kind, "actor_id": a.ActorID, "label": a.Label,
		"candidate_ids": candidates, "in_chat": a.InChat,
	}
	if a.DepartmentID.Set {
		value["department_id"] = a.DepartmentID.Value
	}
	if a.PositionID.Set {
		value["position_id"] = a.PositionID.Value
	}
	return json.Marshal(value)
}

// UnmarshalJSON reads what MarshalJSON writes.
func (a *Assignee) UnmarshalJSON(data []byte) error {
	var raw struct {
		Kind         string   `json:"kind"`
		ActorID      *string  `json:"actor_id"`
		Label        string   `json:"label"`
		CandidateIDs []string `json:"candidate_ids"`
		InChat       bool     `json:"in_chat"`
	}
	if err := json.Unmarshal(data, &raw); err != nil {
		return err
	}
	*a = Assignee{Kind: raw.Kind, ActorID: raw.ActorID, Label: raw.Label, CandidateIDs: raw.CandidateIDs, InChat: raw.InChat}
	var probe map[string]json.RawMessage
	if err := json.Unmarshal(data, &probe); err != nil {
		return err
	}
	for key, target := range map[string]*OptionalID{"department_id": &a.DepartmentID, "position_id": &a.PositionID} {
		if value, ok := probe[key]; ok {
			target.Set = true
			var id *string
			if err := json.Unmarshal(value, &id); err != nil {
				return err
			}
			target.Value = id
		}
	}
	return nil
}
