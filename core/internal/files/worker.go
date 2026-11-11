package files

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"regexp"
	"time"

	"github.com/comamessenger/comamessenger/core/internal/storage"
)

type ReconcileStats struct {
	ExpiredUploads  int
	MissingBlobs    int
	SizeMismatches  int
	OrphanBlobs     int
	UnattachedFiles int
	// RetiredFailed counts failed files marked deleted once no upload URL
	// for them can work any more; AbortedMultipart counts multipart uploads
	// nobody completed.
	RetiredFailed    int
	AbortedMultipart int
	// RestoredFiles counts files failed for a missing object whose object
	// came back.
	RestoredFiles int
}

type staleUpload struct {
	ID, OrgID, FileID, Key, Mode, ProviderID string
	Reserved                                 int64
}

// ownedKeyPattern matches every key Core writes: uploads and their sealed
// copies, image previews and avatars. Reconciliation never touches other
// keys, so a bucket shared with another application is safe.
var ownedKeyPattern = regexp.MustCompile(`^(objects/[0-9a-f]{2}/[0-9a-f]{2}/[0-9a-f-]{36}(-[0-9a-f]{32})?|previews/[0-9a-f]{2}/[0-9a-f-]{36}\.jpg|avatars/[0-9a-f]{2}/[0-9a-f-]{36}\.[a-z0-9]{1,8})$`)

// OwnedKey reports whether Core could have written the key.
func OwnedKey(key string) bool { return ownedKeyPattern.MatchString(key) }

// ErrStorageSuspect stops a reconciliation pass that would otherwise act on
// a storage that looks wrong: a missing bucket, an empty bucket for a
// non-empty file table, or many files missing at once. Nothing is changed.
var ErrStorageSuspect = errors.New("file storage looks misconfigured; reconciliation stopped without changes")

const (
	// missingRecheck is how long an object must stay missing, across
	// passes, before its file is failed.
	missingRecheck = time.Hour
	// A pass stops when at least suspectMinMissing of the checked files are
	// missing and they are at least suspectMissingPercent of them.
	suspectMinMissing     = 3
	suspectMissingPercent = 10
)

// Reconcile keeps the file table and the store consistent. It never deletes
// the object of a file that was ever ready (ready_at set): such a file can
// only lose its object through an explicit deletion path. A pass checks the
// bucket first and stops without changes when the storage looks wrong.
func (s *Service) Reconcile(ctx context.Context) (ReconcileStats, error) {
	stats := ReconcileStats{}
	if checker, ok := s.store.(storage.BucketChecker); ok {
		if err := checker.CheckBucket(ctx); err != nil {
			return stats, fmt.Errorf("%w: %v", ErrStorageSuspect, err)
		}
	}
	expired, err := s.cleanupExpired(ctx, 100)
	stats.ExpiredUploads = expired.ExpiredUploads
	if err != nil {
		return stats, err
	}
	unattached, err := s.cleanupUnattached(ctx, 100)
	if err != nil {
		return stats, err
	}
	stats.UnattachedFiles = unattached
	// A file that failed before it was ever ready keeps its row for the
	// audit trail; once every URL that could write its key has expired,
	// counted from the failure, it is deleted so its key becomes an orphan.
	retired, err := s.pool.Exec(ctx, `
		UPDATE files SET status = 'deleted', deleted_at = now()
		WHERE status = 'failed' AND ready_at IS NULL AND failed_at IS NOT NULL
		  AND failed_at < now() - make_interval(secs => $1)`, s.uploadURLLifetime().Seconds())
	if err != nil {
		return stats, fmt.Errorf("retire failed files: %w", err)
	}
	stats.RetiredFailed = int(retired.RowsAffected())
	if err := s.reconcileReadyFiles(ctx, &stats); err != nil {
		return stats, err
	}
	if _, err := s.pool.Exec(ctx, `
		UPDATE organization_storage_usage usage SET
		  used_bytes = COALESCE((SELECT sum(size) FROM files WHERE org_id = usage.org_id AND status = 'ready'), 0),
		  reserved_bytes = COALESCE((SELECT sum(reserved_bytes) FROM file_uploads WHERE org_id = usage.org_id AND status IN ('active', 'uploading')), 0),
		  updated_at = now()`); err != nil {
		return stats, fmt.Errorf("reconcile storage ledger: %w", err)
	}
	if err := s.deleteOrphans(ctx, &stats); err != nil {
		return stats, err
	}
	if sweeper, ok := s.store.(storage.MultipartSweeper); ok {
		aborted, err := sweeper.AbortStaleMultipart(ctx, time.Now().Add(-s.uploadURLLifetime()-s.orphanGrace), OwnedKey)
		stats.AbortedMultipart = aborted
		if err != nil {
			return stats, err
		}
	}
	return stats, nil
}

