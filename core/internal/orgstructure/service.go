// Package orgstructure keeps the org structure of a workspace (phase 6.5,
// wave 2): departments with nesting, leads and memberships, the directory of
// positions, and the expansion of a department or a position into people.
//
// Every write runs in one transaction that, in the global lock order of the
// server (the organization row first, as message and scheduled delivery do):
//
//  1. locks the organization row (lockOrganization);
//  2. locks the actors rows whose own row it changes (position_id), in id
//     order;
//  3. locks departments / positions rows FOR UPDATE, then writes
//     department_members and actors;
//  4. raises organizations.org_version by one and appends one org.updated
//     event when something changed.
//
// A transaction aborted by a deadlock or a serialization failure is retried.
package orgstructure

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strings"
	"unicode/utf8"

	"github.com/comamessenger/comamessenger/core/internal/chat"
	"github.com/comamessenger/comamessenger/core/internal/id"
	"github.com/comamessenger/comamessenger/core/internal/identity"
	"github.com/comamessenger/comamessenger/core/internal/permission"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

const writeAttempts = 4

type Service struct {
	pool        *pgxpool.Pool
	chats       *chat.Service
	afterCommit func(string, int64)
}

func NewService(pool *pgxpool.Pool, chats *chat.Service, afterCommit func(string, int64)) *Service {
	return &Service{pool: pool, chats: chats, afterCommit: afterCommit}
}

// CanManage reports whether the user may write the org structure.
func CanManage(user identity.User) bool {
	return permission.CanManageOrg(user.OrgRole, user.Permissions)
}

// Querier is what Expand reads through: a pool or a transaction.
type Querier interface {
	Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error)
}

// Expand returns the active people (not agents) of the departments — with
// their subdepartments, primary and additional members — and of the
// positions, who are members of the chat. The intersection with chat_members
// is mandatory: a mention or a request can only ever reach people of the
// chat. The author is not excluded here; callers do it. Ids are unique and
// sorted. Call it inside the transaction that locked the organization to see
// a consistent structure.
func Expand(ctx context.Context, q Querier, orgID string, departmentIDs, positionIDs []string, chatID string) ([]string, error) {
	if chatID == "" || uuid.Validate(chatID) != nil {
		return nil, fmt.Errorf("%w: expand needs a chat", ErrInvalid)
	}
	return expand(ctx, q, orgID, departmentIDs, positionIDs, chatID)
}

// expandAll is Expand without the chat: who belongs to a department, for its
// own chat. It is not exported so that no message path can skip the chat.
func expandAll(ctx context.Context, q Querier, orgID string, departmentIDs []string) ([]string, error) {
	return expand(ctx, q, orgID, departmentIDs, nil, "")
}

func expand(ctx context.Context, q Querier, orgID string, departmentIDs, positionIDs []string, chatID string) ([]string, error) {
	for _, value := range append(append([]string(nil), departmentIDs...), positionIDs...) {
		if uuid.Validate(value) != nil {
			return nil, fmt.Errorf("%w: invalid id", ErrInvalid)
		}
	}
	if len(departmentIDs) == 0 && len(positionIDs) == 0 {
		return []string{}, nil
	}
	if departmentIDs == nil {
		departmentIDs = []string{}
	}
	if positionIDs == nil {
		positionIDs = []string{}
	}
	rows, err := q.Query(ctx, `
		WITH RECURSIVE tree AS (
			SELECT d.id FROM departments d WHERE d.org_id = $1 AND d.id = ANY($2::uuid[])
			UNION
			SELECT child.id FROM departments child JOIN tree ON child.parent_id = tree.id
			WHERE child.org_id = $1
		), people AS (
			SELECT dm.actor_id FROM department_members dm JOIN tree ON dm.department_id = tree.id
			WHERE dm.org_id = $1
			UNION
			SELECT a.id FROM actors a WHERE a.org_id = $1 AND a.position_id = ANY($3::uuid[])
		)
		SELECT a.id FROM people p
		JOIN actors a ON a.org_id = $1 AND a.id = p.actor_id
		WHERE a.type = 'user' AND a.status = 'active' AND a.deleted_at IS NULL
		  AND (NULLIF($4, '') IS NULL OR EXISTS (
			SELECT 1 FROM chat_members cm
			WHERE cm.org_id = $1 AND cm.chat_id = NULLIF($4, '')::uuid AND cm.actor_id = a.id
		  ))
		ORDER BY a.id`, orgID, departmentIDs, positionIDs, chatID)
	if err != nil {
		return nil, fmt.Errorf("expand org structure: %w", err)
	}
	defer rows.Close()
	result := make([]string, 0)
	for rows.Next() {
		var actorID string
		if err := rows.Scan(&actorID); err != nil {
			return nil, err
		}
		result = append(result, actorID)
	}
	return result, rows.Err()
}

