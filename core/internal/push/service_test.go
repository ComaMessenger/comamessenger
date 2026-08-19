package push

import "testing"

func TestTruncateUsesRunes(t *testing.T) {
	if got := truncate("Привет", 4); got != "Прив…" {
		t.Fatalf("truncate() = %q", got)
	}
	if got := truncate("Coma", 10); got != "Coma" {
		t.Fatalf("short truncate() = %q", got)
	}
}
