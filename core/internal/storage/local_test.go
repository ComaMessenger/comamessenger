package storage

import (
	"bytes"
	"context"
	"crypto/sha256"
	"errors"
	"io"
	"os"
	"path/filepath"
	"testing"
)

func TestLocalBlobStoreContract(t *testing.T) {
	root := t.TempDir()
	store, err := NewLocalBlobStore(root, 0)
	if err != nil {
		t.Fatal(err)
	}
	runBlobStoreContract(t, store)
	body := []byte("durable local blob")
	checksum := sha256.Sum256(body)
	key := "ab/cd/0198-file"
	created, err := store.Put(context.Background(), PutRequest{Key: key, ContentType: "text/plain", Size: int64(len(body)), ExpectedSHA256: &checksum, Body: bytes.NewReader(body)})
	if err != nil {
		t.Fatal(err)
	}
	if created.Size != int64(len(body)) || created.SHA256 != checksum || !store.Capabilities().StreamingUpload {
		t.Fatalf("unexpected created blob: %#v", created)
	}
	file, metadata, err := store.Open(context.Background(), key)
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	got, err := io.ReadAll(file)
	if err != nil || !bytes.Equal(got, body) || metadata.Size != int64(len(body)) {
		t.Fatalf("read blob = %q, metadata = %#v, err = %v", got, metadata, err)
	}
	info, err := os.Stat(filepath.Join(root, "ab", "cd", "0198-file"))
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("blob permissions = %o, want 600", info.Mode().Perm())
	}
	if err := store.Delete(context.Background(), key); err != nil {
		t.Fatal(err)
	}
	if _, err := store.Stat(context.Background(), key); !errors.Is(err, ErrNotFound) {
		t.Fatalf("Stat after delete error = %v, want ErrNotFound", err)
	}
}

func TestLocalBlobStoreRejectsTraversalSizeAndChecksumMismatch(t *testing.T) {
	store, err := NewLocalBlobStore(t.TempDir(), 0)
	if err != nil {
		t.Fatal(err)
	}
	for _, key := range []string{"../escape", "/absolute", "aa//bb", "aa/./bb", "aa/..\\bb"} {
		if _, err := store.Put(context.Background(), PutRequest{Key: key, Size: 1, Body: bytes.NewReader([]byte("x"))}); !errors.Is(err, ErrInvalidKey) {
			t.Fatalf("Put(%q) error = %v, want ErrInvalidKey", key, err)
		}
	}
	if _, err := store.Put(context.Background(), PutRequest{Key: "aa/short", Size: 2, Body: bytes.NewReader([]byte("x"))}); !errors.Is(err, ErrSizeMismatch) {
		t.Fatalf("short body error = %v, want ErrSizeMismatch", err)
	}
	if _, err := store.Put(context.Background(), PutRequest{Key: "aa/long", Size: 1, Body: bytes.NewReader([]byte("xx"))}); !errors.Is(err, ErrSizeMismatch) {
		t.Fatalf("long body error = %v, want ErrSizeMismatch", err)
	}
	wrong := sha256.Sum256([]byte("different"))
	if _, err := store.Put(context.Background(), PutRequest{Key: "aa/checksum", Size: 1, ExpectedSHA256: &wrong, Body: bytes.NewReader([]byte("x"))}); !errors.Is(err, ErrChecksumMismatch) {
		t.Fatalf("checksum error = %v, want ErrChecksumMismatch", err)
	}
	entries, err := filepath.Glob(filepath.Join(store.root, "aa", ".upload-*"))
	if err != nil || len(entries) != 0 {
		t.Fatalf("temporary files after failures = %v, err = %v", entries, err)
	}
}

func TestLocalBlobStoreHonorsMinimumFreeSpaceGuard(t *testing.T) {
	store, err := NewLocalBlobStore(t.TempDir(), ^uint64(0))
	if err != nil {
		t.Fatal(err)
	}
	_, err = store.Put(context.Background(), PutRequest{Key: "aa/full", Size: 1, Body: bytes.NewReader([]byte("x"))})
	if !errors.Is(err, ErrStorageFull) {
		t.Fatalf("Put error = %v, want ErrStorageFull", err)
	}
}
