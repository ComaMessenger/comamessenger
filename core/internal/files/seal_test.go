package files

import (
	"bytes"
	"context"
	"errors"
	"io"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"testing"
	"time"

	"github.com/comamessenger/comamessenger/core/internal/identity"
	"github.com/comamessenger/comamessenger/core/internal/storage"
	"github.com/comamessenger/comamessenger/core/internal/testdb"
)

// presignedLocalStore behaves like an object store with presigned uploads:
// "uploading" through a URL writes the key straight into the local store.
type presignedLocalStore struct{ *storage.LocalBlobStore }

func (presignedLocalStore) Capabilities() storage.Capabilities {
	return storage.Capabilities{PresignedUpload: true, MultipartUpload: true}
}

func (presignedLocalStore) PresignUpload(_ context.Context, key, _ string, _ int64, _ time.Duration) (*url.URL, error) {
	return &url.URL{Scheme: "fake", Path: "/" + key}, nil
}

func (presignedLocalStore) PresignDownload(_ context.Context, key string, _ time.Duration) (*url.URL, error) {
	return &url.URL{Scheme: "fake", Path: "/" + key}, nil
}

type sealHarness struct {
	store storage.BlobStore
	// put writes body through the presigned upload URL, as a client would.
	put func(t *testing.T, upload Upload, body []byte)
	// empty is a store of the same kind whose bucket exists but holds none
	// of these objects; missing is one whose bucket does not exist. They
	// stand for a Core pointed at the wrong storage.
	empty, missing func(t *testing.T) storage.BlobStore
}

func fakeSealHarness(t *testing.T) sealHarness {
	local, err := storage.NewLocalBlobStore(t.TempDir(), 0)
	if err != nil {
		t.Fatal(err)
	}
	store := presignedLocalStore{local}
	return sealHarness{store: store, empty: func(t *testing.T) storage.BlobStore {
		other, err := storage.NewLocalBlobStore(t.TempDir(), 0)
		if err != nil {
			t.Fatal(err)
		}
		return presignedLocalStore{other}
	}, missing: func(t *testing.T) storage.BlobStore {
		root := t.TempDir() + "/gone"
		other, err := storage.NewLocalBlobStore(root, 0)
		if err != nil {
			t.Fatal(err)
		}
		if err := os.Remove(root); err != nil {
			t.Fatal(err)
		}
		return presignedLocalStore{other}
	}, put: func(t *testing.T, upload Upload, body []byte) {
		t.Helper()
		target, err := url.Parse(*upload.UploadURL)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := local.Put(t.Context(), storage.PutRequest{Key: target.Path[1:], Size: int64(len(body)), Body: bytes.NewReader(body)}); err != nil {
			t.Fatal(err)
		}
	}}
}

// minioSealHarness runs against MinIO or another S3 provider when TEST_S3_*
// is set, sending real presigned PUT requests.
func minioSealHarness(t *testing.T) sealHarness {
	endpoint, bucket := os.Getenv("TEST_S3_ENDPOINT"), os.Getenv("TEST_S3_BUCKET")
	if endpoint == "" || bucket == "" {
		if os.Getenv("TEST_S3_REQUIRED") != "" {
			t.Fatal("TEST_S3_REQUIRED is set but TEST_S3_ENDPOINT or TEST_S3_BUCKET is not")
		}
		t.Skip("TEST_S3_ENDPOINT and TEST_S3_BUCKET are not set")
	}
	pathStyle, _ := strconv.ParseBool(os.Getenv("TEST_S3_FORCE_PATH_STYLE"))
	open := func(t *testing.T, bucket, prefix string) *storage.S3BlobStore {
		store, err := storage.NewS3BlobStore(t.Context(), storage.S3Options{
			Endpoint: endpoint, PublicEndpoint: os.Getenv("TEST_S3_PUBLIC_ENDPOINT"), Region: "us-east-1", Bucket: bucket,
			AccessKey: os.Getenv("TEST_S3_ACCESS_KEY"), SecretKey: os.Getenv("TEST_S3_SECRET_KEY"),
			Prefix: prefix, ForcePathStyle: pathStyle,
		})
		if err != nil {
			t.Fatal(err)
		}
		return store
	}
	unique := func(name string) string { return name + "-" + strconv.FormatInt(time.Now().UnixNano(), 10) }
	store := open(t, bucket, unique("seal-tests"))
	return sealHarness{store: store, empty: func(t *testing.T) storage.BlobStore {
		return open(t, bucket, unique("empty-prefix"))
	}, missing: func(t *testing.T) storage.BlobStore {
		return open(t, unique("coma-missing"), "")
	}, put: func(t *testing.T, upload Upload, body []byte) {
		t.Helper()
		request, err := http.NewRequestWithContext(t.Context(), http.MethodPut, *upload.UploadURL, bytes.NewReader(body))
		if err != nil {
			t.Fatal(err)
		}
		request.Header.Set("Content-Type", upload.File.MIME)
		response, err := http.DefaultClient.Do(request)
		if err != nil {
			t.Fatal(err)
		}
		response.Body.Close()
		if response.StatusCode != http.StatusOK {
			t.Fatalf("presigned PUT status = %d", response.StatusCode)
		}
	}}
}

