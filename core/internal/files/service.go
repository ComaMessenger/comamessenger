package files

import (
	"bufio"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"mime"
	"net/http"
	"path/filepath"
	"sort"
	"strings"
	"time"
	"unicode"

	"github.com/comamessenger/comamessenger/core/internal/id"
	"github.com/comamessenger/comamessenger/core/internal/identity"
	"github.com/comamessenger/comamessenger/core/internal/storage"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

var (
	ErrInvalid     = errors.New("invalid file input")
	ErrForbidden   = errors.New("file access forbidden")
	ErrNotFound    = errors.New("file not found")
	ErrConflict    = errors.New("file upload state conflict")
	ErrStorageFull = errors.New("organization file quota exceeded")
)

type File struct {
	ID               string     `json:"id"`
	Name             string     `json:"name"`
	MIME             string     `json:"mime"`
	Size             int64      `json:"size"`
	SHA256           *string    `json:"sha256,omitempty"`
	Status           string     `json:"status"`
	ProcessingStatus string     `json:"processing_status"`
	PreviewFileID    *string    `json:"preview_file_id,omitempty"`
	CreatedAt        time.Time  `json:"created_at"`
	ReadyAt          *time.Time `json:"ready_at,omitempty"`
	UploaderID       string     `json:"uploader_id"`
	storageKey       string
	storageDriver    string
}

type CreateUploadInput struct {
	Name   string `json:"name"`
	MIME   string `json:"mime"`
	Size   int64  `json:"size"`
	SHA256 string `json:"sha256,omitempty"`
}

type Upload struct {
	ID        string     `json:"id"`
	File      File       `json:"file"`
	Mode      string     `json:"mode"`
	UploadURL *string    `json:"upload_url,omitempty"`
	ExpiresAt time.Time  `json:"expires_at"`
	Parts     []PartLink `json:"parts,omitempty"`
}

type PartLink struct {
	Number int32  `json:"number"`
	URL    string `json:"url"`
}

type CompletedPart struct {
	Number int32  `json:"number"`
	ETag   string `json:"etag"`
	Size   *int64 `json:"size,omitempty"`
}

type Download struct {
	File   File
	Reader io.ReadCloser
	URL    string
}

type Service struct {
	pool               *pgxpool.Pool
	store              storage.BlobStore
	bucket             string
	quotaBytes         int64
	maxFileBytes       int64
	multipartThreshold int64
	uploadTTL          time.Duration
	presignTTL         time.Duration
	processingEnqueue  func(context.Context, pgx.Tx, string) error
	afterCommit        func(string, int64)
}

func (s *Service) SetAfterCommit(callback func(string, int64)) { s.afterCommit = callback }

func NewService(pool *pgxpool.Pool, store storage.BlobStore, bucket string, quotaBytes, maxFileBytes, multipartThreshold uint64, uploadTTL, presignTTL time.Duration) (*Service, error) {
	if pool == nil || store == nil || quotaBytes == 0 || maxFileBytes == 0 || maxFileBytes > quotaBytes {
		return nil, fmt.Errorf("invalid file service configuration")
	}
	return &Service{pool: pool, store: store, bucket: bucket, quotaBytes: int64(quotaBytes), maxFileBytes: int64(maxFileBytes), multipartThreshold: int64(multipartThreshold), uploadTTL: uploadTTL, presignTTL: presignTTL}, nil
}

// SetProcessingEnqueuer wires the durable job queue without coupling the file
// domain service to a specific queue implementation. The callback is invoked
// before the upload transaction commits.
func (s *Service) SetProcessingEnqueuer(enqueue func(context.Context, pgx.Tx, string) error) {
	s.processingEnqueue = enqueue
}

func (s *Service) CreateUpload(ctx context.Context, user identity.User, input CreateUploadInput) (Upload, error) {
	name, declaredMIME, expectedSHA, err := s.validateCreate(input)
	if err != nil {
		return Upload{}, err
	}
	fileID, err := id.New()
	if err != nil {
		return Upload{}, fmt.Errorf("generate file id: %w", err)
	}
	uploadID, err := id.New()
	if err != nil {
		return Upload{}, fmt.Errorf("generate upload id: %w", err)
	}
	compactID := strings.ReplaceAll(fileID, "-", "")
	key := "objects/" + compactID[:2] + "/" + compactID[2:4] + "/" + fileID
	mode := "streaming"
	if s.store.Capabilities().PresignedUpload {
		mode = "presigned"
		if input.Size >= s.multipartThreshold && s.store.Capabilities().MultipartUpload {
			mode = "multipart"
		}
	}
	expiresAt := time.Now().UTC().Add(s.uploadTTL)
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Upload{}, fmt.Errorf("begin upload reservation: %w", err)
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, `INSERT INTO organization_storage_usage (org_id) VALUES ($1) ON CONFLICT DO NOTHING`, user.OrgID); err != nil {
		return Upload{}, fmt.Errorf("ensure storage ledger: %w", err)
	}
	result, err := tx.Exec(ctx, `
		UPDATE organization_storage_usage
		SET reserved_bytes = reserved_bytes + $2, updated_at = now()
		WHERE org_id = $1 AND used_bytes + reserved_bytes + $2 <= COALESCE(quota_bytes, $3)`, user.OrgID, input.Size, s.quotaBytes)
	if err != nil {
		return Upload{}, fmt.Errorf("reserve organization storage: %w", err)
	}
	if result.RowsAffected() != 1 {
		return Upload{}, ErrStorageFull
	}
	var shaBytes []byte
	if expectedSHA != nil {
		shaBytes = expectedSHA[:]
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO files (id, org_id, uploader_id, storage_driver, bucket, storage_key, name, mime, size, sha256)
		VALUES ($1, $2, $3, $4, NULLIF($5, ''), $6, $7, $8, $9, $10)`, fileID, user.OrgID, user.ActorID, s.store.Driver(), s.bucket, key, name, declaredMIME, input.Size, shaBytes); err != nil {
		return Upload{}, fmt.Errorf("insert file metadata: %w", err)
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO file_uploads (id, org_id, file_id, actor_id, mode, expected_size, expected_sha256, reserved_bytes, expires_at)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $6, $8)`, uploadID, user.OrgID, fileID, user.ActorID, mode, input.Size, shaBytes, expiresAt); err != nil {
		return Upload{}, fmt.Errorf("insert upload session: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return Upload{}, fmt.Errorf("commit upload reservation: %w", err)
	}
	file := File{ID: fileID, Name: name, MIME: declaredMIME, Size: input.Size, Status: "pending", ProcessingStatus: "pending", CreatedAt: time.Now().UTC(), UploaderID: user.ActorID, storageKey: key, storageDriver: s.store.Driver()}
	upload := Upload{ID: uploadID, File: file, Mode: mode, ExpiresAt: expiresAt}
	if mode == "streaming" {
		value := "/api/v1/files/uploads/" + uploadID + "/content"
		upload.UploadURL = &value
		return upload, nil
	}
	if mode == "presigned" {
		signed, signErr := s.store.PresignUpload(ctx, key, declaredMIME, input.Size, s.presignTTL)
		if signErr != nil {
			_ = s.AbortUpload(context.Background(), user, uploadID)
			return Upload{}, signErr
		}
		value := signed.String()
		upload.UploadURL = &value
		return upload, nil
	}
	multipart := s.store.(storage.MultipartBlobStore)
	providerUpload, beginErr := multipart.BeginMultipart(ctx, key, declaredMIME)
	if beginErr != nil {
		_ = s.AbortUpload(context.Background(), user, uploadID)
		return Upload{}, beginErr
	}
	if _, err := s.pool.Exec(ctx, `UPDATE file_uploads SET provider_upload_id = $2 WHERE id = $1 AND status = 'active'`, uploadID, providerUpload.UploadID); err != nil {
		_ = multipart.AbortMultipart(context.Background(), providerUpload)
		_ = s.AbortUpload(context.Background(), user, uploadID)
		return Upload{}, fmt.Errorf("save provider upload id: %w", err)
	}
	return upload, nil
}

func (s *Service) SignParts(ctx context.Context, user identity.User, uploadID string, numbers []int32) ([]PartLink, error) {
	if len(numbers) == 0 || len(numbers) > 100 {
		return nil, fmt.Errorf("%w: request between 1 and 100 parts", ErrInvalid)
	}
	sort.Slice(numbers, func(i, j int) bool { return numbers[i] < numbers[j] })
	var key, providerID string
	err := s.pool.QueryRow(ctx, `
		SELECT f.storage_key, u.provider_upload_id
		FROM file_uploads u JOIN files f ON f.id = u.file_id
		WHERE u.id = $1 AND u.org_id = $2 AND u.actor_id = $3 AND u.mode = 'multipart' AND u.status = 'active' AND u.expires_at > now()`, uploadID, user.OrgID, user.ActorID).Scan(&key, &providerID)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("load multipart upload: %w", err)
	}
	multipart := s.store.(storage.MultipartBlobStore)
	links := make([]PartLink, 0, len(numbers))
	for index, number := range numbers {
		if number < 1 || number > 10_000 || (index > 0 && numbers[index-1] == number) {
			return nil, fmt.Errorf("%w: invalid multipart part number", ErrInvalid)
		}
		signed, err := multipart.PresignPart(ctx, storage.MultipartUpload{UploadID: providerID, Key: key}, number, s.presignTTL)
		if err != nil {
			return nil, err
		}
		links = append(links, PartLink{Number: number, URL: signed.String()})
	}
	return links, nil
}

