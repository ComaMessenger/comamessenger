package push

import (
	"encoding/json"
	"fmt"
	"testing"
	"time"
)

func TestTruncateUsesRunes(t *testing.T) {
	if got := truncate("Привет", 4); got != "Прив…" {
		t.Fatalf("truncate() = %q", got)
	}
	if got := truncate("Coma", 10); got != "Coma" {
		t.Fatalf("short truncate() = %q", got)
	}
}

func TestValidChatFolders(t *testing.T) {
	folders := []ChatFolder{{
		ID: "00000000-0000-4000-8000-000000000001", Name: " Работа ", Icon: "briefcase", Color: "violet",
		ChatIDs: []string{"00000000-0000-4000-8000-000000000002"},
	}}
	if !validChatFolders(folders) || folders[0].Name != "Работа" {
		t.Fatalf("validChatFolders() rejected or did not normalize valid input: %+v", folders)
	}
	folders[0].ChatIDs = append(folders[0].ChatIDs, folders[0].ChatIDs[0])
	if validChatFolders(folders) {
		t.Fatal("validChatFolders() accepted a duplicate chat")
	}
	folders[0].ChatIDs = folders[0].ChatIDs[:1]
	folders[0].Color = "ultraviolet"
	if validChatFolders(folders) {
		t.Fatal("validChatFolders() accepted an unsupported color")
	}
}

func TestValidPinnedChats(t *testing.T) {
	valid := []string{"00000000-0000-4000-8000-000000000001"}
	if !validPinnedChats(valid) {
		t.Fatal("validPinnedChats() rejected valid input")
	}
	if validPinnedChats([]string{valid[0], valid[0]}) {
		t.Fatal("validPinnedChats() accepted duplicate input")
	}
	tooMany := make([]string, 11)
	for index := range tooMany {
		tooMany[index] = fmt.Sprintf("00000000-0000-4000-8000-%012d", index)
	}
	if validPinnedChats(tooMany) {
		t.Fatal("validPinnedChats() accepted more than ten chats")
	}
}

func TestOptionalTimeDistinguishesMissingNullAndValue(t *testing.T) {
	var missing UpdatePreferences
	if err := json.Unmarshal([]byte(`{}`), &missing); err != nil {
		t.Fatal(err)
	}
	if missing.SnoozedUntil.Set {
		t.Fatal("missing snoozed_until was marked as set")
	}
	var cleared UpdatePreferences
	if err := json.Unmarshal([]byte(`{"snoozed_until":null}`), &cleared); err != nil {
		t.Fatal(err)
	}
	if !cleared.SnoozedUntil.Set || cleared.SnoozedUntil.Value != nil {
		t.Fatalf("null snoozed_until = %+v", cleared.SnoozedUntil)
	}
	var scheduled UpdatePreferences
	if err := json.Unmarshal([]byte(`{"snoozed_until":"2026-08-21T12:00:00Z"}`), &scheduled); err != nil {
		t.Fatal(err)
	}
	want := time.Date(2026, 8, 21, 12, 0, 0, 0, time.UTC)
	if !scheduled.SnoozedUntil.Set || scheduled.SnoozedUntil.Value == nil || !scheduled.SnoozedUntil.Value.Equal(want) {
		t.Fatalf("timestamp snoozed_until = %+v", scheduled.SnoozedUntil)
	}
}
