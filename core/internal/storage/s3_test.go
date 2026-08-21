package storage

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"
)

func TestS3BlobStoreUsesPublicEndpointOnlyForPresignedURLs(t *testing.T) {
	store, err := NewS3BlobStore(context.Background(), S3Options{
		Endpoint: "http://minio:9000", PublicEndpoint: "https://files.example.test",
		Region: "us-east-1", Bucket: "coma", AccessKey: "access", SecretKey: "secret",
		Prefix: "tenant-a", ForcePathStyle: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	if capabilities := store.Capabilities(); !capabilities.PresignedUpload || !capabilities.MultipartUpload {
		t.Fatalf("unexpected capabilities: %#v", capabilities)
	}
	signed, err := store.PresignUpload(context.Background(), "ab/cd/blob", "text/plain", 42, 5*time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	if signed.Host != "files.example.test" || !strings.Contains(signed.Path, "/coma/tenant-a/ab/cd/blob") {
		t.Fatalf("unexpected presigned URL: %s", signed)
	}
	if signed.Query().Get("X-Amz-Signature") == "" {
		t.Fatalf("presigned URL has no signature: %s", signed)
	}
}

func TestS3BlobStoreRejectsInvalidConfigurationAndKeys(t *testing.T) {
	if _, err := NewS3BlobStore(context.Background(), S3Options{Region: "us-east-1"}); err == nil {
		t.Fatal("NewS3BlobStore() error = nil without bucket")
	}
	store, err := NewS3BlobStore(context.Background(), S3Options{Region: "us-east-1", Bucket: "coma", AccessKey: "access", SecretKey: "secret"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.PresignDownload(context.Background(), "../secret", time.Minute); !errors.Is(err, ErrInvalidKey) {
		t.Fatalf("PresignDownload traversal error = %v, want ErrInvalidKey", err)
	}
}
