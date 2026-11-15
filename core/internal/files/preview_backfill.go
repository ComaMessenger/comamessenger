package files

import (
	"context"
	"errors"
	"fmt"
	"io"
	"time"

	"github.com/comamessenger/comamessenger/core/internal/storage"
)

// Enough of a JPEG for its EXIF block: APP1 is limited to 64 KB and comes
// before the image data.
const orientationHeaderBytes = 128 << 10

const previewBackfillBatch = 20

type previewBackfillItem struct {
	record    processRecord
	previewID string
}

// BackfillPreviewOrientationBatch checks one batch of JPEG previews made
// before the server read EXIF Orientation (migration 00063) and rebuilds
// the ones whose original is stored turned. It reports true when nothing is
// left to check.
func (s *Service) BackfillPreviewOrientationBatch(ctx context.Context) (bool, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT id, org_id, uploader_id, storage_key, mime, name, status, size, preview_file_id
		FROM files
		WHERE NOT preview_oriented
		ORDER BY created_at, id
		LIMIT $1`, previewBackfillBatch)
	if err != nil {
		return false, fmt.Errorf("select previews to check: %w", err)
	}
	var items []previewBackfillItem
	for rows.Next() {
		var item previewBackfillItem
		var preview *string
		if err := rows.Scan(&item.record.ID, &item.record.OrgID, &item.record.UploaderID, &item.record.Key,
			&item.record.MIME, &item.record.Name, &item.record.Status, &item.record.Size, &preview); err != nil {
			rows.Close()
			return false, err
		}
		if preview != nil {
			item.previewID = *preview
		}
		items = append(items, item)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return false, err
	}
	if len(items) == 0 {
		return true, nil
	}
	for _, item := range items {
		if err := s.backfillPreviewOrientation(ctx, item); err != nil {
			return false, err
		}
	}
	return false, nil
}

func (s *Service) backfillPreviewOrientation(ctx context.Context, item previewBackfillItem) error {
	done := func() error {
		_, err := s.pool.Exec(ctx, `UPDATE files SET preview_oriented = true WHERE id = $1`, item.record.ID)
		return err
	}
	if item.record.Status != "ready" || item.previewID == "" {
		return done()
	}
	reader, _, err := s.store.Open(ctx, item.record.Key)
	if err != nil {
		// A missing original has nothing to rebuild from; the reconciler
		// deals with it. Other storage errors are retried with the batch.
		if errors.Is(err, storage.ErrNotFound) {
			return done()
		}
		return fmt.Errorf("open original for preview check: %w", err)
	}
	header, err := io.ReadAll(io.LimitReader(reader, orientationHeaderBytes))
	if err != nil {
		reader.Close()
		return fmt.Errorf("read original header: %w", err)
	}
	if jpegOrientation(header) == 1 {
		reader.Close()
		return done()
	}
	rest, readErr := readBounded(reader, maxProcessorInput-int64(len(header)))
	closeErr := reader.Close()
	if err := errors.Join(readErr, closeErr); err != nil {
		// Too large or unreadable: the old preview stays.
		return done()
	}
	preview, err := makeImagePreview(append(header, rest...))
	if err != nil {
		return done()
	}
	if err := s.savePreview(ctx, item.record, preview, &item.previewID); err != nil {
		if errors.Is(err, ErrStorageFull) {
			return done()
		}
		return err
	}
	return done()
}

// BackfillPreviewOrientation runs batches until every old preview is
// checked or ctx ends, pausing between batches so live traffic keeps the
// storage and the database. Failed batches are reported and retried later.
func (s *Service) BackfillPreviewOrientation(ctx context.Context, pause time.Duration, report func(error)) {
	for {
		done, err := s.BackfillPreviewOrientationBatch(ctx)
		if done {
			return
		}
		wait := pause
		if err != nil {
			if ctx.Err() != nil {
				return
			}
			if report != nil {
				report(err)
			}
			wait = 30 * time.Second
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(wait):
		}
	}
}
