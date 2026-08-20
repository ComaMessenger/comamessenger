-- +goose Up
ALTER TABLE organizations
    ADD COLUMN version bigint NOT NULL DEFAULT 1 CHECK (version > 0);

CREATE TABLE organization_branding_assets (
    org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    kind text NOT NULL CHECK (kind IN ('logo', 'favicon')),
    content_type text NOT NULL CHECK (length(content_type) BETWEEN 3 AND 120),
    content bytea NOT NULL CHECK (octet_length(content) BETWEEN 1 AND 524288),
    updated_by uuid REFERENCES actors(id) ON DELETE SET NULL,
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (org_id, kind)
);

CREATE TABLE organization_integrations (
    org_id uuid PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
    version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
    encrypted_config bytea NOT NULL,
    updated_by uuid REFERENCES actors(id) ON DELETE SET NULL,
    updated_at timestamptz NOT NULL DEFAULT now()
);

-- +goose Down
DROP TABLE IF EXISTS organization_integrations;
DROP TABLE IF EXISTS organization_branding_assets;
ALTER TABLE organizations DROP COLUMN IF EXISTS version;
