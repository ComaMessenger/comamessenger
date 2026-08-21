package access

import (
	"errors"
	"reflect"
	"testing"
	"time"
)

func TestIssueAndParse(t *testing.T) {
	manager, err := NewManager("0123456789abcdef0123456789abcdef", 15*time.Minute)
	if err != nil {
		t.Fatalf("NewManager() error = %v", err)
	}
	fixed := time.Date(2026, 8, 18, 12, 0, 0, 0, time.UTC)
	manager.now = func() time.Time { return fixed }
	want := Identity{ActorID: "actor", OrgID: "org", SessionID: "session", Role: "owner"}
	token, expiresAt, err := manager.Issue(want)
	if err != nil {
		t.Fatalf("Issue() error = %v", err)
	}
	if !expiresAt.Equal(fixed.Add(15 * time.Minute)) {
		t.Fatalf("expiresAt = %v", expiresAt)
	}
	want.ExpiresAt = expiresAt
	got, err := manager.Parse(token)
	want.AuthenticationKind = "session"
	if err != nil || !reflect.DeepEqual(got, want) {
		t.Fatalf("Parse() = %#v, %v; want %#v", got, err, want)
	}
}

func TestParseRejectsExpiredToken(t *testing.T) {
	manager, _ := NewManager("0123456789abcdef0123456789abcdef", time.Minute)
	issuedAt := time.Date(2026, 8, 18, 12, 0, 0, 0, time.UTC)
	manager.now = func() time.Time { return issuedAt }
	token, _, _ := manager.Issue(Identity{ActorID: "actor", OrgID: "org", SessionID: "session", Role: "member"})
	manager.now = func() time.Time { return issuedAt.Add(2 * time.Minute) }
	if _, err := manager.Parse(token); !errors.Is(err, ErrInvalidToken) {
		t.Fatalf("Parse() error = %v, want ErrInvalidToken", err)
	}
}

func TestRefreshTokensAreRandomAndHashable(t *testing.T) {
	first, firstHash, err := NewRefreshToken()
	if err != nil {
		t.Fatalf("NewRefreshToken() error = %v", err)
	}
	second, secondHash, _ := NewRefreshToken()
	if first == second || firstHash == secondHash {
		t.Fatal("NewRefreshToken() returned duplicate tokens")
	}
	if got := HashRefreshToken(first); got != firstHash {
		t.Fatal("HashRefreshToken() does not match generated hash")
	}
}