func (s *Service) PutContent(ctx context.Context, user identity.User, uploadID string, body io.Reader) (File, error) {
	claim, err := s.claimUpload(ctx, user, uploadID, "streaming")
	if err != nil {
		return File{}, err
	}
	buffered := bufio.NewReader(body)
	peekSize := int64(512)
	if claim.File.Size < peekSize {
		peekSize = claim.File.Size
	}
	header, peekErr := buffered.Peek(int(peekSize))
	if peekErr != nil && !errors.Is(peekErr, io.EOF) {
		s.failUpload(context.Background(), claim.ID)
		return File{}, fmt.Errorf("inspect upload content: %w", peekErr)
	}
	detected := http.DetectContentType(header)
	if !mimeCompatible(claim.File.MIME, detected, claim.File.Name) {
		s.failUpload(context.Background(), claim.ID)
		return File{}, fmt.Errorf("%w: declared MIME does not match content", ErrInvalid)
	}
	var expected *[32]byte
	if claim.File.SHA256 != nil {
		value, _ := hex.DecodeString(*claim.File.SHA256)
		var checksum [32]byte
		copy(checksum[:], value)
		expected = &checksum
	}
	blob, err := s.store.Put(ctx, storage.PutRequest{Key: claim.File.storageKey, ContentType: claim.File.MIME, Size: claim.File.Size, ExpectedSHA256: expected, Body: buffered})
	if err != nil {
		s.failUpload(context.Background(), claim.ID)
		if errors.Is(err, storage.ErrStorageFull) {
			return File{}, ErrStorageFull
		}
		return File{}, err
	}
	return s.completeClaim(ctx, claim, blob)
}

