package main

import (
	"io"
	"strings"
	"testing"
)

// The shared demo password must not be accepted on the command line, where
// it stays in shell history and process lists (security review, item 5).
func TestSeedPilotRefusesPasswordArgument(t *testing.T) {
	t.Setenv("SEED_PILOT_PASSWORD", "")
	err := runSeedPilot([]string{"--password", "demo-pilot-password"}, io.Discard)
	if err == nil || !strings.Contains(err.Error(), "not defined: -password") {
		t.Fatalf("--password error = %v", err)
	}
	seedPilotStdin = strings.NewReader("short\n")
	defer func() { seedPilotStdin = nil }()
	if err := runSeedPilot([]string{"--password-stdin"}, io.Discard); err == nil || !strings.Contains(err.Error(), "at least 12") {
		t.Fatalf("short stdin password error = %v", err)
	}
}