// reconcileReadyFiles checks the objects of ready files, and of files this
// worker failed for a missing object (they come back when it reappears). A
// missing object is noted first and fails its file only if still missing
// after missingRecheck. Many missing objects at once stop the pass.
func (s *Service) reconcileReadyFiles(ctx context.Context, stats *ReconcileStats) error {
	rows, err := s.pool.Query(ctx, `
		SELECT id, org_id, storage_key, size, status
		FROM files
		WHERE storage_driver = $1 AND (
		  (status = 'ready' AND (reconciled_at IS NULL OR reconciled_at < now() - interval '1 day' OR missing_since IS NOT NULL))
		  OR (status = 'failed' AND ready_at IS NOT NULL AND missing_since IS NOT NULL))
		ORDER BY missing_since NULLS LAST, reconciled_at NULLS FIRST, created_at
		LIMIT 100`, s.store.Driver())
	if err != nil {
		return fmt.Errorf("load files for reconciliation: %w", err)
	}
	type candidate struct {
		ID, OrgID, Key, Status string
		Size                   int64
	}
	candidates := make([]candidate, 0, 100)
	for rows.Next() {
		var item candidate
		if err := rows.Scan(&item.ID, &item.OrgID, &item.Key, &item.Size, &item.Status); err != nil {
			rows.Close()
			return fmt.Errorf("scan reconciliation file: %w", err)
		}
		candidates = append(candidates, item)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return fmt.Errorf("iterate reconciliation files: %w", err)
	}
	present := make([]candidate, 0, len(candidates))
	missing := make([]candidate, 0)
	for _, item := range candidates {
		blob, statErr := s.store.Stat(ctx, item.Key)
		switch {
		case statErr == nil && blob.Size == item.Size:
			present = append(present, item)
		case statErr == nil || errors.Is(statErr, storage.ErrNotFound):
			missing = append(missing, item)
		default:
			// A store error is not evidence of a missing object.
			return fmt.Errorf("check file object: %w", statErr)
		}
	}
	if len(missing) >= suspectMinMissing && len(missing)*100 >= len(candidates)*suspectMissingPercent {
		return fmt.Errorf("%w: %d of %d checked file objects are missing", ErrStorageSuspect, len(missing), len(candidates))
	}
	for _, item := range present {
		result, err := s.pool.Exec(ctx, `
			UPDATE files SET reconciled_at = now(), missing_since = NULL,
			  status = CASE WHEN status = 'failed' THEN 'ready' ELSE status END,
			  failed_at = CASE WHEN status = 'failed' THEN NULL ELSE failed_at END
			WHERE id = $1 AND (status = 'ready' OR (status = 'failed' AND ready_at IS NOT NULL AND missing_since IS NOT NULL))`, item.ID)
		if err != nil {
			return fmt.Errorf("mark file reconciled: %w", err)
		}
		if item.Status == "failed" && result.RowsAffected() == 1 {
			stats.RestoredFiles++
		}
	}
	for _, item := range missing {
		if item.Status != "ready" {
			continue
		}
		// First sighting: remember it. Still missing after missingRecheck:
		// fail the file, keeping ready_at so its object is never collected.
		result, err := s.pool.Exec(ctx, `
			UPDATE files SET
			  missing_since = COALESCE(missing_since, now()),
			  status = CASE WHEN missing_since < now() - make_interval(secs => $2) THEN 'failed' ELSE status END,
			  failed_at = CASE WHEN missing_since < now() - make_interval(secs => $2) THEN now() ELSE failed_at END
			WHERE id = $1 AND status = 'ready'
			RETURNING status`, item.ID, missingRecheck.Seconds())
		if err != nil {
			return fmt.Errorf("note missing file object: %w", err)
		}
		if result.RowsAffected() == 1 {
			stats.MissingBlobs++
		}
	}
	return nil
}

