package http

import (
	"sync"
	"time"

	"golang.org/x/time/rate"
)

type limiterEntry struct {
	limiter  *rate.Limiter
	lastSeen time.Time
}

type ipRateLimiter struct {
	mu      sync.Mutex
	entries map[string]*limiterEntry
	limit   rate.Limit
	burst   int
	now     func() time.Time
}

func newIPRateLimiter(requestsPerMinute float64, burst int) *ipRateLimiter {
	return &ipRateLimiter{
		entries: make(map[string]*limiterEntry),
		limit:   rate.Limit(requestsPerMinute / 60),
		burst:   burst,
		now:     time.Now,
	}
}

func (l *ipRateLimiter) Allow(key string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := l.now()
	entry, ok := l.entries[key]
	if !ok {
		entry = &limiterEntry{limiter: rate.NewLimiter(l.limit, l.burst)}
		l.entries[key] = entry
	}
	entry.lastSeen = now
	if len(l.entries) > 1024 {
		for existingKey, existing := range l.entries {
			if now.Sub(existing.lastSeen) > 15*time.Minute {
				delete(l.entries, existingKey)
			}
		}
	}
	return entry.limiter.AllowN(now, 1)
}
