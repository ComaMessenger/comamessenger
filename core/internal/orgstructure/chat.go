package orgstructure

import (
	"context"
	"errors"
	"fmt"

	"slices"
	"strings"

	"github.com/comamessenger/comamessenger/core/internal/chat"
	"github.com/comamessenger/comamessenger/core/internal/identity"
	"github.com/jackc/pgx/v5"
)

// The department chat: the lead of the department and whoever manages the
// org structure may create or link it; adding the missing people also needs
// the right to add members in the chat itself. The id of a chat is only
// ever returned to its members.

type departmentQuerier interface {
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
}

// authorizeDepartmentChat allows the lead of the department and holders of
// org.manage or members.manage.
func authorizeDepartmentChat(ctx context.Context, q departmentQuerier, user identity.User, departmentID string) error {
	if validateID("department_id", departmentID) != nil {
		return ErrDepartmentNotFound
	}
	var leadID *string
	err := q.QueryRow(ctx, `
		SELECT d.lead_actor_id FROM departments d
		WHERE d.org_id = $1 AND d.id = $2`, user.OrgID, departmentID).Scan(&leadID)
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrDepartmentNotFound
	}
	if err != nil {
		return fmt.Errorf("read department lead: %w", err)
	}
	if leadID != nil && *leadID == user.ActorID {
		return nil
	}
	caller, err := storedCaller(ctx, q, user)
	if err != nil {
		return err
	}
	if CanManage(caller) {
		return nil
	}
	return ErrForbidden
}

func (s *Service) CreateDepartmentChat(ctx context.Context, user identity.User, departmentID string) (DepartmentChatResult, error) {
	if err := authorizeDepartmentChat(ctx, s.pool, user, departmentID); err != nil {
		return DepartmentChatResult{}, err
	}
	var name string
	var leadID, chatID *string
	var leadActive bool
	if err := s.pool.QueryRow(ctx, `
		SELECT d.name, d.lead_actor_id, d.chat_id,
		       EXISTS (SELECT 1 FROM actors a WHERE a.org_id = d.org_id AND a.id = d.lead_actor_id AND a.status = 'active' AND a.deleted_at IS NULL)
		FROM departments d WHERE d.org_id = $1 AND d.id = $2`, user.OrgID, departmentID).Scan(&name, &leadID, &chatID, &leadActive); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return DepartmentChatResult{}, ErrDepartmentNotFound
		}
		return DepartmentChatResult{}, err
	}
	if chatID != nil {
		return DepartmentChatResult{}, &Error{Kind: ErrChatExists, Message: "The department already has a chat."}
	}
	var created chat.Chat
	var version, seq int64
	for attempt := 0; ; attempt++ {
		members, err := expandAll(ctx, s.pool, user.OrgID, []string{departmentID})
		if err != nil {
			return DepartmentChatResult{}, err
		}
		var admins []string
		if leadID != nil && leadActive {
			admins = []string{*leadID}
		}
		created, err = s.chats.CreateWithin(ctx, user, chat.CreateInput{Kind: "group", Visibility: "private", Name: name, MemberIDs: members}, admins,
			func(ctx context.Context, tx pgx.Tx, newChatID string) error {
				if err := requireActiveCaller(ctx, tx, user); err != nil {
					return err
				}
				if err := authorizeDepartmentChat(ctx, tx, user, departmentID); err != nil {
					return err
				}
				row, err := lockDepartment(ctx, tx, user.OrgID, departmentID)
				if err != nil {
					return err
				}
				if row.chatID != nil {
					return &Error{Kind: ErrChatExists, Message: "The department already has a chat."}
				}
				// The members were read before the lock: whoever left the
				// department meanwhile must not get into its private chat.
				now, err := expandAll(ctx, tx, user.OrgID, []string{departmentID})
				if err != nil {
					return err
				}
				if !slices.Equal(now, members) {
					return errStale
				}
				if _, err := tx.Exec(ctx, `
					UPDATE departments SET chat_id = $3, version = version + 1, updated_at = now()
					WHERE org_id = $1 AND id = $2`, user.OrgID, row.id, newChatID); err != nil {
					return translate(err)
				}
				if err := writeAudit(ctx, tx, user, auditEntry{action: "org.department_chat.create", targetType: "department", targetID: row.id,
					metadata: map[string]any{"chat_id": newChatID, "members": len(members)}}); err != nil {
					return err
				}
				version, seq, err = BumpVersion(ctx, tx, user.OrgID, user.ActorID, ReasonDepartment)
				return err
			})
		if errors.Is(err, errStale) && attempt < writeAttempts-1 {
			continue
		}
		if err != nil {
			return DepartmentChatResult{}, err
		}
		break
	}
	_ = seq // chat.Service wakes the dispatcher with the latest sequence.
	department, err := readDepartment(ctx, s.pool, user, departmentID)
	if err != nil {
		return DepartmentChatResult{}, err
	}
	return DepartmentChatResult{Chat: created, Department: department, Version: version}, nil
}

