package http

import (
	"testing"
	"time"
)

func TestIPRateLimiter(t *testing.T) {
	limiter := newIPRateLimiter(60, 2)
	now := time.Date(2026, 8, 18, 12, 0, 0, 0, time.UTC)
	limiter.now = func() time.Time { return now }
	if !limiter.Allow("login:127.0.0.1") || !limiter.Allow("login:127.0.0.1") {
		t.Fatal("initial burst was unexpectedly rejected")
	}
	if limiter.Allow("login:127.0.0.1") {
		t.Fatal("request beyond burst was unexpectedly allowed")
	}
	now = now.Add(time.Second)
	if !limiter.Allow("login:127.0.0.1") {
		t.Fatal("refilled request was unexpectedly rejected")
	}
}
