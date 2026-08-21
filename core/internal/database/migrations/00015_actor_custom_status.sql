-- +goose Up
ALTER TABLE actors
    ADD COLUMN status_emoji text NOT NULL DEFAULT '' CHECK (length(status_emoji) <= 16),
    ADD COLUMN status_text text NOT NULL DEFAULT '' CHECK (length(status_text) <= 100),
    ADD COLUMN status_expires_at timestamptz;

ALTER TABLE events DROP CONSTRAINT events_type_check;
ALTER TABLE events ADD CONSTRAINT events_type_check
    CHECK (type ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$');

-- +goose Down
DELETE FROM events WHERE type = 'actor.status.updated';
ALTER TABLE events DROP CONSTRAINT events_type_check;
ALTER TABLE events ADD CONSTRAINT events_type_check
    CHECK (type ~ '^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$');

ALTER TABLE actors
    DROP COLUMN IF EXISTS status_expires_at,
    DROP COLUMN IF EXISTS status_text,
    DROP COLUMN IF EXISTS status_emoji;
