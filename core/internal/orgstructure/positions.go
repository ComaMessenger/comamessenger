package orgstructure

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/comamessenger/comamessenger/core/internal/id"
	"github.com/comamessenger/comamessenger/core/internal/identity"
	"github.com/jackc/pgx/v5"
)

func (s *Service) CreatePosition(ctx context.Context, user identity.User, input CreatePositionInput) (PositionWrite, error) {
	name, err := validateName("name", input.Name)
	if err != nil {
		return PositionWrite{}, err
	}
	positionID, err := id.New()
	if err != nil {
		return PositionWrite{}, err
	}
	var result PositionWrite
	version, err := s.write(ctx, user, writeOptions{}, func(ctx context.Context, tx pgx.Tx, work *change) error {
		if err := positionRoom(ctx, tx, user.OrgID, 1); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `INSERT INTO positions(org_id, id, name) VALUES ($1, $2, $3)`, user.OrgID, positionID, name); err != nil {
			return err
		}
		work.touch(ReasonPosition)
		work.audit("org.position.create", "position", positionID, map[string]any{"name": name})
		positions, err := readPositions(ctx, tx, user.OrgID, positionID)
		if err == nil && len(positions) == 1 {
			result.Position = positions[0]
		}
		return err
	})
	if err != nil {
		return PositionWrite{}, err
	}
	result.Version = version
	return result, nil
}

// CreatePositions adds several positions, skipping names that exist or
// repeat (ignoring case).
func (s *Service) CreatePositions(ctx context.Context, user identity.User, input CreatePositionsInput) (CreatePositionsResult, error) {
	if len(input.Names) < 1 || len(input.Names) > MaxBulkPositions {
		return CreatePositionsResult{}, invalid("names", "names must list 1 to %d names.", MaxBulkPositions)
	}
	names := make([]string, 0, len(input.Names))
	for _, raw := range input.Names {
		name, err := validateName("names", raw)
		if err != nil {
			return CreatePositionsResult{}, err
		}
		names = append(names, name)
	}
	result := CreatePositionsResult{Created: []Position{}, Skipped: []string{}}
	version, err := s.write(ctx, user, writeOptions{}, func(ctx context.Context, tx pgx.Tx, work *change) error {
		result.Created, result.Skipped = []Position{}, []string{}
		existing, err := readPositions(ctx, tx, user.OrgID, "")
		if err != nil {
			return err
		}
		taken := make(map[string]bool, len(existing)+len(names))
		for _, position := range existing {
			taken[strings.ToLower(position.Name)] = true
		}
		fresh := make([]string, 0, len(names))
		for _, name := range names {
			key := strings.ToLower(name)
			if taken[key] {
				result.Skipped = append(result.Skipped, name)
				continue
			}
			taken[key] = true
			fresh = append(fresh, name)
		}
		if len(fresh) == 0 {
			return nil
		}
		if err := positionRoom(ctx, tx, user.OrgID, len(fresh)); err != nil {
			return err
		}
		ids := make([]string, 0, len(fresh))
		for _, name := range fresh {
			positionID, err := id.New()
			if err != nil {
				return err
			}
			if _, err := tx.Exec(ctx, `INSERT INTO positions(org_id, id, name) VALUES ($1, $2, $3)`, user.OrgID, positionID, name); err != nil {
				return err
			}
			ids = append(ids, positionID)
		}
		for _, positionID := range ids {
			positions, err := readPositions(ctx, tx, user.OrgID, positionID)
			if err != nil {
				return err
			}
			result.Created = append(result.Created, positions...)
		}
		work.touch(ReasonPosition)
		work.audit("org.position.create", "organization", user.OrgID, map[string]any{"names": fresh, "bulk": true})
		return nil
	})
	if err != nil {
		return CreatePositionsResult{}, err
	}
	result.Version = version
	return result, nil
}

func positionRoom(ctx context.Context, tx pgx.Tx, orgID string, adding int) error {
	var count int
	if err := tx.QueryRow(ctx, `SELECT count(*) FROM positions WHERE org_id = $1`, orgID).Scan(&count); err != nil {
		return err
	}
	if count+adding > MaxPositions {
		return limitReached("positions", "A workspace may have at most %d positions.", MaxPositions)
	}
	return nil
}

