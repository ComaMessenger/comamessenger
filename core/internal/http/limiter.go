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
	mu         sync.Mutex
	entries    map[string]*limiterEntry
	limit      rate.Limit
	burst      int
	maxEntries int
	now        func() time.Time
}

func newIPRateLimiter(requestsPerMinute float64, burst int) *ipRateLimiter {
	return &ipRateLimiter{
		entries:    make(map[string]*limiterEntry),
		limit:      rate.Limit(requestsPerMinute / 60),
		burst:      burst,
		maxEntries: 4096,
		now:        time.Now,
	}
}

func (l *ipRateLimiter) Allow(key string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := l.now()
	entry, ok := l.entries[key]
	if !ok {
		l.evict(now)
		entry = &limiterEntry{limiter: rate.NewLimiter(l.limit, l.burst)}
		l.entries[key] = entry
	}
	entry.lastSeen = now
	return entry.limiter.AllowN(now, 1)
}

func (l *ipRateLimiter) evict(now time.Time) {
	if len(l.entries) < l.maxEntries {
		return
	}
	var oldestKey string
	var oldestTime time.Time
	for key, entry := range l.entries {
		if now.Sub(entry.lastSeen) > 15*time.Minute {
			delete(l.entries, key)
			continue
		}
		if oldestKey == "" || entry.lastSeen.Before(oldestTime) {
			oldestKey, oldestTime = key, entry.lastSeen
		}
	}
	if len(l.entries) >= l.maxEntries && oldestKey != "" {
		delete(l.entries, oldestKey)
	}
}
