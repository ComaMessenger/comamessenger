package files

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"github.com/comamessenger/comamessenger/core/internal/storage"
)

type ReconcileStats struct {
	ExpiredUploads int
	MissingBlobs   int
	SizeMismatches int
	OrphanBlobs    int
}

type staleUpload struct {
	ID, OrgID, FileID, Key, Mode, ProviderID string
	Reserved                                 int64
}

func (s *Service) Reconcile(ctx context.Context) (ReconcileStats, error) {
	stats, err := s.cleanupExpired(ctx, 100)
	if err != nil {
		return stats, err
	}
	rows, err := s.pool.Query(ctx, `
		SELECT id, org_id, storage_key, size
		FROM files
		WHERE status = 'ready' AND (reconciled_at IS NULL OR reconciled_at < now() - interval '1 day')
		ORDER BY reconciled_at NULLS FIRST, created_at
		LIMIT 100`)
	if err != nil {
		return stats, fmt.Errorf("load files for reconciliation: %w", err)
	}
	type candidate struct {
		ID, OrgID, Key string
		Size           int64
	}
	candidates := make([]candidate, 0, 100)
	for rows.Next() {
		var item candidate
		if err := rows.Scan(&item.ID, &item.OrgID, &item.Key, &item.Size); err != nil {
			rows.Close()
			return stats, fmt.Errorf("scan reconciliation file: %w", err)
		}
		candidates = append(candidates, item)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return stats, fmt.Errorf("iterate reconciliation files: %w", err)
	}
	for _, item := range candidates {
		blob, statErr := s.store.Stat(ctx, item.Key)
		if statErr == nil && blob.Size == item.Size {
			_, err = s.pool.Exec(ctx, `UPDATE files SET reconciled_at = now() WHERE id = $1 AND status = 'ready'`, item.ID)
			if err != nil {
				return stats, fmt.Errorf("mark file reconciled: %w", err)
			}
			continue
		}
		if statErr != nil && !errors.Is(statErr, storage.ErrNotFound) {
			return stats, statErr
		}
		result, err := s.pool.Exec(ctx, `
			WITH failed AS (
			  UPDATE files SET status = 'failed', processing_status = 'failed', reconciled_at = now()
			  WHERE id = $1 AND org_id = $2 AND status = 'ready' RETURNING size
			)
			UPDATE organization_storage_usage usage
			SET used_bytes = GREATEST(0, used_bytes - failed.size), updated_at = now()
			FROM failed WHERE usage.org_id = $2`, item.ID, item.OrgID)
		if err != nil {
			return stats, fmt.Errorf("fail inconsistent file: %w", err)
		}
		if result.RowsAffected() > 0 {
			if errors.Is(statErr, storage.ErrNotFound) {
				stats.MissingBlobs++
			} else {
				stats.SizeMismatches++
			}
		}
	}
	if _, err := s.pool.Exec(ctx, `
		UPDATE organization_storage_usage usage SET
		  used_bytes = COALESCE((SELECT sum(size) FROM files WHERE org_id = usage.org_id AND status = 'ready'), 0),
		  reserved_bytes = COALESCE((SELECT sum(reserved_bytes) FROM file_uploads WHERE org_id = usage.org_id AND status IN ('active', 'uploading')), 0),
		  updated_at = now()`); err != nil {
		return stats, fmt.Errorf("reconcile storage ledger: %w", err)
	}
	if lister, ok := s.store.(storage.BlobLister); ok {
		blobs, err := lister.List(ctx)
		if err != nil {
			return stats, err
		}
		cutoff := time.Now().Add(-time.Hour)
		for _, blob := range blobs {
			if blob.ModifiedAt.After(cutoff) {
				continue
			}
			var exists bool
			if err := s.pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM files WHERE storage_driver = $1 AND storage_key = $2)`, s.store.Driver(), blob.Key).Scan(&exists); err != nil {
				return stats, fmt.Errorf("check orphan blob: %w", err)
			}
			if !exists {
				if err := s.store.Delete(ctx, blob.Key); err != nil {
					return stats, err
				}
				stats.OrphanBlobs++
			}
		}
	}
	return stats, nil
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
		  WHERE status IN ('active', 'uploading') AND expires_at <= now()
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
		if _, err := tx.Exec(ctx, `UPDATE files SET status = 'failed' WHERE id = $1 AND status = 'pending'`, item.FileID); err != nil {
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
				w.logger.Info("file reconciliation completed", "expired_uploads", stats.ExpiredUploads, "missing_blobs", stats.MissingBlobs, "size_mismatches", stats.SizeMismatches, "orphan_blobs", stats.OrphanBlobs)
			}
		}
	}
}
