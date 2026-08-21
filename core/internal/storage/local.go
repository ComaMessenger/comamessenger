package storage

import (
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"io"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"time"
)

type LocalBlobStore struct {
	root             string
	minimumFreeBytes uint64
}

func NewLocalBlobStore(root string, minimumFreeBytes uint64) (*LocalBlobStore, error) {
	root = strings.TrimSpace(root)
	if root == "" {
		return nil, fmt.Errorf("local blob root is required")
	}
	absolute, err := filepath.Abs(root)
	if err != nil {
		return nil, fmt.Errorf("resolve local blob root: %w", err)
	}
	if err := os.MkdirAll(absolute, 0o700); err != nil {
		return nil, fmt.Errorf("create local blob root: %w", err)
	}
	if err := os.Chmod(absolute, 0o700); err != nil {
		return nil, fmt.Errorf("secure local blob root: %w", err)
	}
	return &LocalBlobStore{root: absolute, minimumFreeBytes: minimumFreeBytes}, nil
}

func (s *LocalBlobStore) Driver() string { return "local" }

func (s *LocalBlobStore) Capabilities() Capabilities {
	return Capabilities{StreamingUpload: true}
}

func (s *LocalBlobStore) Put(ctx context.Context, request PutRequest) (Blob, error) {
	if request.Size < 0 || request.Body == nil {
		return Blob{}, ErrSizeMismatch
	}
	path, err := s.path(request.Key)
	if err != nil {
		return Blob{}, err
	}
	if err := s.requireFreeSpace(request.Size); err != nil {
		return Blob{}, err
	}
	directory := filepath.Dir(path)
	if err := os.MkdirAll(directory, 0o700); err != nil {
		return Blob{}, fmt.Errorf("create blob shard: %w", err)
	}
	if err := os.Chmod(directory, 0o700); err != nil {
		return Blob{}, fmt.Errorf("secure blob shard: %w", err)
	}
	temporary, err := os.CreateTemp(directory, ".upload-*")
	if err != nil {
		return Blob{}, fmt.Errorf("create temporary blob: %w", err)
	}
	temporaryPath := temporary.Name()
	committed := false
	defer func() {
		_ = temporary.Close()
		if !committed {
			_ = os.Remove(temporaryPath)
		}
	}()
	if err := temporary.Chmod(0o600); err != nil {
		return Blob{}, fmt.Errorf("secure temporary blob: %w", err)
	}
	hash := sha256.New()
	written, err := io.Copy(io.MultiWriter(temporary, hash), io.LimitReader(request.Body, request.Size+1))
	if err != nil {
		return Blob{}, fmt.Errorf("write temporary blob: %w", err)
	}
	if written != request.Size {
		return Blob{}, ErrSizeMismatch
	}
	select {
	case <-ctx.Done():
		return Blob{}, ctx.Err()
	default:
	}
	var checksum [32]byte
	copy(checksum[:], hash.Sum(nil))
	if request.ExpectedSHA256 != nil && checksum != *request.ExpectedSHA256 {
		return Blob{}, ErrChecksumMismatch
	}
	if err := temporary.Sync(); err != nil {
		return Blob{}, fmt.Errorf("sync temporary blob: %w", err)
	}
	if err := temporary.Close(); err != nil {
		return Blob{}, fmt.Errorf("close temporary blob: %w", err)
	}
	if err := os.Rename(temporaryPath, path); err != nil {
		return Blob{}, fmt.Errorf("commit blob: %w", err)
	}
	committed = true
	if err := syncDirectory(directory); err != nil {
		return Blob{}, err
	}
	return Blob{Key: request.Key, Size: written, SHA256: checksum, ContentType: request.ContentType}, nil
}

func (s *LocalBlobStore) Open(_ context.Context, key string) (io.ReadCloser, Blob, error) {
	path, err := s.path(key)
	if err != nil {
		return nil, Blob{}, err
	}
	file, err := os.Open(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil, Blob{}, ErrNotFound
	}
	if err != nil {
		return nil, Blob{}, fmt.Errorf("open blob: %w", err)
	}
	info, err := file.Stat()
	if err != nil {
		_ = file.Close()
		return nil, Blob{}, fmt.Errorf("stat blob: %w", err)
	}
	return file, Blob{Key: key, Size: info.Size()}, nil
}

func (s *LocalBlobStore) Stat(_ context.Context, key string) (Blob, error) {
	path, err := s.path(key)
	if err != nil {
		return Blob{}, err
	}
	info, err := os.Stat(path)
	if errors.Is(err, os.ErrNotExist) {
		return Blob{}, ErrNotFound
	}
	if err != nil {
		return Blob{}, fmt.Errorf("stat blob: %w", err)
	}
	if !info.Mode().IsRegular() {
		return Blob{}, ErrNotFound
	}
	return Blob{Key: key, Size: info.Size()}, nil
}

func (s *LocalBlobStore) Delete(_ context.Context, key string) error {
	path, err := s.path(key)
	if err != nil {
		return err
	}
	if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("delete blob: %w", err)
	}
	return nil
}

func (s *LocalBlobStore) PresignUpload(context.Context, string, string, int64, time.Duration) (*url.URL, error) {
	return nil, ErrUnsupported
}

func (s *LocalBlobStore) PresignDownload(context.Context, string, time.Duration) (*url.URL, error) {
	return nil, ErrUnsupported
}

func (s *LocalBlobStore) path(key string) (string, error) {
	if !validKey(key) {
		return "", ErrInvalidKey
	}
	path := filepath.Join(s.root, filepath.FromSlash(key))
	relative, err := filepath.Rel(s.root, path)
	if err != nil || relative == ".." || strings.HasPrefix(relative, ".."+string(filepath.Separator)) {
		return "", ErrInvalidKey
	}
	return path, nil
}

func (s *LocalBlobStore) requireFreeSpace(incoming int64) error {
	if incoming < 0 {
		return ErrSizeMismatch
	}
	var stats syscall.Statfs_t
	if err := syscall.Statfs(s.root, &stats); err != nil {
		return fmt.Errorf("inspect blob filesystem: %w", err)
	}
	available := uint64(stats.Bavail) * uint64(stats.Bsize)
	if uint64(incoming) > available || available-uint64(incoming) < s.minimumFreeBytes {
		return ErrStorageFull
	}
	return nil
}

func validKey(key string) bool {
	if key == "" || len(key) > 512 || strings.HasPrefix(key, "/") || strings.Contains(key, "\\") {
		return false
	}
	for _, part := range strings.Split(key, "/") {
		if part == "" || part == "." || part == ".." {
			return false
		}
		for _, character := range part {
			if !(character >= 'a' && character <= 'z') && !(character >= '0' && character <= '9') && character != '-' && character != '_' && character != '.' {
				return false
			}
		}
	}
	return true
}

func syncDirectory(path string) error {
	directory, err := os.Open(path)
	if err != nil {
		return fmt.Errorf("open blob directory: %w", err)
	}
	defer directory.Close()
	if err := directory.Sync(); err != nil {
		return fmt.Errorf("sync blob directory: %w", err)
	}
	return nil
}