// deleteOrphans removes objects with a Core key that no file owns. A file
// owns its object while pending or ready, and forever once it was ready.
func (s *Service) deleteOrphans(ctx context.Context, stats *ReconcileStats) error {
	lister, ok := s.store.(storage.BlobLister)
	if !ok {
		return nil
	}
	blobs, err := lister.List(ctx)
	if err != nil {
		return err
	}
	owned := 0
	for _, blob := range blobs {
		if OwnedKey(blob.Key) {
			owned++
		}
	}
	if owned == 0 {
		var files int
		if err := s.pool.QueryRow(ctx, `SELECT count(*) FROM files WHERE storage_driver = $1 AND ready_at IS NOT NULL AND status <> 'deleted'`, s.store.Driver()).Scan(&files); err != nil {
			return fmt.Errorf("count stored files: %w", err)
		}
		if files > 0 {
			return fmt.Errorf("%w: the bucket holds no Core objects but %d files are stored", ErrStorageSuspect, files)
		}
	}
	cutoff := time.Now().Add(-s.orphanGrace)
	for _, blob := range blobs {
		if blob.ModifiedAt.After(cutoff) || !OwnedKey(blob.Key) {
			continue
		}
		var exists bool
		// A failed file that was never ready does not own its key: it may be
		// rewritten through a still-valid upload URL, and an upload key is
		// abandoned once its copy is sealed. Previews and avatars are files
		// rows of their own and follow the same rule.
		if err := s.pool.QueryRow(ctx, `
			SELECT EXISTS(SELECT 1 FROM files WHERE storage_driver = $1 AND storage_key = $2
			  AND (status IN ('pending', 'ready') OR ready_at IS NOT NULL))`, s.store.Driver(), blob.Key).Scan(&exists); err != nil {
			return fmt.Errorf("check orphan blob: %w", err)
		}
		if !exists {
			if err := s.store.Delete(ctx, blob.Key); err != nil {
				return err
			}
			stats.OrphanBlobs++
		}
	}
	return nil
}

type unattachedFile struct {
	ID, OrgID, Key string
	Size           int64
	PreviewID      *string
	PreviewKey     *string
	PreviewSize    *int64
}

func (s *Service) cleanupUnattached(ctx context.Context, limit int) (int, error) {
	cutoff := time.Now().UTC().Add(-s.uploadTTL)
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return 0, fmt.Errorf("begin unattached file cleanup: %w", err)
	}
	defer tx.Rollback(ctx)
	rows, err := tx.Query(ctx, `
		SELECT f.id, f.org_id, f.storage_key, f.size, preview.id, preview.storage_key, preview.size
		FROM files f
		LEFT JOIN files preview ON preview.id = f.preview_file_id AND preview.org_id = f.org_id AND preview.status = 'ready'
		WHERE f.status = 'ready' AND f.ready_at <= $1
		  AND NOT EXISTS (SELECT 1 FROM message_files mf WHERE mf.file_id = f.id)
		  AND NOT EXISTS (SELECT 1 FROM scheduled_message_files smf WHERE smf.file_id = f.id)
		  AND NOT EXISTS (SELECT 1 FROM actors a WHERE a.org_id = f.org_id AND a.avatar_file_id = f.id)
		  AND NOT EXISTS (SELECT 1 FROM chats c WHERE c.org_id = f.org_id AND c.avatar_file_id = f.id)
		  AND NOT EXISTS (SELECT 1 FROM knowledge_documents kd WHERE kd.org_id = f.org_id AND kd.file_id = f.id)
		  AND NOT EXISTS (SELECT 1 FROM files parent WHERE parent.org_id = f.org_id AND parent.preview_file_id = f.id AND parent.status <> 'deleted')
		ORDER BY f.ready_at, f.id
		LIMIT $2
		FOR UPDATE OF f SKIP LOCKED`, cutoff, limit)
	if err != nil {
		return 0, fmt.Errorf("select unattached files: %w", err)
	}
	items := make([]unattachedFile, 0, limit)
	for rows.Next() {
		var item unattachedFile
		if err := rows.Scan(&item.ID, &item.OrgID, &item.Key, &item.Size, &item.PreviewID, &item.PreviewKey, &item.PreviewSize); err != nil {
			rows.Close()
			return 0, err
		}
		items = append(items, item)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return 0, err
	}
	claimed := make([]unattachedFile, 0, len(items))
	for _, item := range items {
		result, err := tx.Exec(ctx, `
			UPDATE files f SET status = 'deleted', deleted_at = now()
			WHERE f.id = $1 AND f.status = 'ready'
			  AND NOT EXISTS (SELECT 1 FROM message_files mf WHERE mf.file_id = f.id)
			  AND NOT EXISTS (SELECT 1 FROM scheduled_message_files smf WHERE smf.file_id = f.id)
			  AND NOT EXISTS (SELECT 1 FROM actors a WHERE a.org_id = f.org_id AND a.avatar_file_id = f.id)
			  AND NOT EXISTS (SELECT 1 FROM chats c WHERE c.org_id = f.org_id AND c.avatar_file_id = f.id)
			  AND NOT EXISTS (SELECT 1 FROM knowledge_documents kd WHERE kd.org_id = f.org_id AND kd.file_id = f.id)`, item.ID)
		if err != nil {
			return 0, err
		}
		if result.RowsAffected() != 1 {
			continue
		}
		bytes := item.Size
		if item.PreviewID != nil {
			if _, err := tx.Exec(ctx, `UPDATE files SET status = 'deleted', deleted_at = now() WHERE id = $1 AND status = 'ready'`, *item.PreviewID); err != nil {
				return 0, err
			}
			if item.PreviewSize != nil {
				bytes += *item.PreviewSize
			}
		}
		if _, err := tx.Exec(ctx, `UPDATE organization_storage_usage SET used_bytes = GREATEST(0, used_bytes - $2), updated_at = now() WHERE org_id = $1`, item.OrgID, bytes); err != nil {
			return 0, err
		}
		claimed = append(claimed, item)
	}
	if err := tx.Commit(ctx); err != nil {
		return 0, fmt.Errorf("commit unattached file cleanup: %w", err)
	}
	for _, item := range claimed {
		_ = s.store.Delete(ctx, item.Key)
		if item.PreviewKey != nil {
			_ = s.store.Delete(ctx, *item.PreviewKey)
		}
	}
	return len(claimed), nil
}