func TestCompletedUploadCannotBeReplacedThroughItsUploadURL(t *testing.T) {
	t.Run("presigned fake", func(t *testing.T) { runSealTest(t, fakeSealHarness(t)) })
	t.Run("s3", func(t *testing.T) { runSealTest(t, minioSealHarness(t)) })
}

func runSealTest(t *testing.T, harness sealHarness) {
	pool := testdb.New(t)
	seedFileActors(t, pool)
	// A 1 KiB multipart threshold: a voice recording must still go up as one PUT.
	service, err := NewService(pool, harness.store, os.Getenv("TEST_S3_BUCKET"), 64<<20, 32<<20, 1<<10, time.Hour, 15*time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	owner := identity.User{ActorID: testOwnerID, OrgID: testOrgID, OrgRole: "owner"}
	recorded, err := os.ReadFile("testdata/voice.m4a")
	if err != nil {
		t.Fatal(err)
	}
	download := func(fileID string) []byte {
		t.Helper()
		var key string
		if err := pool.QueryRow(t.Context(), `SELECT storage_key FROM files WHERE id = $1`, fileID).Scan(&key); err != nil {
			t.Fatal(err)
		}
		reader, _, err := harness.store.Open(t.Context(), key)
		if err != nil {
			t.Fatal(err)
		}
		defer reader.Close()
		data, err := io.ReadAll(reader)
		if err != nil {
			t.Fatal(err)
		}
		return data
	}

	cases := []struct {
		name, file, mime string
		body             []byte
		voice            *Voice
	}{
		{"voice", "voice.m4a", "audio/mp4", recorded, &Voice{DurationMs: 1400, Waveform: voiceWaveform(9)}},
		{"ordinary file", "notes.txt", "text/plain", bytes.Repeat([]byte("plain text "), 20), nil},
	}
	for _, item := range cases {
		upload, err := service.CreateUpload(t.Context(), owner, CreateUploadInput{Name: item.file, MIME: item.mime, Size: int64(len(item.body)), Voice: item.voice})
		if err != nil {
			t.Fatal(err)
		}
		if upload.Mode != "presigned" || upload.UploadURL == nil {
			t.Fatalf("%s: upload mode = %q, want one presigned PUT", item.name, upload.Mode)
		}
		harness.put(t, upload, item.body)
		ready, err := service.CompleteUpload(t.Context(), owner, upload.ID, nil)
		if err != nil {
			t.Fatalf("%s: complete: %v", item.name, err)
		}
		var key string
		if err := pool.QueryRow(t.Context(), `SELECT storage_key FROM files WHERE id = $1`, ready.ID).Scan(&key); err != nil {
			t.Fatal(err)
		}
		if bytes.Contains([]byte(*upload.UploadURL), []byte(key)) {
			t.Fatalf("%s: served key %q appears in the upload URL", item.name, key)
		}
		// The URL is still within its TTL: a second PUT of the same size
		// must not change what readers get.
		harness.put(t, upload, bytes.Repeat([]byte{'X'}, len(item.body)))
		if got := download(ready.ID); !bytes.Equal(got, item.body) {
			t.Fatalf("%s: served bytes changed after a PUT to the old URL", item.name)
		}
		if item.voice != nil && (ready.Voice == nil || ready.Voice.DurationMs < 1300) {
			t.Fatalf("voice metadata = %+v", ready.Voice)
		}
	}
	assertUsage(t, pool, int64(len(recorded))+int64(len(cases[1].body)), 0)

	// A recording that is not audio is refused and leaves no object behind.
	upload, err := service.CreateUpload(t.Context(), owner, CreateUploadInput{Name: "voice.m4a", MIME: "audio/mp4", Size: 64, Voice: &Voice{DurationMs: 1400, Waveform: voiceWaveform(9)}})
	if err != nil {
		t.Fatal(err)
	}
	harness.put(t, upload, bytes.Repeat([]byte{0}, 64))
	if _, err := service.CompleteUpload(t.Context(), owner, upload.ID, nil); err == nil {
		t.Fatal("garbage voice completed")
	}
	if _, err := harness.store.Stat(t.Context(), upload.File.storageKey); err == nil {
		t.Fatal("rejected upload key still stored")
	}

	// The upload URL of the failed file still works: a client PUTs again.
	// Reconciliation treats the object as an orphan (only pending and ready
	// files own objects), and retires the failed row once its URLs expired.
	harness.put(t, upload, bytes.Repeat([]byte{1}, 64))
	if _, err := harness.store.Stat(t.Context(), upload.File.storageKey); err != nil {
		t.Fatalf("re-PUT object: %v", err)
	}
	service.orphanGrace = 0
	if _, err := pool.Exec(t.Context(), `UPDATE files SET failed_at = now() - interval '3 hours' WHERE id = $1`, upload.File.ID); err != nil {
		t.Fatal(err)
	}
	stats, err := service.Reconcile(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	if _, err := harness.store.Stat(t.Context(), upload.File.storageKey); err == nil {
		t.Fatalf("object written to a failed file's key survived reconciliation (stats %+v)", stats)
	}
	var status string
	if err := pool.QueryRow(t.Context(), `SELECT status FROM files WHERE id = $1`, upload.File.ID).Scan(&status); err != nil || status != "deleted" || stats.RetiredFailed < 1 {
		t.Fatalf("failed file after its URLs expired: status %q, stats %+v, err %v", status, stats, err)
	}
	// Sealed objects of ready files are kept.
	var ready int
	if err := pool.QueryRow(t.Context(), `SELECT count(*) FROM files WHERE status = 'ready'`).Scan(&ready); err != nil || ready != 2 {
		t.Fatalf("ready files after reconciliation = %d, err = %v", ready, err)
	}
	rows, err := pool.Query(t.Context(), `SELECT storage_key FROM files WHERE status = 'ready'`)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	for rows.Next() {
		var key string
		if err := rows.Scan(&key); err != nil {
			t.Fatal(err)
		}
		if _, err := harness.store.Stat(t.Context(), key); err != nil {
			t.Fatalf("sealed object %s removed by reconciliation: %v", key, err)
		}
	}
}

// faultyStore wraps a store to fail or interrupt the sealing copy and to
// record the TTL of upload URLs.
type faultyStore struct {
	storage.BlobStore
	failCopies int
	onCopy     func()
	uploadTTLs []time.Duration
	failReads  int
	failStats  bool
}

func (s *faultyStore) Stat(ctx context.Context, key string) (storage.Blob, error) {
	if s.failStats {
		return storage.Blob{}, errors.New("injected stat failure")
	}
	return s.BlobStore.Stat(ctx, key)
}

func (s *faultyStore) CheckBucket(ctx context.Context) error {
	if checker, ok := s.BlobStore.(storage.BucketChecker); ok {
		return checker.CheckBucket(ctx)
	}
	return nil
}

func (s *faultyStore) List(ctx context.Context) ([]storage.Blob, error) {
	if lister, ok := s.BlobStore.(storage.BlobLister); ok {
		return lister.List(ctx)
	}
	return nil, nil
}

func (s *faultyStore) Copy(ctx context.Context, source, destination string) (storage.Blob, error) {
	if s.onCopy != nil {
		s.onCopy()
	}
	if s.failCopies > 0 {
		s.failCopies--
		return storage.Blob{}, errors.New("injected copy failure")
	}
	return s.BlobStore.(storage.ServerCopier).Copy(ctx, source, destination)
}

func (s *faultyStore) ReadRange(ctx context.Context, key string, offset, length int64) ([]byte, error) {
	if s.failReads > 0 {
		s.failReads--
		return nil, errors.New("injected read failure")
	}
	return s.BlobStore.(storage.RangeReader).ReadRange(ctx, key, offset, length)
}

func (s *faultyStore) PresignUpload(ctx context.Context, key, contentType string, size int64, ttl time.Duration) (*url.URL, error) {
	s.uploadTTLs = append(s.uploadTTLs, ttl)
	return s.BlobStore.PresignUpload(ctx, key, contentType, size, ttl)
}

func TestFailedOrCancelledSealingKeepsTheUploadRetryable(t *testing.T) {
	t.Run("presigned fake", func(t *testing.T) { runRetryableSealTest(t, fakeSealHarness(t)) })
	t.Run("s3", func(t *testing.T) { runRetryableSealTest(t, minioSealHarness(t)) })
}

func runRetryableSealTest(t *testing.T, harness sealHarness) {
	pool := testdb.New(t)
	seedFileActors(t, pool)
	store := &faultyStore{BlobStore: harness.store}
	service, err := NewService(pool, store, os.Getenv("TEST_S3_BUCKET"), 64<<20, 32<<20, 16<<20, time.Hour, 15*time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	owner := identity.User{ActorID: testOwnerID, OrgID: testOrgID, OrgRole: "owner"}
	body := bytes.Repeat([]byte("retryable "), 30)
	upload, err := service.CreateUpload(t.Context(), owner, CreateUploadInput{Name: "notes.txt", MIME: "text/plain", Size: int64(len(body))})
	if err != nil {
		t.Fatal(err)
	}
	// Upload URLs live 5 minutes even with a 15-minute FILE_PRESIGN_TTL.
	if len(store.uploadTTLs) != 1 || store.uploadTTLs[0] != maxUploadURLTTL {
		t.Fatalf("upload URL TTLs = %v, want %v", store.uploadTTLs, maxUploadURLTTL)
	}
	harness.put(t, upload, body)

	// A failed copy keeps the client's object and the open upload.
	store.failCopies = 1
	if _, err := service.CompleteUpload(t.Context(), owner, upload.ID, nil); !errors.Is(err, ErrUnavailable) {
		t.Fatalf("complete with a failing copy = %v, want ErrUnavailable", err)
	}
	if _, err := harness.store.Stat(t.Context(), upload.File.storageKey); err != nil {
		t.Fatalf("client object after a failed copy: %v", err)
	}
	var uploadStatus, fileStatus string
	if err := pool.QueryRow(t.Context(), `SELECT u.status, f.status FROM file_uploads u JOIN files f ON f.id = u.file_id WHERE u.id = $1`, upload.ID).Scan(&uploadStatus, &fileStatus); err != nil || uploadStatus != "active" || fileStatus != "pending" {
		t.Fatalf("after a failed copy: upload %q, file %q, err %v", uploadStatus, fileStatus, err)
	}
	assertUsage(t, pool, 0, int64(len(body)))

	// The client disconnects mid-copy: the completion still finishes.
	request, cancel := context.WithCancel(t.Context())
	store.onCopy = cancel
	ready, err := service.CompleteUpload(request, owner, upload.ID, nil)
	store.onCopy = nil
	if err != nil {
		t.Fatalf("complete cancelled mid-copy: %v", err)
	}
	if _, err := harness.store.Stat(t.Context(), upload.File.storageKey); err == nil {
		t.Fatal("upload key kept after commit")
	}
	// Repeating complete returns the same file, copies nothing and charges
	// the quota once.
	again, err := service.CompleteUpload(t.Context(), owner, upload.ID, nil)
	if err != nil || again.ID != ready.ID || again.Status != "ready" {
		t.Fatalf("repeated complete = %+v, err = %v", again, err)
	}
	assertUsage(t, pool, int64(len(body)), 0)
	if lister, ok := harness.store.(storage.BlobLister); ok {
		blobs, err := lister.List(t.Context())
		if err != nil {
			t.Fatal(err)
		}
		if len(blobs) != 1 {
			t.Fatalf("stored objects after retries = %d (%v), want the sealed copy only", len(blobs), blobs)
		}
	}
}

// noRangeStore hides ReadRange from an otherwise complete store.
type noRangeStore struct{ storage.BlobStore }

func TestNewServiceRequiresRangeReads(t *testing.T) {
	local, err := storage.NewLocalBlobStore(t.TempDir(), 0)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := NewService(nil, noRangeStore{local}, "", 10, 10, 5, time.Hour, time.Minute); err == nil {
		t.Fatal("NewService accepted a store that cannot read byte ranges")
	}
}
