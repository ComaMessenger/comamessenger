package files

import (
	"bufio"
	"context"
	"crypto/rand"
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
	"sync"
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
	// ErrUnavailable is a temporary failure; the upload stays open and the
	// client may complete it again.
	ErrUnavailable = errors.New("file storage is temporarily unavailable")
	// ErrBusy means every voice check slot stayed taken; retry later.
	ErrBusy = errors.New("voice checks are busy")
	// ErrTooManyChecks means the actor already has a voice check running.
	ErrTooManyChecks = errors.New("a voice check of this actor is already running")
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
	Voice            *Voice     `json:"voice,omitempty"`
	storageKey       string
	storageDriver    string
}

type CreateUploadInput struct {
	Name   string `json:"name"`
	MIME   string `json:"mime"`
	Size   int64  `json:"size"`
	SHA256 string `json:"sha256,omitempty"`
	Voice  *Voice `json:"voice,omitempty"`
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

type TextContent struct {
	FileID    string `json:"file_id"`
	Text      string `json:"text"`
	Truncated bool   `json:"truncated"`
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
	processorHooks     []ProcessorHook
	afterCommit        func(string, int64)
	// voiceChecks bounds how many voice uploads are parsed at once,
	// voiceActors holds actors with a check running, voiceSlotWait bounds
	// the wait for a slot.
	voiceChecks   chan struct{}
	voiceActors   sync.Map
	voiceSlotWait time.Duration
	// orphanGrace is how old an unreferenced object must be before
	// reconciliation deletes it.
	orphanGrace time.Duration
}

// maxUploadURLTTL caps the URL of a single presigned PUT, the one URL that
// could rewrite an object after completion. A single PUT carries at most the
// multipart threshold (16 MiB by default: about 2 min at 1 Mbit/s, 4.5 min at
// 0.5 Mbit/s). Part URLs and downloads keep FILE_PRESIGN_TTL.
const maxUploadURLTTL = 5 * time.Minute

func (s *Service) uploadPresignTTL() time.Duration { return min(s.presignTTL, maxUploadURLTTL) }

// uploadURLLifetime bounds how long some URL of an upload may still write
// after it stopped being active: a part URL signed at the last moment lives
// FILE_PRESIGN_TTL. uploadTTL is added as a margin.
func (s *Service) uploadURLLifetime() time.Duration { return s.uploadTTL + s.presignTTL }

func (s *Service) SetAfterCommit(callback func(string, int64)) { s.afterCommit = callback }

func NewService(pool *pgxpool.Pool, store storage.BlobStore, bucket string, quotaBytes, maxFileBytes, multipartThreshold uint64, uploadTTL, presignTTL time.Duration) (*Service, error) {
	if pool == nil || store == nil || quotaBytes == 0 || maxFileBytes == 0 || maxFileBytes > quotaBytes {
		return nil, fmt.Errorf("invalid file service configuration")
	}
	if store.Capabilities().PresignedUpload {
		if _, ok := store.(storage.ServerCopier); !ok {
			return nil, fmt.Errorf("invalid file service configuration: a presigned store must copy objects server-side")
		}
	}
	if _, ok := store.(storage.RangeReader); !ok {
		return nil, fmt.Errorf("invalid file service configuration: the store must read byte ranges to check voice recordings")
	}
	return &Service{pool: pool, store: store, bucket: bucket, quotaBytes: int64(quotaBytes), maxFileBytes: int64(maxFileBytes), multipartThreshold: int64(multipartThreshold), uploadTTL: uploadTTL, presignTTL: presignTTL, voiceChecks: make(chan struct{}, maxConcurrentVoiceChecks), voiceSlotWait: voiceSlotWait, orphanGrace: time.Hour}, nil
}

// SetProcessingEnqueuer wires the durable job queue without coupling the file
// domain service to a specific queue implementation. The callback is invoked
// before the upload transaction commits.
func (s *Service) SetProcessingEnqueuer(enqueue func(context.Context, pgx.Tx, string) error) {
	s.processingEnqueue = enqueue
}

// SetProcessorHooks installs optional scanners that run before built-in
// preview and extraction. It is the integration point for deployments that
// enable ClamAV or another content policy service.
func (s *Service) SetProcessorHooks(hooks ...ProcessorHook) {
	s.processorHooks = append([]ProcessorHook(nil), hooks...)
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
		// A voice recording always goes up in one request, whatever the
		// configured threshold, so it is checked as a single object.
		if input.Voice == nil && input.Size >= s.multipartThreshold && s.store.Capabilities().MultipartUpload {
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
	var voiceDuration *int32
	var voiceWaveform []byte
	if input.Voice != nil {
		value := int32(input.Voice.DurationMs)
		voiceDuration = &value
		voiceWaveform = input.Voice.waveformBytes()
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO files (id, org_id, uploader_id, storage_driver, bucket, storage_key, name, mime, size, sha256, voice_duration_ms, voice_waveform)
		VALUES ($1, $2, $3, $4, NULLIF($5, ''), $6, $7, $8, $9, $10, $11, $12)`, fileID, user.OrgID, user.ActorID, s.store.Driver(), s.bucket, key, name, declaredMIME, input.Size, shaBytes, voiceDuration, voiceWaveform); err != nil {
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
	file := File{ID: fileID, Name: name, MIME: declaredMIME, Size: input.Size, Status: "pending", ProcessingStatus: "pending", CreatedAt: time.Now().UTC(), UploaderID: user.ActorID, Voice: voiceFromColumns(voiceDuration, voiceWaveform), storageKey: key, storageDriver: s.store.Driver()}
	upload := Upload{ID: uploadID, File: file, Mode: mode, ExpiresAt: expiresAt}
	if mode == "streaming" {
		value := "/api/v1/files/uploads/" + uploadID + "/content"
		upload.UploadURL = &value
		return upload, nil
	}
	if mode == "presigned" {
		signed, signErr := s.store.PresignUpload(ctx, key, declaredMIME, input.Size, s.uploadPresignTTL())
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
		// A part URL keeps FILE_PRESIGN_TTL: clients sign many parts at once
		// and upload them one by one, and once the upload is completed a
		// part URL can no longer write anything.
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
	// The body may take longer than the lease to arrive; keep the lease while
	// it is read so another PUT cannot take the upload over and write the
	// same key.
	stopHolding := s.holdClaim(claim.ID)
	defer stopHolding()
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
	work, cancel := s.detached(ctx, claim.File.Size)
	defer cancel()
	return s.finishUpload(work, claim, blob, "")
}

// CompleteUpload finishes a presigned or multipart upload. It is safe to
// repeat: a completed upload returns its file again, and a temporary failure
// (ErrUnavailable, ErrBusy, ErrTooManyChecks) leaves the upload open with the
// client's object in place. Only content that fails validation is discarded.
func (s *Service) CompleteUpload(ctx context.Context, user identity.User, uploadID string, parts []CompletedPart) (File, error) {
	claim, err := s.claimUpload(ctx, user, uploadID, "")
	if errors.Is(err, ErrNotFound) {
		return s.completedUpload(ctx, user, uploadID)
	}
	if err != nil {
		return File{}, err
	}
	if claim.Mode == "streaming" {
		s.releaseClaim(claim.ID)
		return File{}, ErrConflict
	}
	// From here the work finishes even if the client disconnects or a proxy
	// times out: a half-done completion is what destroys uploads.
	work, cancel := s.detached(ctx, claim.File.Size)
	defer cancel()
	uploadKey := claim.File.storageKey
	_, err = s.uploadedObject(work, claim, parts)
	switch {
	case errors.Is(err, storage.ErrSizeMismatch):
		_ = s.store.Delete(context.Background(), uploadKey)
		s.failUpload(context.Background(), claim.ID)
		return File{}, err
	case errors.Is(err, storage.ErrNotFound):
		s.releaseClaim(claim.ID)
		return File{}, fmt.Errorf("%w: the uploaded object is missing", ErrConflict)
	case err != nil:
		s.releaseClaim(claim.ID)
		return File{}, fmt.Errorf("%w: %v", ErrUnavailable, err)
	}
	sealed, err := s.sealUpload(work, &claim)
	if err != nil {
		s.releaseClaim(claim.ID)
		return File{}, fmt.Errorf("%w: %v", ErrUnavailable, err)
	}
	return s.finishUpload(work, claim, sealed, uploadKey)
}

// uploadedObject returns the client's object, completing a multipart upload
// unless an earlier attempt already did.
func (s *Service) uploadedObject(ctx context.Context, claim uploadClaim, parts []CompletedPart) (storage.Blob, error) {
	blob, err := s.store.Stat(ctx, claim.File.storageKey)
	if claim.Mode == "multipart" && (errors.Is(err, storage.ErrNotFound) || (err == nil && blob.Size != claim.File.Size)) {
		completed := make([]storage.CompletedPart, len(parts))
		for index, part := range parts {
			completed[index] = storage.CompletedPart{Number: part.Number, ETag: strings.TrimSpace(part.ETag)}
		}
		blob, err = s.store.(storage.MultipartBlobStore).CompleteMultipart(ctx, storage.MultipartUpload{UploadID: claim.ProviderUploadID, Key: claim.File.storageKey}, completed)
	}
	if err != nil {
		return storage.Blob{}, err
	}
	if blob.Size != claim.File.Size {
		return storage.Blob{}, storage.ErrSizeMismatch
	}
	return blob, nil
}

// finishUpload checks a voice recording and commits the file. Rejected
// content is deleted and the upload failed; any other error releases the
// upload for another attempt and drops only the sealed copy. uploadKey is
// the client-writable key of a sealed upload, removed once committed.
func (s *Service) finishUpload(ctx context.Context, claim uploadClaim, blob storage.Blob, uploadKey string) (File, error) {
	file, err := s.verifyAndCommit(ctx, claim, blob)
	if err == nil {
		if uploadKey != "" {
			_ = s.store.Delete(context.Background(), uploadKey)
		}
		return file, nil
	}
	if errors.Is(err, ErrInvalid) || errors.Is(err, storage.ErrSizeMismatch) {
		_ = s.store.Delete(context.Background(), claim.File.storageKey)
		if uploadKey != "" {
			_ = s.store.Delete(context.Background(), uploadKey)
		}
		s.failUpload(context.Background(), claim.ID)
		return File{}, err
	}
	// Any other error may come from a COMMIT whose answer was lost: the row
	// may already point at the sealed copy, so it is kept. If the commit did
	// not happen, reconciliation removes the copy as an orphan.
	s.releaseClaim(claim.ID)
	return File{}, err
}

// completedUpload answers a repeated complete of an upload that finished.
func (s *Service) completedUpload(ctx context.Context, user identity.User, uploadID string) (File, error) {
	var fileID, status string
	err := s.pool.QueryRow(ctx, `SELECT file_id, status FROM file_uploads WHERE id = $1 AND org_id = $2 AND actor_id = $3`, uploadID, user.OrgID, user.ActorID).Scan(&fileID, &status)
	if errors.Is(err, pgx.ErrNoRows) {
		return File{}, ErrNotFound
	}
	if err != nil {
		return File{}, fmt.Errorf("load upload session: %w", err)
	}
	switch status {
	case "completed":
		return s.getAccessible(ctx, user, fileID)
	case "uploading":
		// Another request is completing it; its lease bounds the wait.
		return File{}, fmt.Errorf("%w: the upload is being completed", ErrUnavailable)
	default:
		return File{}, ErrNotFound
	}
}

// releaseClaim reopens an upload whose completion failed for a temporary
// reason, so the client can retry before it expires.
func (s *Service) releaseClaim(uploadID string) {
	_, _ = s.pool.Exec(context.Background(), `UPDATE file_uploads SET status = 'active', claim_expires_at = NULL WHERE id = $1 AND status = 'uploading'`, uploadID)
}

// Completion timing. Work runs for at most completionTimeout(size): 30 s
// plus a second per 20 MiB of copying (35 s for the default 100 MiB
// FILE_MAX_BYTES). Its claim is a lease of claimLeaseMargin longer; once the
// lease lapses (the process died) another request may take the upload over.
const (
	completionBase        = 30 * time.Second
	completionBytesPerSec = 20 << 20
	claimLeaseMargin      = 30 * time.Second
)

func completionTimeout(size int64) time.Duration {
	return completionBase + time.Duration(size/completionBytesPerSec)*time.Second
}

// MaxCompletionTimeout is the longest an upload completion may run; server
// shutdown waits at least this long for requests in flight.
func (s *Service) MaxCompletionTimeout() time.Duration { return completionTimeout(s.maxFileBytes) }

// CompletionTimeout is the completion time limit for an object of size bytes.
func CompletionTimeout(size int64) time.Duration { return completionTimeout(size) }

// claimHeartbeat is how often a held claim's lease is renewed; it is well
// below the shortest lease (completionBase + claimLeaseMargin).
var claimHeartbeat = 15 * time.Second

// holdClaim renews the lease of a claimed upload until stop is called.
func (s *Service) holdClaim(uploadID string) (stop func()) {
	done := make(chan struct{})
	finished := make(chan struct{})
	go func() {
		defer close(finished)
		ticker := time.NewTicker(claimHeartbeat)
		defer ticker.Stop()
		for {
			select {
			case <-done:
				return
			case <-ticker.C:
				_, _ = s.pool.Exec(context.Background(), `
					UPDATE file_uploads u SET claim_expires_at = now() + make_interval(secs => $2 + f.size / $3)
					FROM files f WHERE u.id = $1 AND u.file_id = f.id AND u.status = 'uploading'`,
					uploadID, (completionBase + claimLeaseMargin).Seconds(), completionBytesPerSec)
			}
		}
	}()
	return func() {
		close(done)
		<-finished
	}
}

// detached runs completion work without the request's cancellation.
func (s *Service) detached(ctx context.Context, size int64) (context.Context, context.CancelFunc) {
	return context.WithTimeout(context.WithoutCancel(ctx), completionTimeout(size))
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
		WHERE u.id = $1 AND u.file_id = f.id AND u.org_id = $2 AND u.actor_id = $3
		  AND (u.status = 'active' OR (u.status = 'uploading' AND (u.claim_expires_at IS NULL OR u.claim_expires_at < now())))
		RETURNING u.reserved_bytes, f.storage_key, u.mode, u.provider_upload_id`, uploadID, user.OrgID, user.ActorID).Scan(&reserved, &key, &mode, &providerID)
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrNotFound
	}
	if err != nil {
		return fmt.Errorf("abort upload session: %w", err)
	}
	if _, err := tx.Exec(ctx, `UPDATE files SET status = 'failed', failed_at = now() WHERE id = (SELECT file_id FROM file_uploads WHERE id = $1) AND ready_at IS NULL`, uploadID); err != nil {
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

func (s *Service) GetText(ctx context.Context, user identity.User, fileID string, maxChars int) (TextContent, error) {
	if maxChars == 0 {
		maxChars = 20000
	}
	if maxChars < 1 || maxChars > 100000 {
		return TextContent{}, fmt.Errorf("%w: max_chars must be between 1 and 100000", ErrInvalid)
	}
	file, err := s.getAccessible(ctx, user, fileID)
	if err != nil {
		return TextContent{}, err
	}
	if file.ProcessingStatus != "ready" {
		return TextContent{}, ErrConflict
	}
	var text *string
	if err := s.pool.QueryRow(ctx, `SELECT extracted_text FROM files WHERE org_id=$1 AND id=$2`, user.OrgID, fileID).Scan(&text); err != nil {
		return TextContent{}, fmt.Errorf("load file text: %w", err)
	}
	if text == nil {
		return TextContent{}, ErrConflict
	}
	runes := []rune(*text)
	result := TextContent{FileID: fileID, Text: *text}
	if len(runes) > maxChars {
		result.Text = string(runes[:maxChars])
		result.Truncated = true
	}
	return result, nil
}

func (s *Service) Download(ctx context.Context, user identity.User, fileID string) (Download, error) {
	file, err := s.getAccessible(ctx, user, fileID)
	if err != nil {
		return Download{}, err
	}
	return s.deliver(ctx, file)
}

// DownloadAuthorized delivers a file of the organization without the
// uploader/chat check. The caller must already have decided that the actor
// may read the file through another resource, such as a knowledge collection.
func (s *Service) DownloadAuthorized(ctx context.Context, orgID, fileID string) (Download, error) {
	var file File
	err := s.pool.QueryRow(ctx, `
		SELECT f.id, f.name, f.mime, f.size, f.status, f.processing_status, f.preview_file_id,
		       f.created_at, f.ready_at, f.uploader_id, f.storage_key, f.storage_driver
		FROM files f WHERE f.id = $1 AND f.org_id = $2 AND f.status <> 'deleted'`, fileID, orgID).Scan(
		&file.ID, &file.Name, &file.MIME, &file.Size, &file.Status, &file.ProcessingStatus, &file.PreviewFileID,
		&file.CreatedAt, &file.ReadyAt, &file.UploaderID, &file.storageKey, &file.storageDriver)
	if errors.Is(err, pgx.ErrNoRows) {
		return Download{}, ErrNotFound
	}
	if err != nil {
		return Download{}, fmt.Errorf("load authorized file: %w", err)
	}
	return s.deliver(ctx, file)
}

func (s *Service) deliver(ctx context.Context, file File) (Download, error) {
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
	var sha, waveform []byte
	var voiceDuration *int32
	err := s.pool.QueryRow(ctx, `
		UPDATE file_uploads u SET status = 'uploading',
		  claim_expires_at = now() + make_interval(secs => $5 + f.size / $6)
		FROM files f
		WHERE u.id = $1 AND u.file_id = f.id AND u.org_id = $2 AND u.actor_id = $3
		  AND (u.status = 'active' OR (u.status = 'uploading' AND (u.claim_expires_at IS NULL OR u.claim_expires_at < now())))
		  AND u.expires_at > now() AND ($4 = '' OR u.mode = $4)
		RETURNING u.id, u.mode, COALESCE(u.provider_upload_id, ''), u.reserved_bytes, u.org_id,
		  f.id, f.name, f.mime, f.size, f.sha256, f.status, f.processing_status, f.created_at, f.uploader_id, f.storage_key, f.storage_driver,
		  f.voice_duration_ms, f.voice_waveform`, uploadID, user.OrgID, user.ActorID, requiredMode,
		(completionBase+claimLeaseMargin).Seconds(), completionBytesPerSec).Scan(
		&claim.ID, &claim.Mode, &claim.ProviderUploadID, &claim.ReservedBytes, &claim.OrgID,
		&claim.File.ID, &claim.File.Name, &claim.File.MIME, &claim.File.Size, &sha, &claim.File.Status, &claim.File.ProcessingStatus, &claim.File.CreatedAt, &claim.File.UploaderID, &claim.File.storageKey, &claim.File.storageDriver,
		&voiceDuration, &waveform)
	if errors.Is(err, pgx.ErrNoRows) {
		return uploadClaim{}, ErrNotFound
	}
	if err != nil {
		return uploadClaim{}, fmt.Errorf("claim upload: %w", err)
	}
	claim.File.Voice = voiceFromColumns(voiceDuration, waveform)
	if len(sha) == sha256.Size {
		value := hex.EncodeToString(sha)
		claim.File.SHA256 = &value
	}
	return claim, nil
}

func (s *Service) verifyAndCommit(ctx context.Context, claim uploadClaim, blob storage.Blob) (File, error) {
	if blob.Size != claim.File.Size {
		return File{}, storage.ErrSizeMismatch
	}
	if claim.File.Voice != nil {
		duration, err := s.verifyVoice(ctx, claim)
		if err != nil {
			return File{}, err
		}
		claim.File.Voice.DurationMs = duration
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
		UPDATE files SET status = 'ready', sha256 = COALESCE($2, sha256), ready_at = now(),
		  voice_duration_ms = CASE WHEN voice_duration_ms IS NULL THEN NULL ELSE $3::integer END,
		  storage_key = $4
		WHERE id = $1 AND status = 'pending' RETURNING ready_at`, claim.File.ID, checksum, voiceDurationArg(claim.File.Voice), claim.File.storageKey).Scan(&readyAt)
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
		  UPDATE files SET status = 'failed', failed_at = now() WHERE id IN (SELECT file_id FROM failed) AND ready_at IS NULL
		)
		UPDATE organization_storage_usage u
		SET reserved_bytes = u.reserved_bytes - failed.reserved_bytes, updated_at = now()
		FROM failed WHERE u.org_id = failed.org_id`, uploadID)
}

// getAccessible returns a file its uploader or a member of a chat it was
// shared in may read. An agent does not read files through chats it only
// writes to.
func (s *Service) getAccessible(ctx context.Context, user identity.User, fileID string) (File, error) {
	var result File
	var sha, waveform []byte
	var voiceDuration *int32
	err := s.pool.QueryRow(ctx, `
		SELECT f.id, f.name, f.mime, f.size, f.sha256, f.status, f.processing_status, f.preview_file_id,
		       f.created_at, f.ready_at, f.uploader_id, f.storage_key, f.storage_driver, f.voice_duration_ms, f.voice_waveform
		FROM files f
		WHERE f.id = $1 AND f.org_id = $2 AND f.status <> 'deleted'
		  AND (f.uploader_id = $3 OR EXISTS (
		    SELECT 1 FROM message_files mf
		    JOIN messages m ON m.id = mf.message_id AND m.deleted_at IS NULL
		    JOIN chat_members cm ON cm.chat_id = m.chat_id AND cm.actor_id = $3
		    WHERE mf.file_id = f.id AND NOT EXISTS (
		      SELECT 1 FROM agents ag WHERE ag.actor_id = $3 AND m.chat_id = ANY(ag.write_only_chat_ids))
		  ) OR EXISTS (
		    SELECT 1 FROM files original
		    JOIN message_files mf ON mf.file_id = original.id
		    JOIN messages m ON m.id = mf.message_id AND m.deleted_at IS NULL
		    JOIN chat_members cm ON cm.chat_id = m.chat_id AND cm.actor_id = $3
		    WHERE original.preview_file_id = f.id AND original.org_id = f.org_id AND NOT EXISTS (
		      SELECT 1 FROM agents ag WHERE ag.actor_id = $3 AND m.chat_id = ANY(ag.write_only_chat_ids))
		  ))`, fileID, user.OrgID, user.ActorID).Scan(&result.ID, &result.Name, &result.MIME, &result.Size, &sha, &result.Status, &result.ProcessingStatus, &result.PreviewFileID, &result.CreatedAt, &result.ReadyAt, &result.UploaderID, &result.storageKey, &result.storageDriver, &voiceDuration, &waveform)
	if errors.Is(err, pgx.ErrNoRows) {
		return File{}, ErrNotFound
	}
	if err != nil {
		return File{}, fmt.Errorf("load accessible file: %w", err)
	}
	result.Voice = voiceFromColumns(voiceDuration, waveform)
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
	declaredMIME = strings.ToLower(declaredMIME)
	if err := validateVoice(input.Voice, name, declaredMIME, input.Size); err != nil {
		return "", "", nil, err
	}
	if input.Voice != nil {
		declaredMIME = normalizeVoiceMIME(declaredMIME)
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
	return name, declaredMIME, expected, nil
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
	// Go sniffs an MP4 with an "mp4*" brand as video; an audio-only MP4 is
	// the same container.
	if declared == "audio/mp4" && detected == "video/mp4" {
		return true
	}
	if strings.HasPrefix(declared, "text/") && detected == "text/plain" {
		return true
	}
	extension := strings.ToLower(filepath.Ext(name))
	return detected == "application/zip" && (extension == ".docx" || extension == ".xlsx" || extension == ".pptx")
}

func voiceDurationArg(voice *Voice) *int32 {
	if voice == nil {
		return nil
	}
	value := int32(voice.DurationMs)
	return &value
}

// sealUpload copies a client-uploaded object (presigned PUT or multipart) to
// a key that appeared in no URL the client received. The upload URL stays
// valid for its TTL after completion; once sealed, a second PUT only writes
// the abandoned upload key, which reconciliation removes, and never what
// readers download or what was checked. The copy briefly doubles the object
// in the bucket; the quota counts the file once.
func (s *Service) sealUpload(ctx context.Context, claim *uploadClaim) (storage.Blob, error) {
	copier, ok := s.store.(storage.ServerCopier)
	if !ok {
		return storage.Blob{}, fmt.Errorf("storage cannot seal a client upload")
	}
	var suffix [16]byte
	if _, err := rand.Read(suffix[:]); err != nil {
		return storage.Blob{}, fmt.Errorf("generate sealed key: %w", err)
	}
	uploadKey := claim.File.storageKey
	sealedKey := uploadKey + "-" + hex.EncodeToString(suffix[:])
	// The client's object stays until the file is committed, so a failed
	// copy or commit can be retried.
	blob, err := copier.Copy(ctx, uploadKey, sealedKey)
	if err != nil {
		_ = s.store.Delete(context.Background(), sealedKey)
		return storage.Blob{}, fmt.Errorf("seal uploaded file: %w", err)
	}
	if blob.Size != claim.File.Size {
		_ = s.store.Delete(context.Background(), sealedKey)
		return storage.Blob{}, storage.ErrSizeMismatch
	}
	claim.File.storageKey = sealedKey
	return blob, nil
}

// CheckStorage is the startup check of the configured store. It returns
// storage.ErrBucketMissing when the bucket does not exist, another error
// when the store cannot be reached, and ErrStorageSuspect when the most
// recently stored files all lack their objects (an empty or wrong bucket).
func (s *Service) CheckStorage(ctx context.Context) error {
	if checker, ok := s.store.(storage.BucketChecker); ok {
		if err := checker.CheckBucket(ctx); err != nil {
			return err
		}
	}
	rows, err := s.pool.Query(ctx, `
		SELECT storage_key FROM files
		WHERE storage_driver = $1 AND status = 'ready'
		ORDER BY ready_at DESC NULLS LAST LIMIT 5`, s.store.Driver())
	if err != nil {
		return fmt.Errorf("sample stored files: %w", err)
	}
	keys := []string{}
	for rows.Next() {
		var key string
		if err := rows.Scan(&key); err != nil {
			rows.Close()
			return err
		}
		keys = append(keys, key)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}
	missing := 0
	for _, key := range keys {
		if _, err := s.store.Stat(ctx, key); errors.Is(err, storage.ErrNotFound) {
			missing++
		} else if err != nil {
			return fmt.Errorf("check stored file: %w", err)
		}
	}
	if len(keys) > 0 && missing == len(keys) {
		return fmt.Errorf("%w: none of the %d most recent files has its object in the bucket", ErrStorageSuspect, len(keys))
	}
	return nil
}