func (s *Service) CompleteUpload(ctx context.Context, user identity.User, uploadID string, parts []CompletedPart) (File, error) {
	claim, err := s.claimUpload(ctx, user, uploadID, "")
	if err != nil {
		return File{}, err
	}
	if claim.Mode == "streaming" {
		s.failUpload(context.Background(), claim.ID)
		return File{}, ErrConflict
	}
	var blob storage.Blob
	if claim.Mode == "multipart" {
		completed := make([]storage.CompletedPart, len(parts))
		for index, part := range parts {
			completed[index] = storage.CompletedPart{Number: part.Number, ETag: strings.TrimSpace(part.ETag)}
		}
		blob, err = s.store.(storage.MultipartBlobStore).CompleteMultipart(ctx, storage.MultipartUpload{UploadID: claim.ProviderUploadID, Key: claim.File.storageKey}, completed)
	} else {
		blob, err = s.store.Stat(ctx, claim.File.storageKey)
	}
	if err != nil || blob.Size != claim.File.Size {
		_ = s.store.Delete(context.Background(), claim.File.storageKey)
		s.failUpload(context.Background(), claim.ID)
		if err != nil {
			return File{}, err
		}
		return File{}, storage.ErrSizeMismatch
	}
	return s.completeClaim(ctx, claim, blob)
}

