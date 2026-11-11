-- +goose NO TRANSACTION
-- +goose Up
-- A voice recording is an ordinary audio file with two extra columns: the
-- duration read from the container and a 64-value peak waveform (0..255).
--
-- files is hot, so every statement commits on its own and gives up after
-- 5 s of waiting for its lock instead of queueing behind a long query and
-- stalling every later access to files; a deploy then fails and is retried.
-- Adding nullable columns changes only the catalog. The CHECK is added
-- NOT VALID (a brief ACCESS EXCLUSIVE lock, no scan) and validated in its own
-- transaction under SHARE UPDATE EXCLUSIVE, which lets reads and writes run.
-- Each block is safe to re-run.

-- +goose StatementBegin
DO $$
BEGIN
    SET LOCAL lock_timeout = '5s';
    ALTER TABLE files
        ADD COLUMN IF NOT EXISTS voice_duration_ms integer,
        ADD COLUMN IF NOT EXISTS voice_waveform bytea;
END
$$;
-- +goose StatementEnd

-- +goose StatementBegin
DO $$
BEGIN
    SET LOCAL lock_timeout = '5s';
    ALTER TABLE files DROP CONSTRAINT IF EXISTS files_voice_check;
    -- IS NOT NULL keeps a half-filled pair from passing as unknown (NULL).
    ALTER TABLE files ADD CONSTRAINT files_voice_check CHECK (
        (voice_duration_ms IS NULL AND voice_waveform IS NULL)
        OR (voice_duration_ms IS NOT NULL AND voice_waveform IS NOT NULL
            AND voice_duration_ms BETWEEN 1 AND 600000 AND octet_length(voice_waveform) = 64)
    ) NOT VALID;
END
$$;
-- +goose StatementEnd

-- +goose StatementBegin
DO $$
BEGIN
    SET LOCAL lock_timeout = '5s';
    ALTER TABLE files VALIDATE CONSTRAINT files_voice_check;
END
$$;
-- +goose StatementEnd

-- +goose Down
ALTER TABLE files DROP CONSTRAINT IF EXISTS files_voice_check;
ALTER TABLE files DROP COLUMN IF EXISTS voice_waveform;
ALTER TABLE files DROP COLUMN IF EXISTS voice_duration_ms;
