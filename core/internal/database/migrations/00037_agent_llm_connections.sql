-- +goose Up
CREATE TABLE agent_llm_connections (
    id uuid PRIMARY KEY,
    org_id uuid NOT NULL,
    name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 120),
    provider text NOT NULL CHECK (provider IN ('openai', 'anthropic', 'openai-compatible')),
    endpoint_url text NOT NULL DEFAULT '' CHECK (length(endpoint_url) <= 2048),
    default_model text NOT NULL DEFAULT '' CHECK (length(default_model) <= 200),
    enabled boolean NOT NULL DEFAULT true,
    key_version smallint NOT NULL DEFAULT 1 CHECK (key_version > 0),
    nonce bytea NOT NULL CHECK (octet_length(nonce) = 12),
    ciphertext bytea NOT NULL CHECK (octet_length(ciphertext) >= 16),
    key_hint text NOT NULL CHECK (length(key_hint) BETWEEN 1 AND 80),
    health_status text NOT NULL DEFAULT 'untested' CHECK (health_status IN ('untested', 'healthy', 'unhealthy')),
    last_tested_at timestamptz,
    last_error_code text NOT NULL DEFAULT '' CHECK (length(last_error_code) <= 120),
    created_by uuid NOT NULL,
    updated_by uuid NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (org_id, id),
    FOREIGN KEY (org_id, created_by) REFERENCES actors(org_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (org_id, updated_by) REFERENCES actors(org_id, id) ON DELETE RESTRICT,
    CHECK (
        (provider = 'openai-compatible' AND length(btrim(endpoint_url)) > 0)
        OR (provider IN ('openai', 'anthropic') AND endpoint_url = '')
    )
);

CREATE UNIQUE INDEX agent_llm_connections_org_name_idx
    ON agent_llm_connections(org_id, lower(btrim(name)));
CREATE INDEX agent_llm_connections_org_updated_idx
    ON agent_llm_connections(org_id, updated_at DESC);

ALTER TABLE agents ADD COLUMN llm_connection_id uuid;
ALTER TABLE agents ADD CONSTRAINT agents_llm_connection_fk
    FOREIGN KEY (org_id, llm_connection_id)
    REFERENCES agent_llm_connections(org_id, id)
    ON DELETE RESTRICT;
CREATE INDEX agents_llm_connection_idx
    ON agents(llm_connection_id)
    WHERE llm_connection_id IS NOT NULL;

-- +goose Down
DROP INDEX IF EXISTS agents_llm_connection_idx;
ALTER TABLE agents DROP CONSTRAINT IF EXISTS agents_llm_connection_fk;
ALTER TABLE agents DROP COLUMN IF EXISTS llm_connection_id;
DROP TABLE IF EXISTS agent_llm_connections;