func (s *Service) LinkDepartmentChat(ctx context.Context, user identity.User, departmentID string, input LinkDepartmentChatInput) (DepartmentWrite, error) {
	if validateID("chat_id", input.ChatID) != nil {
		return DepartmentWrite{}, &Error{Kind: ErrChatInvalid, Field: "chat_id", Message: "chat_id must be a group you manage."}
	}
	chatID := strings.ToLower(input.ChatID)
	var result DepartmentWrite
	version, err := s.write(ctx, user, writeOptions{authorize: func(ctx context.Context, tx pgx.Tx) error {
		return authorizeDepartmentChat(ctx, tx, user, departmentID)
	}}, func(ctx context.Context, tx pgx.Tx, work *change) error {
		row, err := lockDepartment(ctx, tx, user.OrgID, departmentID)
		if err != nil {
			return err
		}
		// The caller must manage the group; any other answer is the same
		// refusal, so a chat id cannot be probed.
		var kind, role string
		var archived bool
		err = tx.QueryRow(ctx, `
			SELECT c.kind, c.archived_at IS NOT NULL, COALESCE(cm.role, '')
			FROM chats c
			LEFT JOIN chat_members cm ON cm.org_id = c.org_id AND cm.chat_id = c.id AND cm.actor_id = $3
			WHERE c.org_id = $1 AND c.id = $2
			FOR SHARE OF c`, user.OrgID, chatID, user.ActorID).Scan(&kind, &archived, &role)
		if errors.Is(err, pgx.ErrNoRows) || err == nil && (kind != "group" || archived || role != "owner" && role != "admin") {
			return &Error{Kind: ErrChatInvalid, Field: "chat_id", Message: "chat_id must be a group you own or administer, not archived."}
		}
		if err != nil {
			return err
		}
		// Only after the caller proved they manage the chat: comparing first
		// would tell an outsider whether a guessed id is the department chat.
		if row.chatID != nil && *row.chatID != chatID {
			return &Error{Kind: ErrChatExists, Message: "The department already has a chat."}
		}
		if row.chatID == nil {
			var linked bool
			if err := tx.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM departments WHERE chat_id = $1)`, chatID).Scan(&linked); err != nil {
				return err
			}
			if linked {
				return &Error{Kind: ErrChatExists, Message: "The chat is linked to another department."}
			}
			if _, err := tx.Exec(ctx, `
				UPDATE departments SET chat_id = $3, version = version + 1, updated_at = now()
				WHERE org_id = $1 AND id = $2`, user.OrgID, row.id, chatID); err != nil {
				return err
			}
			work.touch(ReasonDepartment)
			work.audit("org.department_chat.link", "department", row.id, map[string]any{"chat_id": chatID})
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

func (s *Service) UnlinkDepartmentChat(ctx context.Context, user identity.User, departmentID string) error {
	_, err := s.write(ctx, user, writeOptions{authorize: func(ctx context.Context, tx pgx.Tx) error {
		return authorizeDepartmentChat(ctx, tx, user, departmentID)
	}}, func(ctx context.Context, tx pgx.Tx, work *change) error {
		row, err := lockDepartment(ctx, tx, user.OrgID, departmentID)
		if err != nil {
			return err
		}
		if row.chatID == nil {
			return nil
		}
		if _, err := tx.Exec(ctx, `
			UPDATE departments SET chat_id = NULL, version = version + 1, updated_at = now()
			WHERE org_id = $1 AND id = $2`, user.OrgID, row.id); err != nil {
			return err
		}
		work.touch(ReasonDepartment)
		work.audit("org.department_chat.unlink", "department", row.id, map[string]any{"chat_id": *row.chatID})
		return nil
	})
	return err
}

// departmentChatAccess checks access to «В чате нет N сотрудников»: lead or
// org manager, the department has a chat, and the caller owns or
// administers that chat (not archived). It returns the chat id.
func departmentChatAccess(ctx context.Context, q departmentQuerier, user identity.User, departmentID string) (string, error) {
	if err := authorizeDepartmentChat(ctx, q, user, departmentID); err != nil {
		return "", err
	}
	var chatID *string
	var manager bool
	if err := q.QueryRow(ctx, `
		SELECT d.chat_id, EXISTS (
			SELECT 1 FROM chat_members cm JOIN chats c ON c.org_id = cm.org_id AND c.id = cm.chat_id
			WHERE cm.org_id = d.org_id AND cm.chat_id = d.chat_id AND cm.actor_id = $3
			  AND cm.role IN ('owner', 'admin') AND c.archived_at IS NULL AND c.kind IN ('group', 'channel'))
		FROM departments d WHERE d.org_id = $1 AND d.id = $2`, user.OrgID, departmentID, user.ActorID).Scan(&chatID, &manager); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return "", ErrDepartmentNotFound
		}
		return "", err
	}
	if chatID == nil {
		return "", ErrDepartmentNotFound
	}
	if !manager {
		return "", ErrForbidden
	}
	return *chatID, nil
}

// missingPeople are the active people of the department (with
// subdepartments) who are not in the chat.
func missingPeople(ctx context.Context, q Querier, orgID, departmentID, chatID string) ([]string, error) {
	people, err := expandAll(ctx, q, orgID, []string{departmentID})
	if err != nil {
		return nil, err
	}
	if len(people) == 0 {
		return []string{}, nil
	}
	rows, err := q.Query(ctx, `
		SELECT a.id FROM actors a
		WHERE a.org_id = $1 AND a.id = ANY($2::uuid[])
		  AND NOT EXISTS (SELECT 1 FROM chat_members cm WHERE cm.org_id = a.org_id AND cm.chat_id = $3 AND cm.actor_id = a.id)
		ORDER BY a.id`, orgID, people, chatID)
	if err != nil {
		return nil, err
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

func (s *Service) DepartmentChatMissing(ctx context.Context, user identity.User, departmentID string) (DepartmentChatMissing, error) {
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return DepartmentChatMissing{}, err
	}
	defer tx.Rollback(ctx)
	chatID, err := departmentChatAccess(ctx, tx, user, departmentID)
	if err != nil {
		return DepartmentChatMissing{}, err
	}
	missing, err := missingPeople(ctx, tx, user.OrgID, departmentID, chatID)
	if err != nil {
		return DepartmentChatMissing{}, err
	}
	result := DepartmentChatMissing{Actors: []chat.Actor{}}
	if len(missing) > 0 {
		rows, err := tx.Query(ctx, `
			SELECT a.id, a.display_name, a.handle::text, a.title, a.about, a.type,
			       actor_shown_status_emoji(a.org_id, a.id, now(), CASE WHEN a.status_expires_at IS NULL OR a.status_expires_at > now() THEN a.status_emoji ELSE '' END),
			       actor_shown_status_text(a.org_id, a.id, now(), CASE WHEN a.status_expires_at IS NULL OR a.status_expires_at > now() THEN a.status_text ELSE '' END),
			       actor_shown_status_expires_at(a.org_id, a.id, now(), CASE WHEN a.status_expires_at IS NULL OR a.status_expires_at > now() THEN a.status_expires_at END),
			       a.avatar_version, actor_away_public(a.org_id, a.id, now()), a.position_id,
			       (SELECT dm.department_id FROM department_members dm WHERE dm.org_id = a.org_id AND dm.actor_id = a.id AND dm.is_primary)
			FROM actors a WHERE a.org_id = $1 AND a.id = ANY($2::uuid[])
			ORDER BY a.display_name, a.id`, user.OrgID, missing)
		if err != nil {
			return DepartmentChatMissing{}, err
		}
		for rows.Next() {
			var actor chat.Actor
			if err := rows.Scan(&actor.ID, &actor.DisplayName, &actor.Handle, &actor.Title, &actor.About, &actor.Type, &actor.StatusEmoji, &actor.StatusText, &actor.StatusExpiresAt, &actor.AvatarVersion, &actor.Away, &actor.PositionID, &actor.PrimaryDepartmentID); err != nil {
				rows.Close()
				return DepartmentChatMissing{}, err
			}
			result.Actors = append(result.Actors, actor)
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return DepartmentChatMissing{}, err
		}
	}
	return result, tx.Commit(ctx)
}

func (s *Service) AddDepartmentChatMissing(ctx context.Context, user identity.User, departmentID string) (DepartmentChatAddMissingResult, error) {
	chatID, err := departmentChatAccess(ctx, s.pool, user, departmentID)
	if err != nil {
		return DepartmentChatAddMissingResult{}, err
	}
	added, err := s.chats.AddMembersResolved(ctx, user, chatID,
		func(ctx context.Context, tx pgx.Tx) ([]string, error) {
			// Under the organization lock: the department, its chat and the
			// caller's rights as they are now.
			current, err := departmentChatAccess(ctx, tx, user, departmentID)
			if err != nil {
				return nil, err
			}
			if current != chatID {
				return nil, ErrForbidden
			}
			return missingPeople(ctx, tx, user.OrgID, departmentID, chatID)
		},
		func(ctx context.Context, tx pgx.Tx, added []string) error {
			if len(added) == 0 {
				return nil
			}
			return writeAudit(ctx, tx, user, auditEntry{action: "org.department_chat.add_missing", targetType: "department", targetID: departmentID,
				metadata: map[string]any{"chat_id": chatID, "added": len(added)}})
		})
	if errors.Is(err, chat.ErrNotFound) {
		return DepartmentChatAddMissingResult{}, ErrForbidden
	}
	if errors.Is(err, chat.ErrForbidden) {
		return DepartmentChatAddMissingResult{}, ErrForbidden
	}
	if err != nil {
		return DepartmentChatAddMissingResult{}, err
	}
	return DepartmentChatAddMissingResult{Added: len(added)}, nil
}
