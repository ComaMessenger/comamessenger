package away

import (
	"context"
	"fmt"
	"time"
)

// sweepBatch bounds the rows one pass handles; the next minute continues.
const sweepBatch = 200

// Sweep is the pass of identity.RunStatusExpiry for «Отсутствую». Whether a
// status is active is decided on every read by the clock; the sweep only
// makes the live updates and removes what is over:
//  1. a planned status whose start has come gets started_event_at and
//     actor.away.updated (active now);
//  2. a status that has ended, or whose person is no longer active, is
//     removed with its auto-reply marks: actor.away.updated(null) and
//     away.substitute.removed for its substitute.
//
// It returns the high watermark per organization for the realtime wake-up.
func (s *Service) Sweep(ctx context.Context, now time.Time) (map[string]int64, error) {
	now = now.UTC()
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return nil, fmt.Errorf("begin away sweep: %w", err)
	}
	defer tx.Rollback(ctx)
	orgRows, err := tx.Query(ctx, `
		SELECT DISTINCT aw.org_id FROM actor_away aw
		JOIN actors a ON a.org_id = aw.org_id AND a.id = aw.actor_id
		WHERE aw.ends_at <= $1 OR (aw.started_event_at IS NULL AND aw.starts_at <= $1)
		   OR a.status <> 'active' OR a.deleted_at IS NOT NULL
		ORDER BY aw.org_id LIMIT 100`, now)
	if err != nil {
		return nil, fmt.Errorf("select organizations to sweep: %w", err)
	}
	var orgIDs []string
	for orgRows.Next() {
		var orgID string
		if err := orgRows.Scan(&orgID); err != nil {
			orgRows.Close()
			return nil, fmt.Errorf("scan organization to sweep: %w", err)
		}
		orgIDs = append(orgIDs, orgID)
	}
	orgRows.Close()
	if err := orgRows.Err(); err != nil {
		return nil, err
	}
	if len(orgIDs) == 0 {
		return nil, nil
	}
	// Organizations in id order, like every multi-organization writer.
	for _, orgID := range orgIDs {
		if err := lockOrganization(ctx, tx, orgID); err != nil {
			return nil, err
		}
	}
	type target struct {
		orgID, awayID, actorID string
		substituteID           *string
		ending                 bool
	}
	rows, err := tx.Query(ctx, `
		SELECT aw.org_id, aw.id, aw.actor_id, aw.substitute_id,
		       aw.ends_at <= $1 OR a.status <> 'active' OR a.deleted_at IS NOT NULL
		FROM actor_away aw
		JOIN actors a ON a.org_id = aw.org_id AND a.id = aw.actor_id
		WHERE aw.org_id = ANY($2::uuid[])
		  AND (aw.ends_at <= $1 OR (aw.started_event_at IS NULL AND aw.starts_at <= $1)
		       OR a.status <> 'active' OR a.deleted_at IS NOT NULL)
		ORDER BY aw.org_id, aw.id
		FOR UPDATE OF aw SKIP LOCKED LIMIT $3`, now, orgIDs, sweepBatch)
	if err != nil {
		return nil, fmt.Errorf("select away statuses to sweep: %w", err)
	}
	var targets []target
	for rows.Next() {
		var item target
		if err := rows.Scan(&item.orgID, &item.awayID, &item.actorID, &item.substituteID, &item.ending); err != nil {
			rows.Close()
			return nil, fmt.Errorf("scan away status to sweep: %w", err)
		}
		targets = append(targets, item)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	high := map[string]int64{}
	for _, item := range targets {
		var seq int64
		if item.ending {
			if _, err := tx.Exec(ctx, `DELETE FROM actor_away WHERE id = $1`, item.awayID); err != nil {
				return nil, fmt.Errorf("remove ended away status: %w", err)
			}
			if seq, err = writeCleared(ctx, tx, item.orgID, item.actorID, item.substituteID); err != nil {
				return nil, err
			}
		} else {
			if _, err := tx.Exec(ctx, `UPDATE actor_away SET started_event_at = $2 WHERE id = $1`, item.awayID, now); err != nil {
				return nil, fmt.Errorf("start away status: %w", err)
			}
			if seq, err = writeUpdated(ctx, tx, item.orgID, item.actorID, now); err != nil {
				return nil, err
			}
		}
		high[item.orgID] = seq
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, fmt.Errorf("commit away sweep: %w", err)
	}
	return high, nil
}
