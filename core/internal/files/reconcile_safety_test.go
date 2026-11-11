package files

import (
	"bytes"
	"context"
	"errors"
	"io"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/comamessenger/comamessenger/core/internal/identity"
	"github.com/comamessenger/comamessenger/core/internal/storage"
	"github.com/comamessenger/comamessenger/core/internal/testdb"
	"github.com/jackc/pgx/v5/pgxpool"
)

type storedFile struct {
	ID, Key string
	Body    []byte
}

func uploadFiles(t *testing.T, service *Service, harness sealHarness, count int) []storedFile {
	t.Helper()
	owner := identity.User{ActorID: testOwnerID, OrgID: testOrgID, OrgRole: "owner"}
	result := make([]storedFile, 0, count)
	for index := range count {
		body := bytes.Repeat([]byte{byte('a' + index)}, 100+index)
		upload, err := service.CreateUpload(t.Context(), owner, CreateUploadInput{Name: "file.txt", MIME: "text/plain", Size: int64(len(body))})
		if err != nil {
			t.Fatal(err)
		}
		harness.put(t, upload, body)
		ready, err := service.CompleteUpload(t.Context(), owner, upload.ID, nil)
		if err != nil {
			t.Fatal(err)
		}
		var key string
		if err := service.pool.QueryRow(t.Context(), `SELECT storage_key FROM files WHERE id = $1`, ready.ID).Scan(&key); err != nil {
			t.Fatal(err)
		}
		result = append(result, storedFile{ID: ready.ID, Key: key, Body: body})
	}
	return result
}

func assertFilesIntact(t *testing.T, pool *pgxpool.Pool, store storage.BlobStore, stored []storedFile) {
	t.Helper()
	for _, file := range stored {
		var status string
		if err := pool.QueryRow(t.Context(), `SELECT status FROM files WHERE id = $1`, file.ID).Scan(&status); err != nil || status != "ready" {
			t.Fatalf("file %s status = %q, err = %v; want ready", file.ID, status, err)
		}
		reader, _, err := store.Open(t.Context(), file.Key)
		if err != nil {
			t.Fatalf("object %s: %v", file.Key, err)
		}
		data, err := io.ReadAll(reader)
		reader.Close()
		if err != nil || !bytes.Equal(data, file.Body) {
			t.Fatalf("object %s changed: %d bytes, err %v", file.Key, len(data), err)
		}
	}
}

func TestReconcileAgainstWrongStorageChangesNothing(t *testing.T) {
	t.Run("presigned fake", func(t *testing.T) { runWrongStorageTest(t, fakeSealHarness(t)) })
	t.Run("s3", func(t *testing.T) { runWrongStorageTest(t, minioSealHarness(t)) })
}

