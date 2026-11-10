package files

import (
	"bytes"
	"errors"
	"image"
	"image/color"
	"image/jpeg"
	"image/png"
	"testing"
	"time"

	"github.com/comamessenger/comamessenger/core/internal/chat"
	"github.com/comamessenger/comamessenger/core/internal/identity"
	"github.com/comamessenger/comamessenger/core/internal/permission"
	"github.com/comamessenger/comamessenger/core/internal/storage"
	"github.com/comamessenger/comamessenger/core/internal/testdb"
)

const (
	testChatAdminID  = "00000000-0000-7000-8000-000000000010"
	testModeratorID  = "00000000-0000-7000-8000-000000000011"
	testOutsiderID   = "00000000-0000-7000-8000-000000000012"
	testAvatarChatID = "00000000-0000-7000-8000-000000000013"
	testDirectChatID = "00000000-0000-7000-8000-000000000014"
)

func TestChatAvatarPermissionsTypesDirectChatsAndRemoval(t *testing.T) {
	pool := testdb.New(t)
	seedFileActors(t, pool)
	if _, err := pool.Exec(t.Context(), `
		INSERT INTO actors (id, org_id, type, org_role, display_name, handle)
		VALUES ($1, $4, 'user', 'member', 'Chat admin', 'chat-admin'),
		       ($2, $4, 'user', 'admin', 'Moderator', 'moderator'),
		       ($3, $4, 'user', 'member', 'Outsider', 'outsider')`, testChatAdminID, testModeratorID, testOutsiderID, testOrgID); err != nil {
		t.Fatal(err)
	}
	tx, err := pool.Begin(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(t.Context())
	if _, err := tx.Exec(t.Context(), `INSERT INTO chats (id, org_id, kind, visibility, name, created_by) VALUES ($1, $2, 'group', 'private', 'Avatars', $3)`, testAvatarChatID, testOrgID, testOwnerID); err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(t.Context(), `INSERT INTO chat_members (chat_id, actor_id, org_id, role) VALUES ($1, $3, $2, 'owner'), ($1, $4, $2, 'admin'), ($1, $5, $2, 'member')`, testAvatarChatID, testOrgID, testOwnerID, testChatAdminID, testMemberID); err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(t.Context(), `INSERT INTO chats (id, org_id, kind, visibility, direct_pair_key, created_by) VALUES ($1, $2, 'direct', 'private', 'owner:member', $3)`, testDirectChatID, testOrgID, testOwnerID); err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(t.Context(), `INSERT INTO chat_members (chat_id, actor_id, org_id, role) VALUES ($1, $3, $2, 'member'), ($1, $4, $2, 'member')`, testDirectChatID, testOrgID, testOwnerID, testMemberID); err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(t.Context()); err != nil {
		t.Fatal(err)
	}
	store, err := storage.NewLocalBlobStore(t.TempDir(), 0)
	if err != nil {
		t.Fatal(err)
	}
	service, err := NewService(pool, store, "", 1<<20, 1<<20, 1<<20, time.Hour, time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	chats := chat.NewService(pool)
	owner := identity.User{ActorID: testOwnerID, OrgID: testOrgID, OrgRole: "owner"}
	member := identity.User{ActorID: testMemberID, OrgID: testOrgID, OrgRole: "member"}
	chatAdmin := identity.User{ActorID: testChatAdminID, OrgID: testOrgID, OrgRole: "member"}
	moderator := identity.User{ActorID: testModeratorID, OrgID: testOrgID, OrgRole: "admin", Permissions: []permission.Code{permission.ChatsModerate}}
	plainAdmin := identity.User{ActorID: testModeratorID, OrgID: testOrgID, OrgRole: "admin"}
	outsider := identity.User{ActorID: testOutsiderID, OrgID: testOrgID, OrgRole: "member"}

	pngData := encodeTestImage(t, "png")
	jpegData := encodeTestImage(t, "jpeg")

	if _, err := service.PutChatAvatar(t.Context(), member, testAvatarChatID, "image/png", bytes.NewReader(pngData)); !errors.Is(err, ErrForbidden) {
		t.Fatalf("chat member replacing avatar error = %v", err)
	}
	for _, actor := range []identity.User{outsider, plainAdmin} {
		if _, err := service.PutChatAvatar(t.Context(), actor, testAvatarChatID, "image/png", bytes.NewReader(pngData)); !errors.Is(err, ErrNotFound) {
			t.Fatalf("non-member %s replacing avatar error = %v", actor.ActorID, err)
		}
	}
	rejected := map[string][]byte{
		"image/svg+xml": []byte(`<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>`),
		"image/webp":    append([]byte("RIFF\x00\x00\x00\x00WEBPVP8 "), make([]byte, 32)...),
		"image/gif":     append([]byte("GIF89a"), make([]byte, 32)...),
		"text/plain":    []byte("not an image"),
	}
	for contentType, body := range rejected {
		if _, err := service.PutChatAvatar(t.Context(), owner, testAvatarChatID, contentType, bytes.NewReader(body)); !errors.Is(err, ErrInvalid) {
			t.Fatalf("%s chat avatar error = %v", contentType, err)
		}
	}
	if _, err := service.PutChatAvatar(t.Context(), owner, testAvatarChatID, "image/jpeg", bytes.NewReader(pngData)); !errors.Is(err, ErrInvalid) {
		t.Fatalf("mismatched content type error = %v", err)
	}
	if _, err := service.PutChatAvatar(t.Context(), owner, testAvatarChatID, "image/png", bytes.NewReader(make([]byte, maxAvatarBytes+1))); !errors.Is(err, ErrInvalid) {
		t.Fatalf("oversized chat avatar error = %v", err)
	}
	if _, err := service.PutChatAvatar(t.Context(), owner, testDirectChatID, "image/png", bytes.NewReader(pngData)); !errors.Is(err, ErrDirectChat) {
		t.Fatalf("direct chat avatar error = %v", err)
	}
	if _, err := service.DeleteChatAvatar(t.Context(), member, testDirectChatID); !errors.Is(err, ErrDirectChat) {
		t.Fatalf("direct chat avatar removal error = %v", err)
	}
	if _, err := service.DeleteChatAvatar(t.Context(), owner, testAvatarChatID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("removing a missing chat avatar error = %v", err)
	}

	updated, err := service.PutChatAvatar(t.Context(), chatAdmin, testAvatarChatID, "image/png", bytes.NewReader(pngData))
	if err != nil {
		t.Fatal(err)
	}
	if updated.ChatID != testAvatarChatID || updated.AvatarVersion != 1 {
		t.Fatalf("chat avatar update = %#v", updated)
	}
	assertChatAvatarVersion(t, chats, member, 1)
	download, err := service.ChatAvatar(t.Context(), member, testAvatarChatID)
	if err != nil {
		t.Fatal(err)
	}
	download.Reader.Close()
	if download.File.MIME != "image/png" {
		t.Fatalf("chat avatar MIME = %q", download.File.MIME)
	}
	if _, err := service.ChatAvatar(t.Context(), outsider, testAvatarChatID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("outsider chat avatar error = %v", err)
	}
	foreign := identity.User{ActorID: "00000000-0000-7000-8000-000000000099", OrgID: "00000000-0000-7000-8000-000000000098", OrgRole: "owner"}
	if _, err := service.ChatAvatar(t.Context(), foreign, testAvatarChatID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("cross-organization chat avatar error = %v", err)
	}

	var firstFileID string
	if err := pool.QueryRow(t.Context(), `SELECT avatar_file_id FROM chats WHERE id = $1`, testAvatarChatID).Scan(&firstFileID); err != nil {
		t.Fatal(err)
	}
	replaced, err := service.PutChatAvatar(t.Context(), moderator, testAvatarChatID, "image/jpeg; charset=binary", bytes.NewReader(jpegData))
	if err != nil {
		t.Fatal(err)
	}
	if replaced.AvatarVersion != 2 {
		t.Fatalf("replaced chat avatar version = %d", replaced.AvatarVersion)
	}
	var firstStatus string
	if err := pool.QueryRow(t.Context(), `SELECT status FROM files WHERE id = $1`, firstFileID).Scan(&firstStatus); err != nil {
		t.Fatal(err)
	}
	if firstStatus != "deleted" {
		t.Fatalf("replaced chat avatar file status = %q", firstStatus)
	}
	assertUsage(t, pool, int64(len(jpegData)), 0)
	if _, err := service.ChatAvatar(t.Context(), moderator, testAvatarChatID); err != nil {
		t.Fatalf("moderator chat avatar error = %v", err)
	}

	// The unattached-file sweeper must keep a chat avatar.
	if _, err := pool.Exec(t.Context(), `UPDATE files SET ready_at = now() - interval '2 hours' WHERE org_id = $1`, testOrgID); err != nil {
		t.Fatal(err)
	}
	if _, err := service.Reconcile(t.Context()); err != nil {
		t.Fatal(err)
	}
	if _, err := service.ChatAvatar(t.Context(), member, testAvatarChatID); err != nil {
		t.Fatalf("chat avatar after cleanup error = %v", err)
	}

	if _, err := service.DeleteChatAvatar(t.Context(), member, testAvatarChatID); !errors.Is(err, ErrForbidden) {
		t.Fatalf("chat member removing avatar error = %v", err)
	}
	removed, err := service.DeleteChatAvatar(t.Context(), owner, testAvatarChatID)
	if err != nil {
		t.Fatal(err)
	}
	if removed.AvatarVersion != 0 {
		t.Fatalf("removed chat avatar version = %d", removed.AvatarVersion)
	}
	assertChatAvatarVersion(t, chats, member, 0)
	if _, err := service.ChatAvatar(t.Context(), member, testAvatarChatID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("removed chat avatar error = %v", err)
	}
	assertUsage(t, pool, 0, 0)

	again, err := service.PutChatAvatar(t.Context(), owner, testAvatarChatID, "image/png", bytes.NewReader(pngData))
	if err != nil {
		t.Fatal(err)
	}
	if again.AvatarVersion != 4 {
		t.Fatalf("version after re-upload = %d, want a fresh cache key", again.AvatarVersion)
	}

	var events int
	if err := pool.QueryRow(t.Context(), `SELECT count(*) FROM events WHERE org_id = $1 AND type = 'chat.updated' AND chat_id = $2`, testOrgID, testAvatarChatID).Scan(&events); err != nil {
		t.Fatal(err)
	}
	if events != 4 {
		t.Fatalf("chat.updated events = %d, want 4", events)
	}
	var audits int
	if err := pool.QueryRow(t.Context(), `SELECT count(*) FROM audit_log WHERE org_id = $1 AND action = 'chat.avatar.update' AND target_id = $2`, testOrgID, testAvatarChatID).Scan(&audits); err != nil {
		t.Fatal(err)
	}
	if audits != 4 {
		t.Fatalf("chat avatar audit entries = %d, want 4", audits)
	}
}

func assertChatAvatarVersion(t *testing.T, chats *chat.Service, user identity.User, want int64) {
	t.Helper()
	got, err := chats.Get(t.Context(), user, testAvatarChatID)
	if err != nil {
		t.Fatal(err)
	}
	if got.AvatarVersion != want {
		t.Fatalf("chat avatar_version = %d, want %d", got.AvatarVersion, want)
	}
	list, err := chats.List(t.Context(), user)
	if err != nil {
		t.Fatal(err)
	}
	for _, item := range list {
		if item.ID == testAvatarChatID && item.AvatarVersion != want {
			t.Fatalf("chat list avatar_version = %d, want %d", item.AvatarVersion, want)
		}
		if item.ID == testDirectChatID && item.AvatarVersion != 0 {
			t.Fatalf("direct chat avatar_version = %d", item.AvatarVersion)
		}
	}
}

func encodeTestImage(t *testing.T, format string) []byte {
	t.Helper()
	source := image.NewRGBA(image.Rect(0, 0, 16, 16))
	for y := 0; y < 16; y++ {
		for x := 0; x < 16; x++ {
			source.Set(x, y, color.RGBA{R: 20, G: uint8(x * 12), B: uint8(y * 12), A: 255})
		}
	}
	buffer := new(bytes.Buffer)
	var err error
	if format == "jpeg" {
		err = jpeg.Encode(buffer, source, nil)
	} else {
		err = png.Encode(buffer, source)
	}
	if err != nil {
		t.Fatal(err)
	}
	return buffer.Bytes()
}