func (s *Service) AbortUpload(ctx context.Context, user identity.User, uploadID string) error {
	var key, mode string
	var providerID *string
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("begin abort upload: %w", err)
	}
	defer tx.Rollback(ctx)
	var reserved int64
	err = tx.QueryRow(ctx, `
		UPDATE file_uploads u SET status = 'aborted', aborted_at = now()
		FROM files f
		WHERE u.id = $1 AND u.file_id = f.id AND u.org_id = $2 AND u.actor_id = $3 AND u.status IN ('active', 'uploading')
		RETURNING u.reserved_bytes, f.storage_key, u.mode, u.provider_upload_id`, uploadID, user.OrgID, user.ActorID).Scan(&reserved, &key, &mode, &providerID)
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrNotFound
	}
	if err != nil {
		return fmt.Errorf("abort upload session: %w", err)
	}
	if _, err := tx.Exec(ctx, `UPDATE files SET status = 'failed' WHERE id = (SELECT file_id FROM file_uploads WHERE id = $1)`, uploadID); err != nil {
		return fmt.Errorf("mark aborted file: %w", err)
	}
	if _, err := tx.Exec(ctx, `UPDATE organization_storage_usage SET reserved_bytes = reserved_bytes - $2, updated_at = now() WHERE org_id = $1`, user.OrgID, reserved); err != nil {
		return fmt.Errorf("release aborted reservation: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("commit abort upload: %w", err)
	}
	if mode == "multipart" && providerID != nil {
		return s.store.(storage.MultipartBlobStore).AbortMultipart(ctx, storage.MultipartUpload{UploadID: *providerID, Key: key})
	}
	return s.store.Delete(ctx, key)
}

func (s *Service) Get(ctx context.Context, user identity.User, fileID string) (File, error) {
	return s.getAccessible(ctx, user, fileID)
}

func (s *Service) Download(ctx context.Context, user identity.User, fileID string) (Download, error) {
	file, err := s.getAccessible(ctx, user, fileID)
	if err != nil {
		return Download{}, err
	}
	if file.Status != "ready" {
		return Download{}, ErrConflict
	}
	if s.store.Capabilities().PresignedUpload {
		signed, err := s.store.PresignDownload(ctx, file.storageKey, s.presignTTL)
		if err != nil {
			return Download{}, err
		}
		return Download{File: file, URL: signed.String()}, nil
	}
	reader, _, err := s.store.Open(ctx, file.storageKey)
	if err != nil {
		return Download{}, err
	}
	return Download{File: file, Reader: reader}, nil
}

type uploadClaim struct {
	ID               string
	Mode             string
	ProviderUploadID string
	ReservedBytes    int64
	OrgID            string
	File             File
}

