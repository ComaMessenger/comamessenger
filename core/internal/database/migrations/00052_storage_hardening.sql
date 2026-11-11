-- +goose NO TRANSACTION
-- +goose Up
-- Safer file storage reconciliation and upload completion:
-- files.failed_at (when a file failed, so retiring waits from the failure),
-- files.missing_since (an object reported missing is re-checked before the
-- file is failed) and file_uploads.claim_expires_at (a completion holds a
-- lease that another worker may take over once it lapses).
--
-- files and file_uploads are hot, so every statement commits on its own and
-- gives up after 5 s of waiting for its lock instead of queueing behind a
-- long query and stalling every later access; a deploy then fails and is
-- retried. Adding nullable columns changes only the catalog. Each block is
-- safe to re-run.

-- +goose StatementBegin
DO $$
BEGIN
    SET LOCAL lock_timeout = '5s';
    ALTER TABLE files
        ADD COLUMN IF NOT EXISTS failed_at timestamptz,
        ADD COLUMN IF NOT EXISTS missing_since timestamptz;
END
$$;
-- +goose StatementEnd

-- +goose StatementBegin
DO $$
BEGIN
    SET LOCAL lock_timeout = '5s';
    ALTER TABLE file_uploads ADD COLUMN IF NOT EXISTS claim_expires_at timestamptz;
END
$$;
-- +goose StatementEnd

-- +goose Down
ALTER TABLE file_uploads DROP COLUMN IF EXISTS claim_expires_at;
ALTER TABLE files DROP COLUMN IF EXISTS missing_since;
ALTER TABLE files DROP COLUMN IF EXISTS failed_at;
