package storage

import (
	"bytes"
	"context"
	"crypto/sha256"
	"fmt"
	"io"
	"net/http"
	"os"
	"strconv"
	"testing"
	"time"
)

func runBlobStoreContract(t *testing.T, store BlobStore) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	key := fmt.Sprintf("contract/%d/blob.txt", time.Now().UnixNano())
	body := []byte("provider-neutral blob contract")
	checksum := sha256.Sum256(body)
	created, err := store.Put(ctx, PutRequest{Key: key, ContentType: "text/plain", Size: int64(len(body)), ExpectedSHA256: &checksum, Body: bytes.NewReader(body)})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = store.Delete(context.Background(), key) })
	if created.Key != key || created.Size != int64(len(body)) {
		t.Fatalf("created blob = %#v", created)
	}
	metadata, err := store.Stat(ctx, key)
	if err != nil || metadata.Size != int64(len(body)) {
		t.Fatalf("stat blob = %#v, err = %v", metadata, err)
	}
	reader, opened, err := store.Open(ctx, key)
	if err != nil {
		t.Fatal(err)
	}
	got, readErr := io.ReadAll(reader)
	closeErr := reader.Close()
	if readErr != nil || closeErr != nil || !bytes.Equal(got, body) || opened.Size != int64(len(body)) {
		t.Fatalf("open blob = %q, metadata=%#v, errors=%v/%v", got, opened, readErr, closeErr)
	}
	if store.Capabilities().PresignedUpload {
		signed, err := store.PresignDownload(ctx, key, time.Minute)
		if err != nil {
			t.Fatal(err)
		}
		request, err := http.NewRequestWithContext(ctx, http.MethodGet, signed.String(), nil)
		if err != nil {
			t.Fatal(err)
		}
		response, err := http.DefaultClient.Do(request)
		if err != nil {
			t.Fatal(err)
		}
		presignedBody, readErr := io.ReadAll(response.Body)
		response.Body.Close()
		if response.StatusCode != http.StatusOK || readErr != nil || !bytes.Equal(presignedBody, body) {
			t.Fatalf("presigned download status=%d body=%q error=%v", response.StatusCode, presignedBody, readErr)
		}
	}
	if err := store.Delete(ctx, key); err != nil {
		t.Fatal(err)
	}
	if _, err := store.Stat(ctx, key); err == nil {
		t.Fatal("deleted blob is still visible")
	}
}

// TestConfiguredS3BlobStoreContract runs against MinIO or a real provider. CI
// and release environments opt in with TEST_S3_* variables.
func TestConfiguredS3BlobStoreContract(t *testing.T) {
	endpoint := os.Getenv("TEST_S3_ENDPOINT")
	bucket := os.Getenv("TEST_S3_BUCKET")
	if endpoint == "" || bucket == "" {
		t.Skip("TEST_S3_ENDPOINT and TEST_S3_BUCKET are not set")
	}
	forcePathStyle, err := strconv.ParseBool(valueOrDefault(os.Getenv("TEST_S3_FORCE_PATH_STYLE"), "false"))
	if err != nil {
		t.Fatal(err)
	}
	store, err := NewS3BlobStore(t.Context(), S3Options{
		Endpoint:       endpoint,
		PublicEndpoint: os.Getenv("TEST_S3_PUBLIC_ENDPOINT"),
		Region:         valueOrDefault(os.Getenv("TEST_S3_REGION"), "us-east-1"),
		Bucket:         bucket,
		AccessKey:      os.Getenv("TEST_S3_ACCESS_KEY"),
		SecretKey:      os.Getenv("TEST_S3_SECRET_KEY"),
		Prefix:         valueOrDefault(os.Getenv("TEST_S3_PREFIX"), "contract-tests"),
		ForcePathStyle: forcePathStyle,
	})
	if err != nil {
		t.Fatal(err)
	}
	runBlobStoreContract(t, store)
	testMultipartContract(t, store)
}

func testMultipartContract(t *testing.T, store MultipartBlobStore) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	key := fmt.Sprintf("contract/%d/multipart.bin", time.Now().UnixNano())
	body := []byte("multipart contract body")
	upload, err := store.BeginMultipart(ctx, key, "application/octet-stream")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_ = store.AbortMultipart(context.Background(), upload)
		_ = store.Delete(context.Background(), key)
	})
	signed, err := store.PresignPart(ctx, upload, 1, time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPut, signed.String(), bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 || response.Header.Get("ETag") == "" {
		t.Fatalf("multipart part status=%d ETag=%q", response.StatusCode, response.Header.Get("ETag"))
	}
	completed, err := store.CompleteMultipart(ctx, upload, []CompletedPart{{Number: 1, ETag: response.Header.Get("ETag")}})
	if err != nil || completed.Size != int64(len(body)) {
		t.Fatalf("complete multipart = %#v, err=%v", completed, err)
	}

	abandoned, err := store.BeginMultipart(ctx, key+".abandoned", "application/octet-stream")
	if err != nil {
		t.Fatal(err)
	}
	if err := store.AbortMultipart(ctx, abandoned); err != nil {
		t.Fatal(err)
	}
}

func valueOrDefault(value, fallback string) string {
	if value == "" {
		return fallback
	}
	return value
}
