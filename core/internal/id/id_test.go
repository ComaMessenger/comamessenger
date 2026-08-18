package id

import (
	"testing"

	"github.com/google/uuid"
)

func TestNewReturnsUUIDv7(t *testing.T) {
	value, err := New()
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	parsed, err := uuid.Parse(value)
	if err != nil {
		t.Fatalf("Parse(%q) error = %v", value, err)
	}
	if parsed.Version() != 7 {
		t.Fatalf("Version() = %d, want 7", parsed.Version())
	}
}
