package database

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// scripts/check-migration-versions.sh guards CI and deploy against two
// branches that both took the same migration number.
func TestMigrationVersionScript(t *testing.T) {
	script, err := filepath.Abs("../../../scripts/check-migration-versions.sh")
	if err != nil {
		t.Fatal(err)
	}
	if output, err := exec.Command(script, "migrations").CombinedOutput(); err != nil {
		t.Fatalf("embedded migrations have duplicate versions: %v\n%s", err, output)
	}
	duplicated := t.TempDir()
	for _, name := range []string{"00050_pilot_recipes.sql", "00051_voice_messages.sql", "051_scheduled_messages.sql"} {
		if err := os.WriteFile(filepath.Join(duplicated, name), []byte("-- +goose Up\n"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	output, err := exec.Command(script, duplicated).CombinedOutput()
	if err == nil || !strings.Contains(string(output), "version 51") {
		t.Fatalf("duplicate version 51 not reported: err %v\n%s", err, output)
	}
}