func (s *Service) UpdatePosition(ctx context.Context, user identity.User, positionID string, input UpdatePositionInput) (PositionWrite, error) {
	if input.ExpectedVersion < 1 {
		return PositionWrite{}, invalid("expected_version", "expected_version is required")
	}
	if input.Name == nil {
		return PositionWrite{}, invalid("name", "No changes supplied.")
	}
	name, err := validateName("name", *input.Name)
	if err != nil {
		return PositionWrite{}, err
	}
	if validateID("position_id", positionID) != nil {
		return PositionWrite{}, ErrPositionNotFound
	}
	var result PositionWrite
	version, err := s.write(ctx, user, writeOptions{}, func(ctx context.Context, tx pgx.Tx, work *change) error {
		var current string
		var version int32
		err := tx.QueryRow(ctx, `SELECT name, version FROM positions WHERE org_id = $1 AND id = $2 FOR UPDATE`, user.OrgID, positionID).Scan(&current, &version)
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrPositionNotFound
		}
		if err != nil {
			return err
		}
		if version != input.ExpectedVersion {
			return &Error{Kind: ErrVersionConflict, Field: "expected_version", Message: "The position changed. Reload and try again."}
		}
		if current != name {
			if _, err := tx.Exec(ctx, `UPDATE positions SET name = $3, version = version + 1, updated_at = now() WHERE org_id = $1 AND id = $2`, user.OrgID, positionID, name); err != nil {
				return err
			}
			work.touch(ReasonPosition)
			work.audit("org.position.update", "position", positionID, map[string]any{"changes": map[string]any{"name": map[string]any{"from": current, "to": name}}})
		}
		positions, err := readPositions(ctx, tx, user.OrgID, positionID)
		if err == nil && len(positions) == 1 {
			result.Position = positions[0]
		}
		return err
	})
	if err != nil {
		return PositionWrite{}, err
	}
	result.Version = version
	return result, nil
}

func (s *Service) DeletePosition(ctx context.Context, user identity.User, positionID string) error {
	if validateID("position_id", positionID) != nil {
		return ErrPositionNotFound
	}
	// The people who hold it lose it (ON DELETE SET NULL updates their
	// rows): their rows are locked in id order under the organization lock,
	// where no other write can hand the position out meanwhile.
	var err error
	_, err = s.write(ctx, user, writeOptions{lockActorsNow: func(ctx context.Context, tx pgx.Tx) ([]string, error) {
		return s.positionHolders(ctx, tx, user.OrgID, positionID)
	}}, func(ctx context.Context, tx pgx.Tx, work *change) error {
		var name string
		err = tx.QueryRow(ctx, `DELETE FROM positions WHERE org_id = $1 AND id = $2 RETURNING name`, user.OrgID, positionID).Scan(&name)
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrPositionNotFound
		}
		if err != nil {
			return err
		}
		work.touch(ReasonPosition)
		work.audit("org.position.delete", "position", positionID, map[string]any{"name": name})
		return nil
	})
	return err
}

func (s *Service) positionHolders(ctx context.Context, q Querier, orgID, positionID string) ([]string, error) {
	rows, err := q.Query(ctx, `SELECT id FROM actors WHERE org_id = $1 AND position_id = $2 ORDER BY id`, orgID, positionID)
	if err != nil {
		return nil, fmt.Errorf("read position holders: %w", err)
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

// TitleSuggestions lists distinct profile titles of active people that are
// not positions yet, most frequent first.
func (s *Service) TitleSuggestions(ctx context.Context, user identity.User) (TitleSuggestionList, error) {
	caller, err := storedCaller(ctx, s.pool, user)
	if err != nil {
		return TitleSuggestionList{}, err
	}
	if !CanManage(caller) {
		return TitleSuggestionList{}, ErrForbidden
	}
	rows, err := s.pool.Query(ctx, `
		SELECT mode() WITHIN GROUP (ORDER BY btrim(a.title)), count(*), array_agg(a.id ORDER BY a.id)::text[]
		FROM actors a
		WHERE a.org_id = $1 AND a.type = 'user' AND a.status = 'active' AND a.deleted_at IS NULL
		  AND char_length(btrim(a.title)) BETWEEN 1 AND $2
		  AND NOT EXISTS (SELECT 1 FROM positions p WHERE p.org_id = a.org_id AND lower(btrim(p.name)) = lower(btrim(a.title)))
		GROUP BY lower(btrim(a.title))
		ORDER BY count(*) DESC, lower(btrim(a.title))
		LIMIT $3`, user.OrgID, MaxNameLength, MaxTitleSuggestions)
	if err != nil {
		return TitleSuggestionList{}, fmt.Errorf("read title suggestions: %w", err)
	}
	defer rows.Close()
	result := TitleSuggestionList{Suggestions: []TitleSuggestion{}}
	for rows.Next() {
		var item TitleSuggestion
		if err := rows.Scan(&item.Title, &item.Count, &item.ActorIDs); err != nil {
			return TitleSuggestionList{}, err
		}
		if strings.ContainsAny(item.Title, "\r\n\x00") {
			continue
		}
		result.Suggestions = append(result.Suggestions, item)
	}
	return result, rows.Err()
}
