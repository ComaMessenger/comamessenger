package message

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strings"

	"github.com/comamessenger/comamessenger/core/internal/identity"
	"github.com/comamessenger/comamessenger/core/internal/orgstructure"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// Department mentions («@отдел», phase 6.5 wave 2). The client sends the
// same token as for a person, @[Зал ЛФК](department id), and lists the
// department in mentioned_department_ids. The server expands each
// department into its active people (with subdepartments, primary and
// additional members) who are members of the chat, the author left out,
// and adds them to mentioned_actor_ids. Push, the mention counter and the
// «you were mentioned» highlight read only mentioned_actor_ids, so nobody
// outside the chat can be notified: the expansion goes through
// chat_members (orgstructure.Expand) and nothing else.

// MaxMentionedDepartments is how many departments one message may mention.
const MaxMentionedDepartments = 10

// DepartmentMention is one mentioned department and how many people it
// notified when the message was sent or last edited
// (components/schemas/MessageDepartmentMention).
type DepartmentMention struct {
	DepartmentID  string `json:"department_id"`
	NotifiedCount int    `json:"notified_count"`
}

// FieldError is a validation failure of one request field; it is
// ErrInvalid and carries details.field for the API.
type FieldError struct {
	Field   string
	Message string
}

func (e *FieldError) Error() string { return ErrInvalid.Error() + ": " + e.Message }
func (e *FieldError) Unwrap() error { return ErrInvalid }

func departmentsInvalid(message string) error {
	return &FieldError{Field: "mentioned_department_ids", Message: message}
}

// normalizeDepartmentIDs checks the ids, writes them in canonical form,
// drops repeats and sorts them. Without the database.
func normalizeDepartmentIDs(ids []string) ([]string, error) {
	seen := make(map[string]struct{}, len(ids))
	normalized := make([]string, 0, len(ids))
	for _, value := range ids {
		parsed, err := uuid.Parse(value)
		if err != nil {
			return nil, departmentsInvalid("mentioned_department_ids must contain UUIDs")
		}
		canonical := parsed.String()
		if _, ok := seen[canonical]; ok {
			continue
		}
		seen[canonical] = struct{}{}
		normalized = append(normalized, canonical)
	}
	if len(normalized) > MaxMentionedDepartments {
		return nil, departmentsInvalid(fmt.Sprintf("a message may mention at most %d departments", MaxMentionedDepartments))
	}
	sort.Strings(normalized)
	return normalized, nil
}

// mentionSet is the result of resolveMentions.
type mentionSet struct {
	// Explicit: people mentioned directly, department ids moved out.
	Explicit []string
	// ActorIDs: the union of Explicit and the expanded departments, sorted;
	// what messages.mentioned_actor_ids stores.
	ActorIDs []string
	// DepartmentIDs: the mentioned departments, sorted.
	DepartmentIDs []string
	// Departments: one entry per department, in DepartmentIDs order.
	Departments []DepartmentMention
}

// classifyMentions moves the ids of this workspace's departments found
// among actorIDs (an older client puts the department token there) into
// departmentIDs, and checks that every department exists in the workspace.
// Both inputs must be normalized.
func classifyMentions(ctx context.Context, tx pgx.Tx, orgID string, actorIDs, departmentIDs []string) ([]string, []string, error) {
	departments := append([]string{}, departmentIDs...)
	explicit := make([]string, 0, len(actorIDs))
	candidates := append(append([]string{}, actorIDs...), departmentIDs...)
	if len(candidates) == 0 {
		return explicit, departments, nil
	}
	rows, err := tx.Query(ctx, `SELECT id FROM departments WHERE org_id = $1 AND id = ANY($2::uuid[])`, orgID, candidates)
	if err != nil {
		return nil, nil, fmt.Errorf("classify message mentions: %w", err)
	}
	known := make(map[string]struct{})
	for rows.Next() {
		var departmentID string
		if err := rows.Scan(&departmentID); err != nil {
			rows.Close()
			return nil, nil, fmt.Errorf("scan mentioned department: %w", err)
		}
		known[departmentID] = struct{}{}
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, nil, fmt.Errorf("classify message mentions: %w", err)
	}
	for _, departmentID := range departments {
		if _, ok := known[departmentID]; !ok {
			return nil, nil, departmentsInvalid("mentioned departments must exist in the workspace")
		}
	}
	for _, actorID := range actorIDs {
		canonical := actorID
		if parsed, err := uuid.Parse(actorID); err == nil {
			canonical = parsed.String()
		}
		if _, ok := known[canonical]; ok {
			departments = append(departments, canonical)
			continue
		}
		explicit = append(explicit, actorID)
	}
	departments, err = normalizeDepartmentIDs(departments)
	if err != nil {
		return nil, nil, err
	}
	return explicit, departments, nil
}

