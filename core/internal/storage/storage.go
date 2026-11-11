// Package storage implements provider-neutral blob storage contracts.
package storage

import (
	"context"
	"errors"
	"io"
	"net/url"
	"time"
)

var (
	ErrNotFound         = errors.New("blob not found")
	ErrInvalidKey       = errors.New("invalid blob key")
	ErrStorageFull      = errors.New("blob storage is full")
	ErrSizeMismatch     = errors.New("blob size does not match reservation")
	ErrChecksumMismatch = errors.New("blob checksum does not match")
	ErrUnsupported      = errors.New("storage capability is unsupported")
	// ErrBucketMissing means the configured bucket (or local root) does not
	// exist: the store is pointed at the wrong place, not merely empty.
	ErrBucketMissing = errors.New("storage bucket does not exist")
)

type Capabilities struct {
	StreamingUpload bool
	PresignedUpload bool
	MultipartUpload bool
}

type Blob struct {
	Key         string
	Size        int64
	SHA256      [32]byte
	ContentType string
	ModifiedAt  time.Time
}

type BlobLister interface {
	List(context.Context) ([]Blob, error)
}

type PutRequest struct {
	Key            string
	ContentType    string
	Size           int64
	ExpectedSHA256 *[32]byte
	Body           io.Reader
}

type MultipartUpload struct {
	UploadID string
	Key      string
}

type CompletedPart struct {
	Number int32
	ETag   string
}

// BlobStore works only with stable, server-generated object keys. Provider
// URLs and credentials never enter domain data, allowing a deployment to move
// between compatible backends without rewriting file records.
type BlobStore interface {
	Driver() string
	Capabilities() Capabilities
	Put(context.Context, PutRequest) (Blob, error)
	Open(context.Context, string) (io.ReadCloser, Blob, error)
	Stat(context.Context, string) (Blob, error)
	Delete(context.Context, string) error
	PresignUpload(context.Context, string, string, int64, time.Duration) (*url.URL, error)
	PresignDownload(context.Context, string, time.Duration) (*url.URL, error)
}

// ServerCopier copies a stored object to a new key without the bytes
// leaving the store. Every store that hands out presigned upload URLs must
// implement it: a completed upload is copied to a key no client has seen, so
// a still-valid upload URL can no longer replace what readers download.
type ServerCopier interface {
	Copy(ctx context.Context, sourceKey, destinationKey string) (Blob, error)
}

// RangeReader reads length bytes at offset, so a parser can inspect headers
// without loading a whole object.
type RangeReader interface {
	ReadRange(ctx context.Context, key string, offset, length int64) ([]byte, error)
}

// MultipartSweeper removes multipart uploads started before a cutoff whose
// key (relative to the store prefix) the owned callback accepts, so uploads
// of other applications sharing the bucket are left alone.
type MultipartSweeper interface {
	AbortStaleMultipart(ctx context.Context, before time.Time, owned func(key string) bool) (int, error)
}

// BucketChecker reports whether the store's bucket exists and is reachable.
type BucketChecker interface {
	CheckBucket(ctx context.Context) error
}

// MultipartBlobStore is implemented only by providers that can safely expose
// short-lived part URLs. Callers must inspect Capabilities before asserting it.
type MultipartBlobStore interface {
	BlobStore
	BeginMultipart(context.Context, string, string) (MultipartUpload, error)
	PresignPart(context.Context, MultipartUpload, int32, time.Duration) (*url.URL, error)
	CompleteMultipart(context.Context, MultipartUpload, []CompletedPart) (Blob, error)
	AbortMultipart(context.Context, MultipartUpload) error
}