// Version is the current org_version; GET /org answers 304 by it.
func (s *Service) Version(ctx context.Context, user identity.User) (int64, error) {
	var version int64
	err := s.pool.QueryRow(ctx, `
		SELECT o.org_version FROM organizations o
		JOIN actors viewer ON viewer.org_id = o.id AND viewer.id = $2
		WHERE o.id = $1 AND viewer.type = 'user' AND viewer.status = 'active' AND viewer.deleted_at IS NULL`, user.OrgID, user.ActorID).Scan(&version)
	if errors.Is(err, pgx.ErrNoRows) {
		return 0, ErrForbidden
	}
	return version, err
}

// Structure reads the whole structure in one snapshot. Every active person
// of the workspace may read it; agents may not.
func (s *Service) Structure(ctx context.Context, user identity.User) (Structure, error) {
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return Structure{}, err
	}
	defer tx.Rollback(ctx)
	var result Structure
	err = tx.QueryRow(ctx, `
		SELECT o.org_version FROM organizations o
		JOIN actors viewer ON viewer.org_id = o.id AND viewer.id = $2
		WHERE o.id = $1 AND viewer.type = 'user' AND viewer.status = 'active' AND viewer.deleted_at IS NULL`, user.OrgID, user.ActorID).Scan(&result.Version)
	if errors.Is(err, pgx.ErrNoRows) {
		return Structure{}, ErrForbidden
	}
	if err != nil {
		return Structure{}, fmt.Errorf("read org version: %w", err)
	}
	if result.Departments, err = readDepartments(ctx, tx, user, ""); err != nil {
		return Structure{}, err
	}
	if result.Positions, err = readPositions(ctx, tx, user.OrgID, ""); err != nil {
		return Structure{}, err
	}
	if result.People, err = readPeople(ctx, tx, user.OrgID, nil); err != nil {
		return Structure{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Structure{}, err
	}
	return result, nil
}

type rowQuerier interface {
	Querier
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
}

// readDepartments reads one department (id set) or all of them, as the
// viewer may see them: chat_id only for members of that chat, the lead only
// while active.
func readDepartments(ctx context.Context, q Querier, viewer identity.User, departmentID string) ([]Department, error) {
	rows, err := q.Query(ctx, `
		SELECT d.id, d.parent_id, d.name,
		       CASE WHEN lead.id IS NOT NULL THEN d.lead_actor_id END,
		       CASE WHEN EXISTS (
		           SELECT 1 FROM chat_members cm
		           WHERE cm.org_id = d.org_id AND cm.chat_id = d.chat_id AND cm.actor_id = $2
		       ) THEN d.chat_id END,
		       d.chat_id IS NOT NULL,
		       COALESCE(c.archived_at IS NOT NULL, false),
		       d.sort_key, d.version
		FROM departments d
		LEFT JOIN actors lead ON lead.org_id = d.org_id AND lead.id = d.lead_actor_id
		     AND lead.status = 'active' AND lead.deleted_at IS NULL
		LEFT JOIN chats c ON c.org_id = d.org_id AND c.id = d.chat_id
		WHERE d.org_id = $1 AND (NULLIF($3, '') IS NULL OR d.id = NULLIF($3, '')::uuid)
		ORDER BY d.parent_id NULLS FIRST, d.sort_key NULLS LAST, lower(d.name), d.id`, viewer.OrgID, viewer.ActorID, departmentID)
	if err != nil {
		return nil, fmt.Errorf("read departments: %w", err)
	}
	defer rows.Close()
	result := make([]Department, 0)
	for rows.Next() {
		var item Department
		if err := rows.Scan(&item.ID, &item.ParentID, &item.Name, &item.LeadActorID, &item.ChatID, &item.HasChat, &item.ChatArchived, &item.SortKey, &item.Version); err != nil {
			return nil, fmt.Errorf("scan department: %w", err)
		}
		result = append(result, item)
	}
	return result, rows.Err()
}

func readDepartment(ctx context.Context, q Querier, viewer identity.User, departmentID string) (Department, error) {
	items, err := readDepartments(ctx, q, viewer, departmentID)
	if err != nil {
		return Department{}, err
	}
	if len(items) != 1 {
		return Department{}, ErrDepartmentNotFound
	}
	return items[0], nil
}