// A Core pointed for a while at a missing bucket, or at an empty one, must
// leave every file and object as it was; reconciling against the right
// storage afterwards finds everything in place.
func runWrongStorageTest(t *testing.T, harness sealHarness) {
	pool := testdb.New(t)
	seedFileActors(t, pool)
	newService := func(store storage.BlobStore) *Service {
		service, err := NewService(pool, store, os.Getenv("TEST_S3_BUCKET"), 64<<20, 32<<20, 16<<20, time.Hour, 15*time.Minute)
		if err != nil {
			t.Fatal(err)
		}
		service.orphanGrace = 0
		return service
	}
	right := newService(harness.store)
	stored := uploadFiles(t, right, harness, 4)

	for name, store := range map[string]storage.BlobStore{"missing bucket": harness.missing(t), "empty bucket": harness.empty(t)} {
		wrong := newService(store)
		for range 3 {
			if _, err := wrong.Reconcile(t.Context()); !errors.Is(err, ErrStorageSuspect) {
				t.Fatalf("%s: Reconcile = %v, want ErrStorageSuspect", name, err)
			}
		}
		if err := wrong.CheckStorage(t.Context()); err == nil {
			t.Fatalf("%s: CheckStorage passed", name)
		}
		assertFilesIntact(t, pool, harness.store, stored)
	}
	// Objects already checked recently are not re-checked; the empty bucket
	// is then caught by the orphan pass instead.
	if _, err := pool.Exec(t.Context(), `UPDATE files SET reconciled_at = now()`); err != nil {
		t.Fatal(err)
	}
	if _, err := newService(harness.empty(t)).Reconcile(t.Context()); !errors.Is(err, ErrStorageSuspect) || !strings.Contains(err.Error(), "no Core objects") {
		t.Fatalf("empty bucket with recent checks = %v, want the orphan-pass guard", err)
	}
	if _, err := pool.Exec(t.Context(), `UPDATE files SET reconciled_at = NULL`); err != nil {
		t.Fatal(err)
	}

	stats, err := right.Reconcile(t.Context())
	if err != nil || stats.MissingBlobs != 0 || stats.OrphanBlobs != 0 {
		t.Fatalf("Reconcile on the right storage = %+v, %v", stats, err)
	}
	if err := right.CheckStorage(t.Context()); err != nil {
		t.Fatalf("CheckStorage on the right storage: %v", err)
	}
	assertFilesIntact(t, pool, harness.store, stored)

	// One object really missing: noted first, failed only after the
	// recheck delay, and restored when it comes back.
	lost := stored[0]
	if err := harness.store.Delete(t.Context(), lost.Key); err != nil {
		t.Fatal(err)
	}
	// The daily check comes round again.
	if _, err := pool.Exec(t.Context(), `UPDATE files SET reconciled_at = NULL WHERE id = $1`, lost.ID); err != nil {
		t.Fatal(err)
	}
	var status string
	var missingSince *time.Time
	if _, err := right.Reconcile(t.Context()); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(t.Context(), `SELECT status, missing_since FROM files WHERE id = $1`, lost.ID).Scan(&status, &missingSince); err != nil || status != "ready" || missingSince == nil {
		t.Fatalf("after one missing sighting: status %q, missing_since %v, err %v", status, missingSince, err)
	}
	if _, err := pool.Exec(t.Context(), `UPDATE files SET missing_since = now() - interval '2 hours' WHERE id = $1`, lost.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := right.Reconcile(t.Context()); err != nil {
		t.Fatal(err)
	}
	var readyAt, failedAt *time.Time
	if err := pool.QueryRow(t.Context(), `SELECT status, ready_at, failed_at FROM files WHERE id = $1`, lost.ID).Scan(&status, &readyAt, &failedAt); err != nil || status != "failed" || readyAt == nil || failedAt == nil {
		t.Fatalf("after the recheck delay: status %q, ready_at %v, failed_at %v, err %v", status, readyAt, failedAt, err)
	}
	// A failed file that was ready is never retired, even long after.
	if _, err := pool.Exec(t.Context(), `UPDATE files SET failed_at = now() - interval '30 days' WHERE id = $1`, lost.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := harness.store.Put(t.Context(), storage.PutRequest{Key: lost.Key, Size: int64(len(lost.Body)), Body: bytes.NewReader(lost.Body)}); err != nil {
		t.Fatal(err)
	}
	stats, err = right.Reconcile(t.Context())
	if err != nil || stats.RestoredFiles != 1 {
		t.Fatalf("Reconcile after the object came back = %+v, %v", stats, err)
	}
	assertFilesIntact(t, pool, harness.store, stored)

	// The object of a once-ready file is never an orphan, whatever its status.
	if _, err := pool.Exec(t.Context(), `UPDATE files SET status = 'failed', failed_at = now() - interval '30 days', missing_since = NULL WHERE id = $1`, stored[1].ID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(t.Context(), `UPDATE files SET status = 'deleted' WHERE id = $1`, stored[2].ID); err != nil {
		t.Fatal(err)
	}
	if _, err := right.Reconcile(t.Context()); err != nil {
		t.Fatal(err)
	}
	for _, file := range stored[1:3] {
		if _, err := harness.store.Stat(t.Context(), file.Key); err != nil {
			t.Fatalf("object of once-ready file %s was collected: %v", file.ID, err)
		}
	}
	// A store error during the check stops the pass instead of failing files.
	flaky := &faultyStore{BlobStore: harness.store, failStats: true}
	if _, err := pool.Exec(t.Context(), `UPDATE files SET reconciled_at = NULL, status = 'ready', failed_at = NULL`); err != nil {
		t.Fatal(err)
	}
	if _, err := newService(flaky).Reconcile(t.Context()); err == nil || errors.Is(err, ErrStorageSuspect) {
		t.Fatalf("Reconcile with failing Stat = %v, want the store error", err)
	}
	assertFilesIntact(t, pool, harness.store, stored)
}

// A completion holds a lease: a second complete meanwhile gets ErrUnavailable
// (503), expiry cleanup leaves it alone, and once the lease lapses (the
// process died) a new request takes the upload over.
func TestCompletionLeaseIsTakenOverAfterItLapses(t *testing.T) {
	pool := testdb.New(t)
	seedFileActors(t, pool)
	harness := fakeSealHarness(t)
	service, err := NewService(pool, harness.store, "", 64<<20, 32<<20, 16<<20, time.Hour, 15*time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	owner := identity.User{ActorID: testOwnerID, OrgID: testOrgID, OrgRole: "owner"}
	body := []byte("leased upload body")
	upload, err := service.CreateUpload(t.Context(), owner, CreateUploadInput{Name: "notes.txt", MIME: "text/plain", Size: int64(len(body))})
	if err != nil {
		t.Fatal(err)
	}
	harness.put(t, upload, body)
	// A completion is running elsewhere, and the upload has just expired.
	if _, err := pool.Exec(t.Context(), `UPDATE file_uploads SET status = 'uploading', claim_expires_at = now() + interval '1 minute', created_at = now() - interval '1 hour', expires_at = now() - interval '1 second' WHERE id = $1`, upload.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := service.CompleteUpload(t.Context(), owner, upload.ID, nil); !errors.Is(err, ErrUnavailable) {
		t.Fatalf("complete during another completion = %v, want ErrUnavailable", err)
	}
	if _, err := service.cleanupExpired(context.Background(), 10); err != nil {
		t.Fatal(err)
	}
	var status string
	if err := pool.QueryRow(t.Context(), `SELECT status FROM file_uploads WHERE id = $1`, upload.ID).Scan(&status); err != nil || status != "uploading" {
		t.Fatalf("expiry cleanup during a live completion: status %q, err %v", status, err)
	}
	// The process died: the lease lapses and a retry completes the upload.
	if _, err := pool.Exec(t.Context(), `UPDATE file_uploads SET claim_expires_at = now() - interval '1 second', expires_at = now() + interval '1 hour' WHERE id = $1`, upload.ID); err != nil {
		t.Fatal(err)
	}
	ready, err := service.CompleteUpload(t.Context(), owner, upload.ID, nil)
	if err != nil || ready.Status != "ready" {
		t.Fatalf("takeover after the lease lapsed = %+v, %v", ready, err)
	}
	if got := completionTimeout(100 << 20); got != 35*time.Second {
		t.Fatalf("completion timeout for 100 MiB = %v", got)
	}
}
