package storage

import (
	"bytes"
	"context"

	"crypto/sha256"
	"errors"
	"fmt"
	"github.com/aws/aws-sdk-go-v2/aws"
	awshttp "github.com/aws/aws-sdk-go-v2/aws/transport/http"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"io"
	"net/http"
	"os"
	"strconv"
	"strings"
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
	testCopyAndRangeContract(t, store, key, body)
	if err := store.Delete(ctx, key); err != nil {
		t.Fatal(err)
	}
	if _, err := store.Stat(ctx, key); err == nil {
		t.Fatal("deleted blob is still visible")
	}
}

// testCopyAndRangeContract checks the server-side copy a completed upload is
// sealed with: a later write to the source, here through the presigned
// upload URL a client still holds, never reaches the copy.
func testCopyAndRangeContract(t *testing.T, store BlobStore, key string, body []byte) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	ranges, ok := store.(RangeReader)
	if !ok {
		t.Fatal("store does not read ranges")
	}
	part, err := ranges.ReadRange(ctx, key, 9, 7)
	if err != nil || string(part) != string(body[9:16]) {
		t.Fatalf("ReadRange = %q, err = %v", part, err)
	}
	if _, err := ranges.ReadRange(ctx, key, int64(len(body))-2, 5); err == nil {
		t.Fatal("ReadRange past the end succeeded")
	}
	copier, ok := store.(ServerCopier)
	if !ok {
		t.Fatal("store does not copy")
	}
	sealedKey := key + "-sealed"
	copied, err := copier.Copy(ctx, key, sealedKey)
	if err != nil || copied.Size != int64(len(body)) {
		t.Fatalf("Copy = %#v, err = %v", copied, err)
	}
	t.Cleanup(func() { _ = store.Delete(context.Background(), sealedKey) })
	if _, err := copier.Copy(ctx, key+"-missing", key+"-nowhere"); err == nil {
		t.Fatal("Copy of a missing blob succeeded")
	}
	if store.Capabilities().PresignedUpload {
		replacement := bytes.Repeat([]byte("X"), len(body))
		signed, err := store.PresignUpload(ctx, key, "text/plain", int64(len(replacement)), time.Minute)
		if err != nil {
			t.Fatal(err)
		}
		request, err := http.NewRequestWithContext(ctx, http.MethodPut, signed.String(), bytes.NewReader(replacement))
		if err != nil {
			t.Fatal(err)
		}
		request.Header.Set("Content-Type", "text/plain")
		response, err := http.DefaultClient.Do(request)
		if err != nil {
			t.Fatal(err)
		}
		response.Body.Close()
		if response.StatusCode != http.StatusOK {
			t.Fatalf("presigned overwrite status = %d", response.StatusCode)
		}
	}
	reader, _, err := store.Open(ctx, sealedKey)
	if err != nil {
		t.Fatal(err)
	}
	sealed, err := io.ReadAll(reader)
	reader.Close()
	if err != nil || !bytes.Equal(sealed, body) {
		t.Fatalf("sealed copy = %q, err = %v, want the original bytes", sealed, err)
	}
}

// TestConfiguredS3BlobStoreContract runs against MinIO or a real provider. CI
// and release environments opt in with TEST_S3_* variables.
func TestConfiguredS3BlobStoreContract(t *testing.T) {
	store := configuredS3Store(t, valueOrDefault(os.Getenv("TEST_S3_PREFIX"), "contract-tests"))
	runBlobStoreContract(t, store)
	testMultipartContract(t, store)
}

// configuredS3Store connects to the S3 server named by TEST_S3_*. CI sets
// TEST_S3_REQUIRED so a missing server fails the job instead of skipping.
func configuredS3Store(t *testing.T, prefix string) *S3BlobStore {
	t.Helper()
	endpoint := os.Getenv("TEST_S3_ENDPOINT")
	bucket := os.Getenv("TEST_S3_BUCKET")
	if endpoint == "" || bucket == "" {
		if os.Getenv("TEST_S3_REQUIRED") != "" {
			t.Fatal("TEST_S3_REQUIRED is set but TEST_S3_ENDPOINT or TEST_S3_BUCKET is not")
		}
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
		Prefix:         prefix,
		ForcePathStyle: forcePathStyle,
	})
	if err != nil {
		t.Fatal(err)
	}
	return store
}

