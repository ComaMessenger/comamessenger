// Package lastseen decides what one person may learn about when another was
// last online. The time itself is users.last_seen_at, written by realtime
// presence at most once a minute; the visibility setting lives in
// users.preferences.last_seen_visibility.
package lastseen

import (
	"context"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

const (
	Everyone = "everyone"
	Nobody   = "nobody"
)

// Approximate buckets shown instead of the exact time, as in Telegram.
const (
	Recently    = "recently"
	WithinWeek  = "within_week"
	WithinMonth = "within_month"
	LongAgo     = "long_ago"
)

// ValidVisibility reports whether value is an accepted setting.
func ValidVisibility(value string) bool { return value == Everyone || value == Nobody }

// Normalize maps an unset or unknown stored value to the default.
func Normalize(value string) string {
	if value == Nobody {
		return Nobody
	}
	return Everyone
}

// Resolve returns either the exact time or an approximate bucket. The exact
// time needs both sides to share it: the subject's setting hides it from
// everyone, and a viewer who hides their own time does not see others' either.
func Resolve(at *time.Time, subjectVisibility, viewerVisibility string, now time.Time) (*time.Time, *string) {
	if at == nil {
		approx := LongAgo
		return nil, &approx
	}
	if Normalize(subjectVisibility) == Everyone && Normalize(viewerVisibility) == Everyone {
		exact := at.UTC()
		return &exact, nil
	}
	age := now.Sub(*at)
	approx := LongAgo
	switch {
	case age <= 3*24*time.Hour:
		approx = Recently
	case age <= 7*24*time.Hour:
		approx = WithinWeek
	case age <= 30*24*time.Hour:
		approx = WithinMonth
	}
	return nil, &approx
}

// Record is one person's stored time and setting.
type Record struct {
	At         *time.Time
	Visibility string
}

// Load reads the stored time and setting for people among actorIDs (agents
// have no users row and are absent from the result) plus the viewer's own
// setting; a viewer without a users row (an agent) counts as "everyone".
func Load(ctx context.Context, pool *pgxpool.Pool, orgID, viewerID string, actorIDs []string) (map[string]Record, string, error) {
	result := make(map[string]Record, len(actorIDs))
	viewerVisibility := Everyone
	rows, err := pool.Query(ctx, `SELECT actor_id::text, last_seen_at, COALESCE(preferences->>'last_seen_visibility','') FROM users WHERE org_id=$1 AND (actor_id=ANY($2::uuid[]) OR actor_id=$3)`, orgID, actorIDs, viewerID)
	if err != nil {
		return nil, "", fmt.Errorf("load last seen: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var id, visibility string
		var at *time.Time
		if err := rows.Scan(&id, &at, &visibility); err != nil {
			return nil, "", fmt.Errorf("scan last seen: %w", err)
		}
		if id == viewerID {
			viewerVisibility = Normalize(visibility)
		}
		result[id] = Record{At: at, Visibility: Normalize(visibility)}
	}
	return result, viewerVisibility, rows.Err()
}