func (s *Service) claimUpload(ctx context.Context, user identity.User, uploadID, requiredMode string) (uploadClaim, error) {
	var claim uploadClaim
	var sha []byte
	err := s.pool.QueryRow(ctx, `
		UPDATE file_uploads u SET status = 'uploading'
		FROM files f
		WHERE u.id = $1 AND u.file_id = f.id AND u.org_id = $2 AND u.actor_id = $3
		  AND u.status = 'active' AND u.expires_at > now() AND ($4 = '' OR u.mode = $4)
		RETURNING u.id, u.mode, COALESCE(u.provider_upload_id, ''), u.reserved_bytes, u.org_id,
		  f.id, f.name, f.mime, f.size, f.sha256, f.status, f.processing_status, f.created_at, f.uploader_id, f.storage_key, f.storage_driver`, uploadID, user.OrgID, user.ActorID, requiredMode).Scan(
		&claim.ID, &claim.Mode, &claim.ProviderUploadID, &claim.ReservedBytes, &claim.OrgID,
		&claim.File.ID, &claim.File.Name, &claim.File.MIME, &claim.File.Size, &sha, &claim.File.Status, &claim.File.ProcessingStatus, &claim.File.CreatedAt, &claim.File.UploaderID, &claim.File.storageKey, &claim.File.storageDriver)
	if errors.Is(err, pgx.ErrNoRows) {
		return uploadClaim{}, ErrNotFound
	}
	if err != nil {
		return uploadClaim{}, fmt.Errorf("claim upload: %w", err)
	}
	if len(sha) == sha256.Size {
		value := hex.EncodeToString(sha)
		claim.File.SHA256 = &value
	}
	return claim, nil
}

