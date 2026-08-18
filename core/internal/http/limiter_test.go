package http

import (
	"net/http/httptest"
	"net/netip"
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

func TestClientIPTrustsForwardingOnlyFromConfiguredProxies(t *testing.T) {
	handler := &identityHandlers{trustedProxyCIDRs: []netip.Prefix{
		netip.MustParsePrefix("127.0.0.1/32"), netip.MustParsePrefix("10.0.0.0/8"),
	}}
	untrusted := httptest.NewRequest("GET", "/", nil)
	untrusted.RemoteAddr = "203.0.113.8:4321"
	untrusted.Header.Set("X-Forwarded-For", "198.51.100.9")
	if got := handler.clientIP(untrusted); got != "203.0.113.8" {
		t.Fatalf("untrusted proxy client IP = %q", got)
	}

	trusted := httptest.NewRequest("GET", "/", nil)
	trusted.RemoteAddr = "127.0.0.1:4321"
	trusted.Header.Set("X-Forwarded-For", "198.51.100.9, 10.2.3.4")
	if got := handler.clientIP(trusted); got != "198.51.100.9" {
		t.Fatalf("trusted proxy chain client IP = %q", got)
	}
}

func TestSecureTokenEqual(t *testing.T) {
	if !secureTokenEqual("correct-token", "correct-token") || secureTokenEqual("correct-token", "wrong-token") {
		t.Fatal("secureTokenEqual returned an unexpected result")
	}
}

func TestIPRateLimiterHasHardCardinalityBound(t *testing.T) {
	limiter := newIPRateLimiter(60, 1)
	limiter.maxEntries = 8
	for index := range 100 {
		limiter.Allow(string(rune(index + 1)))
	}
	if len(limiter.entries) > limiter.maxEntries {
		t.Fatalf("entries = %d, max = %d", len(limiter.entries), limiter.maxEntries)
	}
}