// resolveMentions turns the mentions of a message being sent or edited
// into what is stored: the people mentioned directly must be active members
// of the chat (validateMentions), each department is expanded into its
// active people who are members of the chat, without the author. Called
// under the organization lock, so the structure and the membership read
// are consistent with each other. Both inputs must be normalized.
func resolveMentions(ctx context.Context, tx pgx.Tx, orgID, authorID, chatID string, actorIDs, departmentIDs []string) (mentionSet, error) {
	explicit, departments, err := classifyMentions(ctx, tx, orgID, actorIDs, departmentIDs)
	if err != nil {
		return mentionSet{}, err
	}
	if err := validateMentions(ctx, tx, orgID, chatID, explicit); err != nil {
		return mentionSet{}, err
	}
	result := mentionSet{Explicit: explicit, DepartmentIDs: departments, Departments: make([]DepartmentMention, 0, len(departments))}
	union := make(map[string]struct{}, len(explicit))
	for _, actorID := range explicit {
		union[actorID] = struct{}{}
	}
	for _, departmentID := range departments {
		people, err := orgstructure.Expand(ctx, tx, orgID, []string{departmentID}, nil, chatID)
		if err != nil {
			if errors.Is(err, orgstructure.ErrInvalid) {
				return mentionSet{}, departmentsInvalid("mentioned_department_ids must contain UUIDs")
			}
			return mentionSet{}, err
		}
		notified := 0
		for _, actorID := range people {
			if actorID == authorID {
				continue
			}
			notified++
			union[actorID] = struct{}{}
		}
		result.Departments = append(result.Departments, DepartmentMention{DepartmentID: departmentID, NotifiedCount: notified})
	}
	result.ActorIDs = make([]string, 0, len(union))
	for actorID := range union {
		result.ActorIDs = append(result.ActorIDs, actorID)
	}
	sort.Strings(result.ActorIDs)
	return result, nil
}

// storeDepartmentMentions writes the departments of a message just
// inserted or updated. A message without departments, inserted, needs no
// write: the columns default to empty.
func storeDepartmentMentions(ctx context.Context, tx pgx.Tx, orgID, messageID string, mentions mentionSet, inserted bool) error {
	if inserted && len(mentions.DepartmentIDs) == 0 {
		return nil
	}
	departments := mentions.Departments
	if departments == nil {
		departments = []DepartmentMention{}
	}
	payload, err := json.Marshal(departments)
	if err != nil {
		return fmt.Errorf("encode mentioned departments: %w", err)
	}
	ids := mentions.DepartmentIDs
	if ids == nil {
		ids = []string{}
	}
	if _, err := tx.Exec(ctx, `UPDATE messages SET mentioned_department_ids = $3, mentioned_departments = $4::jsonb WHERE org_id = $1 AND id = $2`,
		orgID, messageID, ids, string(payload)); err != nil {
		return fmt.Errorf("store mentioned departments: %w", err)
	}
	return nil
}

// hydrateDepartmentMentions fills MentionedDepartmentIDs and
// MentionedDepartments: one query per batch. Called by hydrateFiles, so
// every reader of messages, realtime frames included, gets them.
func hydrateDepartmentMentions(ctx context.Context, tx pgx.Tx, orgID string, messages []Message) error {
	if len(messages) == 0 {
		return nil
	}
	ids := make([]string, len(messages))
	indexByID := make(map[string][]int, len(messages))
	for index := range messages {
		ids[index] = messages[index].ID
		indexByID[messages[index].ID] = append(indexByID[messages[index].ID], index)
		empty, none := []string{}, []DepartmentMention{}
		messages[index].MentionedDepartmentIDs = &empty
		messages[index].MentionedDepartments = &none
	}
	rows, err := tx.Query(ctx, `
		SELECT id, mentioned_department_ids, mentioned_departments FROM messages
		WHERE org_id = $1 AND id = ANY($2::uuid[]) AND cardinality(mentioned_department_ids) > 0`, orgID, ids)
	if err != nil {
		return fmt.Errorf("load mentioned departments: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var messageID string
		var departmentIDs []string
		var raw []byte
		if err := rows.Scan(&messageID, &departmentIDs, &raw); err != nil {
			return fmt.Errorf("scan mentioned departments: %w", err)
		}
		var departments []DepartmentMention
		if err := json.Unmarshal(raw, &departments); err != nil {
			return fmt.Errorf("decode mentioned departments: %w", err)
		}
		if departments == nil {
			departments = []DepartmentMention{}
		}
		for _, index := range indexByID[messageID] {
			idsCopy := append([]string{}, departmentIDs...)
			departmentsCopy := append([]DepartmentMention{}, departments...)
			messages[index].MentionedDepartmentIDs = &idsCopy
			messages[index].MentionedDepartments = &departmentsCopy
		}
	}
	return rows.Err()
}

// departmentsFingerprint is the part of the idempotency fingerprint for the
// mentioned departments; empty without any, so the fingerprints of every
// other message stay as they were.
func departmentsFingerprint(departmentIDs []string) string {
	if len(departmentIDs) == 0 {
		return ""
	}
	return "\x00departments\x00" + strings.Join(departmentIDs, ",")
}

// ClassifyMentionsTx moves department ids sent among the people into
// MentionedDepartmentIDs and checks that the departments exist, so a
// scheduled message stores people and departments apart. It expands
// nothing: departments are expanded only when the message is sent. input
// must be validated by ValidateCreate.
func (s *Service) ClassifyMentionsTx(ctx context.Context, tx pgx.Tx, orgID string, input *CreateInput) error {
	explicit, departments, err := classifyMentions(ctx, tx, orgID, input.MentionedActorIDs, input.MentionedDepartmentIDs)
	if err != nil {
		return err
	}
	input.MentionedActorIDs, input.MentionedDepartmentIDs = explicit, departments
	return nil
}

// resolveEditedMentions is resolveMentions for an edit: the ids come
// straight from the request, so they are normalized first. A field left
// out of the edit counts as empty once the other one is sent.
func (s *Service) resolveEditedMentions(ctx context.Context, tx pgx.Tx, user identity.User, chatID string, actorIDs, departmentIDs []string) (mentionSet, error) {
	actors, err := normalizeActorIDs(actorIDs)
	if err != nil {
		return mentionSet{}, err
	}
	departments, err := normalizeDepartmentIDs(departmentIDs)
	if err != nil {
		return mentionSet{}, err
	}
	return resolveMentions(ctx, tx, user.OrgID, user.ActorID, chatID, actors, departments)
}
