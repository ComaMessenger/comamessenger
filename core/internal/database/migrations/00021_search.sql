-- +goose Up
ALTER TABLE messages ADD COLUMN search_vector tsvector GENERATED ALWAYS AS (
    setweight(to_tsvector('russian'::regconfig, coalesce(body, '')), 'A') ||
    setweight(to_tsvector('english'::regconfig, coalesce(body, '')), 'A') ||
    setweight(to_tsvector('simple'::regconfig, coalesce(body, '')), 'B')
) STORED;

CREATE INDEX messages_search_vector_idx ON messages USING gin(search_vector) WHERE deleted_at IS NULL;

ALTER TABLE files ADD COLUMN search_vector tsvector GENERATED ALWAYS AS (
    setweight(to_tsvector('russian'::regconfig, coalesce(name, '')), 'A') ||
    setweight(to_tsvector('english'::regconfig, coalesce(name, '')), 'A') ||
    setweight(to_tsvector('simple'::regconfig, coalesce(name, '')), 'A') ||
    setweight(to_tsvector('russian'::regconfig, coalesce(extracted_text, '')), 'B') ||
    setweight(to_tsvector('english'::regconfig, coalesce(extracted_text, '')), 'B') ||
    setweight(to_tsvector('simple'::regconfig, coalesce(extracted_text, '')), 'B')
) STORED;

CREATE INDEX files_search_vector_idx ON files USING gin(search_vector) WHERE status = 'ready';

-- +goose Down
DROP INDEX IF EXISTS files_search_vector_idx;
ALTER TABLE files DROP COLUMN IF EXISTS search_vector;
DROP INDEX IF EXISTS messages_search_vector_idx;
ALTER TABLE messages DROP COLUMN IF EXISTS search_vector;
