-- +goose Up
-- Image previews made before the server read EXIF Orientation lie on their
-- side for phone photos stored turned (JPEG with Orientation 5-8, or upside
-- down with 3). False marks a JPEG whose preview is still to be checked;
-- files.BackfillPreviewOrientation reads each original's header in the
-- background and rebuilds the preview only when the tag turns it.
ALTER TABLE files ADD COLUMN preview_oriented boolean NOT NULL DEFAULT true;
UPDATE files SET preview_oriented = false
WHERE preview_file_id IS NOT NULL AND status = 'ready' AND mime = 'image/jpeg';
CREATE INDEX files_preview_orientation_backfill_idx ON files(created_at, id) WHERE NOT preview_oriented;

-- +goose Down
DROP INDEX IF EXISTS files_preview_orientation_backfill_idx;
ALTER TABLE files DROP COLUMN IF EXISTS preview_oriented;