// The sealing copy is pinned to the source ETag: the server must refuse a
// copy whose source changed, for one CopyObject and for a part-wise copy.
func TestConfiguredS3CopyHonorsSourceETag(t *testing.T) {
	store := configuredS3Store(t, fmt.Sprintf("copy-tests-%d", time.Now().UnixNano()))
	ctx := t.Context()
	put := func(key string, body []byte) {
		t.Helper()
		if _, err := store.Put(ctx, PutRequest{Key: key, ContentType: "audio/mp4", Size: int64(len(body)), Body: bytes.NewReader(body)}); err != nil {
			t.Fatal(err)
		}
	}
	put("source", []byte("original"))
	objectKey, _ := store.objectKey("source")
	destination, _ := store.objectKey("forged")
	staleETag := aws.String(`"0123456789abcdef0123456789abcdef"`)
	_, err := store.client.CopyObject(ctx, &s3.CopyObjectInput{
		Bucket: aws.String(store.bucket), Key: aws.String(destination),
		CopySource: aws.String(store.bucket + "/" + objectKey), CopySourceIfMatch: staleETag,
	})
	if status := httpStatus(err); status != http.StatusPreconditionFailed {
		t.Fatalf("CopyObject with a stale source ETag: status %d, err %v; want 412", status, err)
	}
	upload, err := store.client.CreateMultipartUpload(ctx, &s3.CreateMultipartUploadInput{Bucket: aws.String(store.bucket), Key: aws.String(destination)})
	if err != nil {
		t.Fatal(err)
	}
	_, err = store.client.UploadPartCopy(ctx, &s3.UploadPartCopyInput{
		Bucket: aws.String(store.bucket), Key: aws.String(destination), UploadId: upload.UploadId, PartNumber: aws.Int32(1),
		CopySource: aws.String(store.bucket + "/" + objectKey), CopySourceIfMatch: staleETag,
	})
	_, _ = store.client.AbortMultipartUpload(context.Background(), &s3.AbortMultipartUploadInput{Bucket: aws.String(store.bucket), Key: aws.String(destination), UploadId: upload.UploadId})
	if status := httpStatus(err); status != http.StatusPreconditionFailed {
		t.Fatalf("UploadPartCopy with a stale source ETag: status %d, err %v; want 412", status, err)
	}

	previousSingle, previousPart := maxSingleCopyBytes, copyPartBytes
	maxSingleCopyBytes, copyPartBytes = 1, 5<<20
	t.Cleanup(func() { maxSingleCopyBytes, copyPartBytes = previousSingle, previousPart })
	large := bytes.Repeat([]byte("0123456789abcdef"), (6<<20)/16)
	put("large", large)
	copied, err := store.Copy(ctx, "large", "large-sealed")
	if err != nil || copied.Size != int64(len(large)) {
		t.Fatalf("part-wise Copy = %#v, err = %v", copied, err)
	}
	reader, _, err := store.Open(ctx, "large-sealed")
	if err != nil {
		t.Fatal(err)
	}
	got, err := io.ReadAll(reader)
	reader.Close()
	if err != nil || !bytes.Equal(got, large) {
		t.Fatalf("part-wise copy differs: %d bytes, err = %v", len(got), err)
	}
	for _, key := range []string{"source", "forged", "large", "large-sealed"} {
		_ = store.Delete(context.Background(), key)
	}
}

func httpStatus(err error) int {
	var response *awshttp.ResponseError
	if errors.As(err, &response) {
		return response.HTTPStatusCode()
	}
	return 0
}

// The bucket check tells a missing bucket from a reachable one.
func TestConfiguredS3CheckBucket(t *testing.T) {
	store := configuredS3Store(t, "bucket-check")
	if err := store.CheckBucket(t.Context()); err != nil {
		t.Fatalf("CheckBucket on the configured bucket: %v", err)
	}
	missing := *store
	missing.bucket = fmt.Sprintf("coma-missing-%d", time.Now().UnixNano())
	if err := missing.CheckBucket(t.Context()); !errors.Is(err, ErrBucketMissing) {
		t.Fatalf("CheckBucket on a missing bucket = %v, want ErrBucketMissing", err)
	}
	local, err := NewLocalBlobStore(t.TempDir(), 0)
	if err != nil {
		t.Fatal(err)
	}
	if err := local.CheckBucket(t.Context()); err != nil {
		t.Fatalf("local CheckBucket: %v", err)
	}
	gone := &LocalBlobStore{root: local.root + "-gone"}
	if err := gone.CheckBucket(t.Context()); !errors.Is(err, ErrBucketMissing) {
		t.Fatalf("local CheckBucket on a missing root = %v", err)
	}
}

// Multipart uploads nobody completed, such as an interrupted part-wise
// copy, are aborted by the sweep once older than the cutoff, and only when
// the key belongs to Core: other applications may share the bucket.
func TestConfiguredS3SweepsStaleMultipartUploads(t *testing.T) {
	store := configuredS3Store(t, fmt.Sprintf("sweep-tests-%d", time.Now().UnixNano()))
	ctx := t.Context()
	owned := func(key string) bool { return strings.HasPrefix(key, "core/") }
	if _, err := store.BeginMultipart(ctx, "core/interrupted", "application/octet-stream"); err != nil {
		t.Fatal(err)
	}
	foreign, err := store.BeginMultipart(ctx, "other-app/upload", "application/octet-stream")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = store.AbortMultipart(context.Background(), foreign) })
	if aborted, err := store.AbortStaleMultipart(ctx, time.Now().Add(-time.Hour), owned); err != nil || aborted != 0 {
		t.Fatalf("sweep of a fresh upload aborted %d, err = %v", aborted, err)
	}
	if aborted, err := store.AbortStaleMultipart(ctx, time.Now().Add(time.Minute), owned); err != nil || aborted != 1 {
		t.Fatalf("sweep aborted %d, err = %v, want 1 (the foreign upload stays)", aborted, err)
	}
	if aborted, err := store.AbortStaleMultipart(ctx, time.Now().Add(time.Minute), owned); err != nil || aborted != 0 {
		t.Fatalf("second sweep aborted %d, err = %v, want 0", aborted, err)
	}
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