func readPositions(ctx context.Context, q Querier, orgID, positionID string) ([]Position, error) {
	rows, err := q.Query(ctx, `
		SELECT id, name, sort_key, version FROM positions
		WHERE org_id = $1 AND (NULLIF($2, '') IS NULL OR id = NULLIF($2, '')::uuid)
		ORDER BY sort_key NULLS LAST, lower(name), id`, orgID, positionID)
	if err != nil {
		return nil, fmt.Errorf("read positions: %w", err)
	}
	defer rows.Close()
	result := make([]Position, 0)
	for rows.Next() {
		var item Position
		if err := rows.Scan(&item.ID, &item.Name, &item.SortKey, &item.Version); err != nil {
			return nil, fmt.Errorf("scan position: %w", err)
		}
		result = append(result, item)
	}
	return result, rows.Err()
}

// readPeople reads the assignment of active people: everyone with a
// membership or a position, or exactly actorIDs (also those with neither).
func readPeople(ctx context.Context, q Querier, orgID string, actorIDs []string) ([]Person, error) {
	rows, err := q.Query(ctx, `
		SELECT a.id,
		       (SELECT dm.department_id FROM department_members dm
		        WHERE dm.org_id = a.org_id AND dm.actor_id = a.id AND dm.is_primary),
		       ARRAY(SELECT dm.department_id FROM department_members dm
		             WHERE dm.org_id = a.org_id AND dm.actor_id = a.id AND NOT dm.is_primary
		             ORDER BY dm.created_at, dm.department_id)::text[],
		       a.position_id
		FROM actors a
		WHERE a.org_id = $1 AND a.type = 'user' AND a.status = 'active' AND a.deleted_at IS NULL
		  AND CASE WHEN $2::uuid[] IS NULL
		           THEN a.position_id IS NOT NULL OR EXISTS (SELECT 1 FROM department_members dm WHERE dm.org_id = a.org_id AND dm.actor_id = a.id)
		           ELSE a.id = ANY($2::uuid[]) END
		ORDER BY a.id`, orgID, nullableIDs(actorIDs))
	if err != nil {
		return nil, fmt.Errorf("read people: %w", err)
	}
	defer rows.Close()
	result := make([]Person, 0)
	for rows.Next() {
		var item Person
		if err := rows.Scan(&item.ActorID, &item.PrimaryDepartmentID, &item.AdditionalDepartmentIDs, &item.PositionID); err != nil {
			return nil, fmt.Errorf("scan person: %w", err)
		}
		if item.AdditionalDepartmentIDs == nil {
			item.AdditionalDepartmentIDs = []string{}
		}
		result = append(result, item)
	}
	return result, rows.Err()
}

func nullableIDs(values []string) any {
	if values == nil {
		return nil
	}
	return values
}

// change collects what one write did.
type change struct {
	reason   string
	changed  bool
	audits   []auditEntry
	lockedTo map[string]bool
}

type auditEntry struct {
	action     string
	targetType string
	targetID   string
	metadata   map[string]any
}

func (c *change) touch(reason string) {
	c.changed = true
	if c.reason == "" {
		c.reason = reason
	}
}

func (c *change) audit(action, targetType, targetID string, metadata map[string]any) {
	c.audits = append(c.audits, auditEntry{action: action, targetType: targetType, targetID: targetID, metadata: metadata})
}

type writeOptions struct {
	// lockActors are actors whose own row the write changes (position_id).
	lockActors []string
	// lockActorsNow, when set, reads them under the organization lock.
	lockActorsNow func(context.Context, pgx.Tx) ([]string, error)
	// authorize runs first inside the transaction; nil means CanManage.
	authorize func(context.Context, pgx.Tx) error
}

// write runs fn in the org structure transaction (see the package comment)
// and returns the org version after it.
func (s *Service) write(ctx context.Context, user identity.User, options writeOptions, fn func(context.Context, pgx.Tx, *change) error) (int64, error) {
	if options.authorize == nil && !CanManage(user) {
		return 0, ErrForbidden
	}
	var lastErr error
	for attempt := 0; attempt < writeAttempts; attempt++ {
		version, seq, err := s.writeOnce(ctx, user, options, fn)
		if err == nil {
			if seq > 0 && s.afterCommit != nil {
				s.afterCommit(user.OrgID, seq)
			}
			return version, nil
		}
		if !retryable(err) {
			return 0, err
		}
		lastErr = err
	}
	return 0, lastErr
}

