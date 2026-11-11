package main

import (
	"os"
	"regexp"
	"testing"
	"time"

	"github.com/comamessenger/comamessenger/core/internal/files"
)

// Docker must give Core at least as long to stop as Core waits for upload
// completions in flight, or a deploy cuts them off mid-copy.
func TestComposeStopGraceCoversUploadCompletion(t *testing.T) {
	compose, err := os.ReadFile("../../../deploy/compose.yaml")
	if err != nil {
		t.Fatal(err)
	}
	match := regexp.MustCompile(`(?m)^  core:\n(?:    .*\n)*?    stop_grace_period: (\d+s)\n`).FindSubmatch(compose)
	if match == nil {
		t.Fatal("deploy/compose.yaml: core has no stop_grace_period")
	}
	grace, err := time.ParseDuration(string(match[1]))
	if err != nil {
		t.Fatal(err)
	}
	// FILE_MAX_BYTES defaults to 100 MiB.
	needed := shutdownTimeoutFor(files.CompletionTimeout(100 << 20))
	if grace <= needed {
		t.Fatalf("core stop_grace_period %v must exceed the shutdown wait %v", grace, needed)
	}
	if needed < files.CompletionTimeout(100<<20) {
		t.Fatalf("shutdown wait %v is shorter than an upload completion", needed)
	}
}
