package files

import (
	"bytes"
	"errors"
	"testing"
	"time"

	"github.com/comamessenger/comamessenger/core/internal/identity"
	"github.com/comamessenger/comamessenger/core/internal/storage"
	"github.com/comamessenger/comamessenger/core/internal/testdb"
	"github.com/jackc/pgx/v5/pgxpool"
)

const (
	testOrgID    = "00000000-0000-7000-8000-000000000001"
	testOwnerID  = "00000000-0000-7000-8000-000000000002"
	testMemberID = "00000000-0000-7000-8000-000000000003"
)

func TestStreamingUploadReservesQuotaCommitsBlobAndAuthorizesAccess(t *testing.T) {
	pool := testdb.New(t)
	seedFileActors(t, pool)
	store, err := storage.NewLocalBlobStore(t.TempDir(), 0)
	if err != nil {
		t.Fatal(err)
	}
	service, err := NewService(pool, store, "", 1024, 512, 128, time.Hour, time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	owner := identity.User{ActorID: testOwnerID, OrgID: testOrgID, OrgRole: "owner"}
	body := []byte("hello searchable file")
	upload, err := service.CreateUpload(t.Context(), owner, CreateUploadInput{Name: "notes.txt", MIME: "text/plain", Size: int64(len(body))})
	if err != nil {
		t.Fatal(err)
	}
	if upload.Mode != "streaming" || upload.UploadURL == nil {
		t.Fatalf("unexpected upload transport: %#v", upload)
	}
	assertUsage(t, pool, 0, int64(len(body)))
	ready, err := service.PutContent(t.Context(), owner, upload.ID, bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	if ready.Status != "ready" || ready.SHA256 == nil {
		t.Fatalf("unexpected ready file: %#v", ready)
	}
	assertUsage(t, pool, int64(len(body)), 0)
	download, err := service.Download(t.Context(), owner, ready.ID)
	if err != nil {
		t.Fatal(err)
	}
	defer download.Reader.Close()
	got := make([]byte, len(body))
	if _, err := download.Reader.Read(got); err != nil || !bytes.Equal(got, body) {
		t.Fatalf("download = %q, err = %v", got, err)
	}
	member := identity.User{ActorID: testMemberID, OrgID: testOrgID, OrgRole: "member"}
	if _, err := service.Get(t.Context(), member, ready.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("unattached file disclosure error = %v, want ErrNotFound", err)
	}
	attachFileForMember(t, pool, ready.ID)
	if _, err := service.Get(t.Context(), member, ready.ID); err != nil {
		t.Fatalf("member could not access attached file: %v", err)
	}
}

func TestUploadQuotaAbortAndMIMEValidationAreFailClosed(t *testing.T) {
	pool := testdb.New(t)
	seedFileActors(t, pool)
	store, err := storage.NewLocalBlobStore(t.TempDir(), 0)
	if err != nil {
		t.Fatal(err)
	}
	service, err := NewService(pool, store, "", 10, 10, 5, time.Hour, time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	owner := identity.User{ActorID: testOwnerID, OrgID: testOrgID, OrgRole: "owner"}
	upload, err := service.CreateUpload(t.Context(), owner, CreateUploadInput{Name: "first.txt", MIME: "text/plain", Size: 8})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := service.CreateUpload(t.Context(), owner, CreateUploadInput{Name: "second.txt", MIME: "text/plain", Size: 3}); !errors.Is(err, ErrStorageFull) {
		t.Fatalf("over-quota create error = %v, want ErrStorageFull", err)
	}
	if err := service.AbortUpload(t.Context(), owner, upload.ID); err != nil {
		t.Fatal(err)
	}
	assertUsage(t, pool, 0, 0)
	spoof, err := service.CreateUpload(t.Context(), owner, CreateUploadInput{Name: "image.png", MIME: "image/png", Size: 5})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := service.PutContent(t.Context(), owner, spoof.ID, bytes.NewReader([]byte("hello"))); !errors.Is(err, ErrInvalid) {
		t.Fatalf("MIME spoof error = %v, want ErrInvalid", err)
	}
	assertUsage(t, pool, 0, 0)
	if _, err := service.CreateUpload(t.Context(), owner, CreateUploadInput{Name: "malware.exe", MIME: "application/octet-stream", Size: 1}); !errors.Is(err, ErrInvalid) {
		t.Fatalf("executable upload error = %v, want ErrInvalid", err)
	}
}

func seedFileActors(t *testing.T, pool *pgxpool.Pool) {
	t.Helper()
	tx, err := pool.Begin(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(t.Context())
	if _, err := tx.Exec(t.Context(), `INSERT INTO organizations (id, name, slug) VALUES ($1, 'Files', 'files')`, testOrgID); err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(t.Context(), `
		INSERT INTO actors (id, org_id, type, org_role, display_name, handle)
		VALUES ($1, $3, 'user', 'owner', 'Owner', 'owner'), ($2, $3, 'user', 'member', 'Member', 'member')`, testOwnerID, testMemberID, testOrgID); err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(t.Context()); err != nil {
		t.Fatal(err)
	}
}

func assertUsage(t *testing.T, pool *pgxpool.Pool, used, reserved int64) {
	t.Helper()
	var gotUsed, gotReserved int64
	if err := pool.QueryRow(t.Context(), `SELECT used_bytes, reserved_bytes FROM organization_storage_usage WHERE org_id = $1`, testOrgID).Scan(&gotUsed, &gotReserved); err != nil {
		t.Fatal(err)
	}
	if gotUsed != used || gotReserved != reserved {
		t.Fatalf("storage usage = (%d, %d), want (%d, %d)", gotUsed, gotReserved, used, reserved)
	}
}

func attachFileForMember(t *testing.T, pool *pgxpool.Pool, fileID string) {
	t.Helper()
	const chatID = "00000000-0000-7000-8000-000000000004"
	const messageID = "00000000-0000-7000-8000-000000000005"
	const clientID = "00000000-0000-7000-8000-000000000006"
	tx, err := pool.Begin(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(t.Context())
	if _, err := tx.Exec(t.Context(), `INSERT INTO chats (id, org_id, kind, visibility, name, created_by) VALUES ($1, $2, 'group', 'private', 'Private', $3)`, chatID, testOrgID, testOwnerID); err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(t.Context(), `INSERT INTO chat_members (chat_id, actor_id, org_id, role) VALUES ($1, $3, $2, 'owner'), ($1, $4, $2, 'member')`, chatID, testOrgID, testOwnerID, testMemberID); err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(t.Context(), `
		INSERT INTO messages (id, org_id, chat_id, actor_id, client_msg_id, create_fingerprint, body, created_seq)
		VALUES ($1, $2, $3, $4, $5, decode(repeat('00', 32), 'hex'), 'attached', 1)`, messageID, testOrgID, chatID, testOwnerID, clientID); err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(t.Context(), `INSERT INTO message_files (message_id, file_id, org_id, ordinal) VALUES ($1, $2, $3, 0)`, messageID, fileID, testOrgID); err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(t.Context()); err != nil {
		t.Fatal(err)
	}
}