func (s *Service) writeOnce(ctx context.Context, user identity.User, options writeOptions, fn func(context.Context, pgx.Tx, *change) error) (int64, int64, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return 0, 0, err
	}
	defer tx.Rollback(ctx)
	if err := lockOrganization(ctx, tx, user.OrgID); err != nil {
		return 0, 0, err
	}
	locked := options.lockActors
	if options.lockActorsNow != nil {
		if locked, err = options.lockActorsNow(ctx, tx); err != nil {
			return 0, 0, err
		}
	}
	if err := lockActors(ctx, tx, user.OrgID, locked); err != nil {
		return 0, 0, err
	}
	caller, err := storedCaller(ctx, tx, user)
	if err != nil {
		return 0, 0, err
	}
	if options.authorize == nil && !CanManage(caller) {
		return 0, 0, ErrForbidden
	}
	if options.authorize != nil {
		if err := options.authorize(ctx, tx); err != nil {
			return 0, 0, err
		}
	}
	work := &change{}
	if err := fn(ctx, tx, work); err != nil {
		return 0, 0, translate(err)
	}
	version, seq, err := finish(ctx, tx, user, work)
	if err != nil {
		return 0, 0, translate(err)
	}
	if err := tx.Commit(ctx); err != nil {
		return 0, 0, translate(err)
	}
	return version, seq, nil
}

// finish writes the audit entries and, when something changed, raises
// org_version and appends org.updated.
func finish(ctx context.Context, tx pgx.Tx, user identity.User, work *change) (int64, int64, error) {
	for _, entry := range work.audits {
		if err := writeAudit(ctx, tx, user, entry); err != nil {
			return 0, 0, err
		}
	}
	if !work.changed {
		var version int64
		err := tx.QueryRow(ctx, `SELECT org_version FROM organizations WHERE id = $1`, user.OrgID).Scan(&version)
		return version, 0, err
	}
	version, seq, err := BumpVersion(ctx, tx, user.OrgID, user.ActorID, work.reason)
	return version, seq, err
}

// BumpVersion raises org_version by one and appends org.updated for the
// whole workspace in tx. The organization row must be locked by tx (or be
// lockable without waiting on rows tx holds, see the package comment).
// actorID is who made the change and may be empty.
func BumpVersion(ctx context.Context, tx pgx.Tx, orgID, actorID, reason string) (int64, int64, error) {
	var version, seq int64
	if err := tx.QueryRow(ctx, `
		UPDATE organizations SET org_version = org_version + 1, event_seq = event_seq + 1
		WHERE id = $1 RETURNING org_version, event_seq`, orgID).Scan(&version, &seq); err != nil {
		return 0, 0, fmt.Errorf("advance org version: %w", err)
	}
	data, err := json.Marshal(map[string]any{"version": version, "reason": reason})
	if err != nil {
		return 0, 0, err
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO events(org_id, seq, type, actor_id, subject_id, data)
		VALUES ($1, $2, 'org.updated', NULLIF($3, '')::uuid, $1, $4::jsonb)`, orgID, seq, actorID, string(data)); err != nil {
		return 0, 0, fmt.Errorf("append org.updated: %w", err)
	}
	return version, seq, nil
}

// HasAssignment reports whether a person has a membership, a position or
// leads a department: then a change of their status changes what GET /org
// returns.
func HasAssignment(ctx context.Context, tx pgx.Tx, orgID, actorID string) (bool, error) {
	var found bool
	err := tx.QueryRow(ctx, `
		SELECT EXISTS (SELECT 1 FROM department_members WHERE org_id = $1 AND actor_id = $2)
		    OR EXISTS (SELECT 1 FROM departments WHERE org_id = $1 AND lead_actor_id = $2)
		    OR EXISTS (SELECT 1 FROM actors WHERE org_id = $1 AND id = $2 AND position_id IS NOT NULL)`, orgID, actorID).Scan(&found)
	return found, err
}

func writeAudit(ctx context.Context, tx pgx.Tx, user identity.User, entry auditEntry) error {
	auditID, err := id.New()
	if err != nil {
		return err
	}
	metadata := entry.metadata
	if metadata == nil {
		metadata = map[string]any{}
	}
	encoded, err := json.Marshal(metadata)
	if err != nil {
		return err
	}
	var target any
	if entry.targetID != "" {
		target = entry.targetID
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO audit_log(id, org_id, actor_id, action, target_type, target_id, metadata)
		VALUES ($1, $2, $3, $4, $5, $6, $7)`, auditID, user.OrgID, user.ActorID, entry.action, entry.targetType, target, encoded); err != nil {
		return fmt.Errorf("write org audit: %w", err)
	}
	return nil
}