func (s *Service) cleanupExpired(ctx context.Context, limit int) (ReconcileStats, error) {
	stats := ReconcileStats{}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return stats, fmt.Errorf("begin expired upload cleanup: %w", err)
	}
	defer tx.Rollback(ctx)
	rows, err := tx.Query(ctx, `
		WITH selected AS (
		  SELECT id FROM file_uploads
		  WHERE expires_at <= now() AND (status = 'active'
		    OR (status = 'uploading' AND (claim_expires_at IS NULL OR claim_expires_at < now())))
		  ORDER BY expires_at FOR UPDATE SKIP LOCKED LIMIT $1
		)
		UPDATE file_uploads upload SET status = 'aborted', aborted_at = now()
		FROM selected, files file
		WHERE upload.id = selected.id AND file.id = upload.file_id
		RETURNING upload.id, upload.org_id, upload.file_id, upload.reserved_bytes, file.storage_key,
		          upload.mode, COALESCE(upload.provider_upload_id, '')`, limit)
	if err != nil {
		return stats, fmt.Errorf("claim expired uploads: %w", err)
	}
	stale := make([]staleUpload, 0, limit)
	for rows.Next() {
		var item staleUpload
		if err := rows.Scan(&item.ID, &item.OrgID, &item.FileID, &item.Reserved, &item.Key, &item.Mode, &item.ProviderID); err != nil {
			rows.Close()
			return stats, fmt.Errorf("scan expired upload: %w", err)
		}
		stale = append(stale, item)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return stats, fmt.Errorf("iterate expired uploads: %w", err)
	}
	for _, item := range stale {
		if _, err := tx.Exec(ctx, `UPDATE files SET status = 'failed', failed_at = now() WHERE id = $1 AND status = 'pending'`, item.FileID); err != nil {
			return stats, err
		}
		if _, err := tx.Exec(ctx, `UPDATE organization_storage_usage SET reserved_bytes = GREATEST(0, reserved_bytes - $2), updated_at = now() WHERE org_id = $1`, item.OrgID, item.Reserved); err != nil {
			return stats, err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return stats, fmt.Errorf("commit expired upload cleanup: %w", err)
	}
	for _, item := range stale {
		if item.Mode == "multipart" && item.ProviderID != "" {
			_ = s.store.(storage.MultipartBlobStore).AbortMultipart(ctx, storage.MultipartUpload{UploadID: item.ProviderID, Key: item.Key})
		} else {
			_ = s.store.Delete(ctx, item.Key)
		}
		stats.ExpiredUploads++
	}
	return stats, nil
}

type Worker struct {
	logger   *slog.Logger
	service  *Service
	interval time.Duration
}

func NewWorker(logger *slog.Logger, service *Service, interval time.Duration) *Worker {
	return &Worker{logger: logger, service: service, interval: interval}
}

func (w *Worker) Run(ctx context.Context) {
	ticker := time.NewTicker(w.interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			stats, err := w.service.Reconcile(ctx)
			if err != nil && !errors.Is(err, context.Canceled) {
				w.logger.Error("file reconciliation failed", "error", err)
			} else if stats != (ReconcileStats{}) {
				w.logger.Info("file reconciliation completed", "expired_uploads", stats.ExpiredUploads, "unattached_files", stats.UnattachedFiles, "missing_blobs", stats.MissingBlobs, "size_mismatches", stats.SizeMismatches, "orphan_blobs", stats.OrphanBlobs)
			}
		}
	}
}
