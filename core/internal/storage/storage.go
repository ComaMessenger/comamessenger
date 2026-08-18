// Package storage defines provider-neutral object storage contracts.
package storage

import (
	"context"
	"net/url"
	"time"
)

// Store works with stable object keys. Provider URLs are never persisted as
// domain data, so an installation can move between compatible S3 providers.
type Store interface {
	PresignUpload(ctx context.Context, key, contentType string, size int64, expiresIn time.Duration) (*url.URL, error)
	PresignDownload(ctx context.Context, key string, expiresIn time.Duration) (*url.URL, error)
	Delete(ctx context.Context, key string) error
}