func (s *Service) completeClaim(ctx context.Context, claim uploadClaim, blob storage.Blob) (File, error) {
	if blob.Size != claim.File.Size {
		s.failUpload(context.Background(), claim.ID)
		return File{}, storage.ErrSizeMismatch
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return File{}, fmt.Errorf("begin complete upload: %w", err)
	}
	defer tx.Rollback(ctx)
	checksum := blob.SHA256[:]
	if blob.SHA256 == ([32]byte{}) {
		checksum = nil
	}
	var readyAt time.Time
	err = tx.QueryRow(ctx, `
		UPDATE files SET status = 'ready', sha256 = COALESCE($2, sha256), ready_at = now()
		WHERE id = $1 AND status = 'pending' RETURNING ready_at`, claim.File.ID, checksum).Scan(&readyAt)
	if err != nil {
		return File{}, fmt.Errorf("complete file metadata: %w", err)
	}
	if _, err := tx.Exec(ctx, `UPDATE file_uploads SET status = 'completed', completed_at = now() WHERE id = $1 AND status = 'uploading'`, claim.ID); err != nil {
		return File{}, fmt.Errorf("complete upload session: %w", err)
	}
	if _, err := tx.Exec(ctx, `
		UPDATE organization_storage_usage
		SET reserved_bytes = reserved_bytes - $2, used_bytes = used_bytes + $3, updated_at = now()
		WHERE org_id = $1`, claim.OrgID, claim.ReservedBytes, blob.Size); err != nil {
		return File{}, fmt.Errorf("commit storage usage: %w", err)
	}
	if s.processingEnqueue != nil {
		if err := s.processingEnqueue(ctx, tx, claim.File.ID); err != nil {
			return File{}, fmt.Errorf("enqueue file processing: %w", err)
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return File{}, fmt.Errorf("commit completed upload: %w", err)
	}
	claim.File.Status = "ready"
	claim.File.ReadyAt = &readyAt
	if checksum != nil {
		value := hex.EncodeToString(checksum)
		claim.File.SHA256 = &value
	}
	return claim.File, nil
}

func (s *Service) failUpload(ctx context.Context, uploadID string) {
	_, _ = s.pool.Exec(ctx, `
		WITH failed AS (
		  UPDATE file_uploads SET status = 'failed'
		  WHERE id = $1 AND status IN ('active', 'uploading')
		  RETURNING org_id, file_id, reserved_bytes
		), marked AS (
		  UPDATE files SET status = 'failed' WHERE id IN (SELECT file_id FROM failed)
		)
		UPDATE organization_storage_usage u
		SET reserved_bytes = u.reserved_bytes - failed.reserved_bytes, updated_at = now()
		FROM failed WHERE u.org_id = failed.org_id`, uploadID)
}

func (s *Service) getAccessible(ctx context.Context, user identity.User, fileID string) (File, error) {
	var result File
	var sha []byte
	err := s.pool.QueryRow(ctx, `
		SELECT f.id, f.name, f.mime, f.size, f.sha256, f.status, f.processing_status, f.preview_file_id,
		       f.created_at, f.ready_at, f.uploader_id, f.storage_key, f.storage_driver
		FROM files f
		WHERE f.id = $1 AND f.org_id = $2 AND f.status <> 'deleted'
		  AND (f.uploader_id = $3 OR EXISTS (
		    SELECT 1 FROM message_files mf
		    JOIN messages m ON m.id = mf.message_id AND m.deleted_at IS NULL
		    JOIN chat_members cm ON cm.chat_id = m.chat_id AND cm.actor_id = $3
		    WHERE mf.file_id = f.id
		  ) OR EXISTS (
		    SELECT 1 FROM files original
		    JOIN message_files mf ON mf.file_id = original.id
		    JOIN messages m ON m.id = mf.message_id AND m.deleted_at IS NULL
		    JOIN chat_members cm ON cm.chat_id = m.chat_id AND cm.actor_id = $3
		    WHERE original.preview_file_id = f.id AND original.org_id = f.org_id
		  ))`, fileID, user.OrgID, user.ActorID).Scan(&result.ID, &result.Name, &result.MIME, &result.Size, &sha, &result.Status, &result.ProcessingStatus, &result.PreviewFileID, &result.CreatedAt, &result.ReadyAt, &result.UploaderID, &result.storageKey, &result.storageDriver)
	if errors.Is(err, pgx.ErrNoRows) {
		return File{}, ErrNotFound
	}
	if err != nil {
		return File{}, fmt.Errorf("load accessible file: %w", err)
	}
	if len(sha) == sha256.Size {
		value := hex.EncodeToString(sha)
		result.SHA256 = &value
	}
	return result, nil
}

func (s *Service) validateCreate(input CreateUploadInput) (string, string, *[32]byte, error) {
	name := safeName(input.Name)
	if name == "" || len([]byte(name)) > 255 || input.Size < 1 || input.Size > s.maxFileBytes {
		return "", "", nil, fmt.Errorf("%w: invalid name or size", ErrInvalid)
	}
	if forbiddenExtension(name) {
		return "", "", nil, fmt.Errorf("%w: executable file type is forbidden", ErrInvalid)
	}
	declaredMIME, _, err := mime.ParseMediaType(strings.TrimSpace(input.MIME))
	if err != nil || declaredMIME == "" || len(declaredMIME) > 255 {
		return "", "", nil, fmt.Errorf("%w: invalid MIME type", ErrInvalid)
	}
	var expected *[32]byte
	if input.SHA256 != "" {
		decoded, err := hex.DecodeString(input.SHA256)
		if err != nil || len(decoded) != sha256.Size {
			return "", "", nil, fmt.Errorf("%w: sha256 must be 64 hexadecimal characters", ErrInvalid)
		}
		value := [32]byte(decoded)
		expected = &value
	}
	return name, strings.ToLower(declaredMIME), expected, nil
}

func safeName(value string) string {
	value = filepath.Base(strings.ReplaceAll(strings.TrimSpace(value), "\\", "/"))
	value = strings.Map(func(character rune) rune {
		if unicode.IsControl(character) || character == 0 {
			return -1
		}
		return character
	}, value)
	if value == "." || value == ".." {
		return ""
	}
	return strings.TrimSpace(value)
}

func forbiddenExtension(name string) bool {
	extension := strings.ToLower(filepath.Ext(name))
	switch extension {
	case ".exe", ".dll", ".msi", ".bat", ".cmd", ".com", ".scr", ".ps1", ".vbs", ".jar", ".app", ".dmg", ".docm", ".xlsm", ".pptm":
		return true
	default:
		return false
	}
}

func mimeCompatible(declared, detected, name string) bool {
	declared, _, _ = mime.ParseMediaType(declared)
	detected, _, _ = mime.ParseMediaType(detected)
	if declared == detected || detected == "application/octet-stream" {
		return true
	}
	if strings.HasPrefix(declared, "text/") && detected == "text/plain" {
		return true
	}
	extension := strings.ToLower(filepath.Ext(name))
	return detected == "application/zip" && (extension == ".docx" || extension == ".xlsx" || extension == ".pptx")
}
