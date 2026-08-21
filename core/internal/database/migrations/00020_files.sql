-- +goose Up
CREATE TABLE organization_storage_usage (
    org_id uuid PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
    used_bytes bigint NOT NULL DEFAULT 0 CHECK (used_bytes >= 0),
    reserved_bytes bigint NOT NULL DEFAULT 0 CHECK (reserved_bytes >= 0),
    quota_bytes bigint CHECK (quota_bytes IS NULL OR quota_bytes > 0),
    updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO organization_storage_usage (org_id)
SELECT id FROM organizations
ON CONFLICT DO NOTHING;

CREATE TABLE files (
    id uuid PRIMARY KEY,
    org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    uploader_id uuid NOT NULL,
    storage_driver text NOT NULL CHECK (storage_driver IN ('local', 's3')),
    bucket text,
    storage_key text NOT NULL CHECK (length(storage_key) BETWEEN 1 AND 512),
    name text NOT NULL CHECK (length(name) BETWEEN 1 AND 255),
    mime text NOT NULL CHECK (length(mime) BETWEEN 1 AND 255),
    size bigint NOT NULL CHECK (size >= 0),
    sha256 bytea CHECK (sha256 IS NULL OR octet_length(sha256) = 32),
    status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'ready', 'failed', 'deleted')),
    preview_file_id uuid REFERENCES files(id) ON DELETE SET NULL,
    extracted_text text,
    extractor_version text,
    processing_status text NOT NULL DEFAULT 'pending' CHECK (processing_status IN ('pending', 'processing', 'ready', 'failed', 'skipped')),
    created_at timestamptz NOT NULL DEFAULT now(),
    ready_at timestamptz,
    deleted_at timestamptz,
    reconciled_at timestamptz,
    UNIQUE (org_id, id),
    UNIQUE (storage_driver, bucket, storage_key),
    FOREIGN KEY (org_id, uploader_id) REFERENCES actors(org_id, id) ON DELETE RESTRICT
);

CREATE INDEX files_org_status_created_idx ON files(org_id, status, created_at DESC);
CREATE INDEX files_unattached_cleanup_idx ON files(created_at) WHERE status IN ('pending', 'failed');

ALTER TABLE actors
    ADD CONSTRAINT actors_avatar_file_fk
    FOREIGN KEY (org_id, avatar_file_id) REFERENCES files(org_id, id) ON DELETE SET NULL (avatar_file_id);
ALTER TABLE actors ADD COLUMN avatar_version bigint NOT NULL DEFAULT 0 CHECK (avatar_version >= 0);

CREATE TABLE file_uploads (
    id uuid PRIMARY KEY,
    org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    file_id uuid NOT NULL UNIQUE,
    actor_id uuid NOT NULL,
    mode text NOT NULL CHECK (mode IN ('streaming', 'presigned', 'multipart')),
    provider_upload_id text,
    expected_size bigint NOT NULL CHECK (expected_size >= 0),
    expected_sha256 bytea CHECK (expected_sha256 IS NULL OR octet_length(expected_sha256) = 32),
    reserved_bytes bigint NOT NULL CHECK (reserved_bytes >= 0),
    status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'uploading', 'completed', 'aborted', 'failed')),
    expires_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    completed_at timestamptz,
    aborted_at timestamptz,
    FOREIGN KEY (org_id, file_id) REFERENCES files(org_id, id) ON DELETE CASCADE,
    FOREIGN KEY (org_id, actor_id) REFERENCES actors(org_id, id) ON DELETE RESTRICT,
    CHECK (expires_at > created_at)
);

CREATE INDEX file_uploads_expiry_idx ON file_uploads(expires_at) WHERE status IN ('active', 'uploading');

CREATE TABLE file_upload_parts (
    upload_id uuid NOT NULL REFERENCES file_uploads(id) ON DELETE CASCADE,
    part_number integer NOT NULL CHECK (part_number BETWEEN 1 AND 10000),
    etag text NOT NULL CHECK (length(etag) BETWEEN 1 AND 512),
    size bigint CHECK (size IS NULL OR size > 0),
    PRIMARY KEY (upload_id, part_number)
);

CREATE TABLE message_files (
    message_id uuid NOT NULL,
    file_id uuid NOT NULL,
    org_id uuid NOT NULL,
    ordinal smallint NOT NULL CHECK (ordinal BETWEEN 0 AND 9),
    PRIMARY KEY (message_id, file_id),
    UNIQUE (message_id, ordinal),
    FOREIGN KEY (org_id, message_id) REFERENCES messages(org_id, id) ON DELETE CASCADE,
    FOREIGN KEY (org_id, file_id) REFERENCES files(org_id, id) ON DELETE RESTRICT
);

CREATE INDEX message_files_file_idx ON message_files(file_id, message_id);

CREATE TABLE message_embeddings (
    message_id uuid NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    provider text NOT NULL,
    model text NOT NULL,
    dimensions integer NOT NULL CHECK (dimensions BETWEEN 1 AND 4096),
    embedding vector,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (message_id, provider, model)
);

-- +goose Down
DROP TABLE IF EXISTS message_embeddings;
DROP TABLE IF EXISTS message_files;
DROP TABLE IF EXISTS file_upload_parts;
DROP TABLE IF EXISTS file_uploads;
ALTER TABLE actors DROP CONSTRAINT IF EXISTS actors_avatar_file_fk;
ALTER TABLE actors DROP COLUMN IF EXISTS avatar_version;
DROP TABLE IF EXISTS files;
DROP TABLE IF EXISTS organization_storage_usage;
