package lastseen

import (
	"testing"
	"time"
)

func TestResolve(t *testing.T) {
	now := time.Date(2026, 11, 14, 12, 0, 0, 0, time.UTC)
	at := func(age time.Duration) *time.Time { value := now.Add(-age); return &value }
	cases := []struct {
		name            string
		at              *time.Time
		subject, viewer string
		exact           bool
		approx          string
	}{
		{"both share", at(5 * time.Minute), Everyone, Everyone, true, ""},
		{"unset settings default to everyone", at(5 * time.Minute), "", "", true, ""},
		{"subject hides", at(5 * time.Minute), Nobody, Everyone, false, Recently},
		{"viewer hides, symmetric", at(5 * time.Minute), Everyone, Nobody, false, Recently},
		{"within week", at(5 * 24 * time.Hour), Nobody, Everyone, false, WithinWeek},
		{"within month", at(20 * 24 * time.Hour), Nobody, Everyone, false, WithinMonth},
		{"long ago", at(90 * 24 * time.Hour), Nobody, Everyone, false, LongAgo},
		{"never seen", nil, Everyone, Everyone, false, LongAgo},
	}
	for _, item := range cases {
		exact, approx := Resolve(item.at, item.subject, item.viewer, now)
		if (exact != nil) != item.exact {
			t.Fatalf("%s: exact = %v", item.name, exact)
		}
		if item.exact && approx != nil {
			t.Fatalf("%s: approx alongside exact", item.name)
		}
		if !item.exact && (approx == nil || *approx != item.approx) {
			t.Fatalf("%s: approx = %v, want %s", item.name, approx, item.approx)
		}
	}
}