func lockOrganization(ctx context.Context, tx pgx.Tx, orgID string) error {
	var seq int64
	if err := tx.QueryRow(ctx, `UPDATE organizations SET event_seq = event_seq WHERE id = $1 RETURNING event_seq`, orgID).Scan(&seq); err != nil {
		return fmt.Errorf("lock organization: %w", err)
	}
	return nil
}

func lockActors(ctx context.Context, tx pgx.Tx, orgID string, actorIDs []string) error {
	if len(actorIDs) == 0 {
		return nil
	}
	ids := uniqueSorted(actorIDs)
	for _, value := range ids {
		if uuid.Validate(value) != nil {
			return invalid("actor_id", "actor_id must be a UUID")
		}
	}
	// NO KEY UPDATE, as workspace.UpdateMember: foreign key checks of
	// memberships (FOR KEY SHARE) do not wait for it.
	rows, err := tx.Query(ctx, `
		SELECT id FROM actors WHERE org_id = $1 AND id = ANY($2::uuid[])
		ORDER BY id FOR NO KEY UPDATE`, orgID, ids)
	if err != nil {
		return fmt.Errorf("lock actors: %w", err)
	}
	rows.Close()
	return rows.Err()
}

// storedCaller reads the caller's role and permissions as stored now; an
// inactive caller or an agent is refused. Inside a write it runs after the
// organization lock, so a grant revoked while the request waited no longer
// counts.
func storedCaller(ctx context.Context, q departmentQuerier, user identity.User) (identity.User, error) {
	var role string
	var stored []string
	err := q.QueryRow(ctx, `
		SELECT org_role, ARRAY(SELECT permission FROM actor_permissions WHERE org_id = $1 AND actor_id = $2)
		FROM actors WHERE org_id = $1 AND id = $2 AND type = 'user' AND status = 'active' AND deleted_at IS NULL`,
		user.OrgID, user.ActorID).Scan(&role, &stored)
	if errors.Is(err, pgx.ErrNoRows) {
		return identity.User{}, ErrForbidden
	}
	if err != nil {
		return identity.User{}, err
	}
	granted := make([]permission.Code, len(stored))
	for index, code := range stored {
		granted[index] = permission.Code(code)
	}
	result := user
	result.OrgRole, result.Permissions = role, permission.Effective(role, granted)
	return result, nil
}

func requireActiveCaller(ctx context.Context, tx pgx.Tx, user identity.User) error {
	_, err := storedCaller(ctx, tx, user)
	return err
}

// errStale asks write to run the transaction again: something read before
// the locks changed meanwhile.
var errStale = errors.New("org structure read went stale")

func retryable(err error) bool {
	if errors.Is(err, errStale) {
		return true
	}
	var databaseError *pgconn.PgError
	return errors.As(err, &databaseError) && (databaseError.Code == "40001" || databaseError.Code == "40P01")
}

// translate turns constraint violations into contract errors.
func translate(err error) error {
	var databaseError *pgconn.PgError
	if !errors.As(err, &databaseError) {
		return err
	}
	switch databaseError.ConstraintName {
	case "departments_sibling_name_idx":
		return nameTaken("name")
	case "positions_name_idx":
		return nameTaken("name")
	case "departments_chat_idx":
		return &Error{Kind: ErrChatExists, Message: "The chat is linked to another department."}
	case "department_members_primary_idx":
		// Two concurrent writes for one person; the retry sees the winner.
		return err
	}
	return err
}

func validateName(field, value string) (string, error) {
	value = strings.TrimSpace(value)
	if count := utf8.RuneCountInString(value); count < 1 || count > MaxNameLength {
		return "", invalid(field, "%s must contain 1 to %d characters", field, MaxNameLength)
	}
	if strings.ContainsAny(value, "\x00\r\n") {
		return "", invalid(field, "%s must be a single line", field)
	}
	return value, nil
}

func validateID(field, value string) error {
	if uuid.Validate(value) != nil {
		return invalid(field, "%s must be a UUID", field)
	}
	return nil
}

func uniqueSorted(values []string) []string {
	seen := make(map[string]struct{}, len(values))
	result := make([]string, 0, len(values))
	for _, value := range values {
		if _, ok := seen[value]; ok {
			continue
		}
		seen[value] = struct{}{}
		result = append(result, value)
	}
	sort.Strings(result)
	return result
}
