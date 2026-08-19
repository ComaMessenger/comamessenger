package push

import (
	"fmt"
	"testing"
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
