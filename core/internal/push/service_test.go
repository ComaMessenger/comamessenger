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

func TestValidChatFolders(t *testing.T) {
	folders := []ChatFolder{{
		ID: "00000000-0000-4000-8000-000000000001", Name: " Работа ", Icon: "briefcase",
		ChatIDs: []string{"00000000-0000-4000-8000-000000000002"},
	}}
	if !validChatFolders(folders) || folders[0].Name != "Работа" {
		t.Fatalf("validChatFolders() rejected or did not normalize valid input: %+v", folders)
	}
	folders[0].ChatIDs = append(folders[0].ChatIDs, folders[0].ChatIDs[0])
	if validChatFolders(folders) {
		t.Fatal("validChatFolders() accepted a duplicate chat")
	}
}
