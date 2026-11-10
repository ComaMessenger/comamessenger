-- +goose Up
-- Phase 5.3 package H: workspace integrations. MCP connections move from a
-- single agent to the workspace, external systems may start agents through a
-- signed webhook, and spreadsheets from the knowledge base are stored as rows
-- for the query_table tool. Every change is additive: older Core builds keep
-- reading agent_mcp_servers, which this migration copies but leaves intact.

CREATE TABLE integration_mcp_connections (
    id uuid PRIMARY KEY,
    org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    -- The name namespaces tools for the model (mcp__<name>__<tool>).
    name text NOT NULL CHECK (name ~ '^[a-z0-9][a-z0-9_-]{0,63}$'),
    description text NOT NULL DEFAULT '' CHECK (length(description) <= 500),
    endpoint_url text NOT NULL CHECK (length(endpoint_url) BETWEEN 1 AND 2048),
    enabled boolean NOT NULL DEFAULT true,
    -- Explicit opt-in for trusted addresses inside private networks.
    allow_private_network boolean NOT NULL DEFAULT false,
    encrypted_headers bytea,
    secret_hint text NOT NULL DEFAULT '' CHECK (length(secret_hint) <= 200),
    -- Headers copied from agent_mcp_servers stay sealed with their original
    -- associated data until an administrator replaces them.
    legacy_agent_id uuid,
    timeout_ms integer NOT NULL DEFAULT 10000 CHECK (timeout_ms BETWEEN 100 AND 120000),
    max_output_bytes integer NOT NULL DEFAULT 262144 CHECK (max_output_bytes BETWEEN 1024 AND 4194304),
    -- Policy set by integrations.manage. Agents may bind the connection only
    -- after it is released for agents; bindings can tighten, never loosen it.
    agent_use_allowed boolean NOT NULL DEFAULT false,
    writes_require_confirmation boolean NOT NULL DEFAULT true,
    -- Tools agents may be given; NULL means every tool of the catalog.
    assignable_tools text[] CHECK (assignable_tools IS NULL OR cardinality(assignable_tools) <= 256),
    -- Migrated connections keep the runtime's read/write classification until
    -- the first successful test refreshes Core's own catalog.
    legacy_unverified boolean NOT NULL DEFAULT false,
    tools jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(tools) = 'array' AND octet_length(tools::text) <= 262144),
    tools_refreshed_at timestamptz,
    health_status text NOT NULL DEFAULT 'untested' CHECK (health_status IN ('untested', 'healthy', 'unhealthy')),
    last_tested_at timestamptz,
    last_error_code text NOT NULL DEFAULT '' CHECK (length(last_error_code) <= 120),
    created_by uuid NOT NULL,
    updated_by uuid NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (org_id, id),
    UNIQUE (org_id, name),
    FOREIGN KEY (org_id, created_by) REFERENCES actors(org_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (org_id, updated_by) REFERENCES actors(org_id, id) ON DELETE RESTRICT
);

-- Bindings follow the 5.2 draft/publish model like knowledge collections:
-- [{"connection_id","allowed_tools","require_write_confirmation"}].
ALTER TABLE agents ADD COLUMN mcp_bindings jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(mcp_bindings) = 'array' AND jsonb_array_length(mcp_bindings) <= 64);
ALTER TABLE agent_drafts ADD COLUMN mcp_bindings jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(mcp_bindings) = 'array' AND jsonb_array_length(mcp_bindings) <= 64);
CREATE INDEX agents_mcp_bindings_idx ON agents USING gin(mcp_bindings jsonb_path_ops);
CREATE INDEX agent_drafts_mcp_bindings_idx ON agent_drafts USING gin(mcp_bindings jsonb_path_ops);

-- Every per-agent MCP server becomes a workspace connection with the same id,
-- bound to its agent. Names were unique per agent only; duplicates inside a
-- workspace get a stable suffix from the server id.
INSERT INTO integration_mcp_connections(
    id,org_id,name,endpoint_url,enabled,encrypted_headers,legacy_agent_id,timeout_ms,max_output_bytes,
    agent_use_allowed,writes_require_confirmation,assignable_tools,legacy_unverified,
    created_by,updated_by,created_at,updated_at)
SELECT ranked.id,ranked.org_id,
       CASE WHEN ranked.position = 1 THEN ranked.base_name
            ELSE left(ranked.base_name, 55) || '-' || left(replace(ranked.id::text, '-', ''), 8) END,
       ranked.endpoint_url,ranked.enabled,ranked.encrypted_headers,ranked.agent_id,ranked.timeout_ms,ranked.max_output_bytes,
       true,ranked.require_write_confirmation,ranked.allowed_tools,true,
       ranked.owner_actor_id,ranked.owner_actor_id,ranked.created_at,ranked.updated_at
FROM (
    SELECT normalized.*,
           row_number() OVER (PARTITION BY normalized.org_id, normalized.base_name ORDER BY normalized.created_at, normalized.id) AS position
    FROM (
        SELECT server.*, agent.owner_actor_id,
               COALESCE(NULLIF(left(regexp_replace(regexp_replace(lower(btrim(server.name)), '[^a-z0-9_-]+', '-', 'g'), '^[^a-z0-9]+', ''), 64), ''), 'mcp') AS base_name
        FROM agent_mcp_servers server
        JOIN agents agent ON agent.org_id = server.org_id AND agent.actor_id = server.agent_id
    ) normalized
) ranked;

UPDATE agents agent SET mcp_bindings = bound.bindings
FROM (
    SELECT server.agent_id, jsonb_agg(jsonb_build_object(
               'connection_id', server.id,
               'allowed_tools', to_jsonb(server.allowed_tools),
               'require_write_confirmation', server.require_write_confirmation) ORDER BY server.name, server.id) AS bindings
    FROM agent_mcp_servers server
    GROUP BY server.agent_id
) bound
WHERE agent.actor_id = bound.agent_id;

UPDATE agent_drafts draft SET mcp_bindings = agent.mcp_bindings
FROM agents agent
WHERE agent.org_id = draft.org_id AND agent.actor_id = draft.agent_id AND agent.mcp_bindings <> '[]'::jsonb;

-- Incoming webhooks. The secret must be recoverable to verify HMAC
-- signatures, so it is encrypted rather than hashed.
CREATE TABLE integration_webhooks (
    id uuid PRIMARY KEY,
    org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 120),
    description text NOT NULL DEFAULT '' CHECK (length(description) <= 500),
    enabled boolean NOT NULL DEFAULT true,
    secret_nonce bytea NOT NULL CHECK (octet_length(secret_nonce) = 12),
    secret_ciphertext bytea NOT NULL CHECK (octet_length(secret_ciphertext) >= 16),
    secret_hint text NOT NULL CHECK (length(secret_hint) BETWEEN 1 AND 80),
    rate_limit_per_minute integer NOT NULL DEFAULT 60 CHECK (rate_limit_per_minute BETWEEN 1 AND 6000),
    max_body_bytes integer NOT NULL DEFAULT 65536 CHECK (max_body_bytes BETWEEN 1024 AND 1048576),
    last_received_at timestamptz,
    -- Requests without a valid signature are only counted, never journaled
    -- one row per request.
    rejected_count bigint NOT NULL DEFAULT 0 CHECK (rejected_count >= 0),
    last_rejected_at timestamptz,
    last_rejected_code text NOT NULL DEFAULT '' CHECK (length(last_rejected_code) <= 120),
    created_by uuid NOT NULL,
    updated_by uuid NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (org_id, id),
    FOREIGN KEY (org_id, created_by) REFERENCES actors(org_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (org_id, updated_by) REFERENCES actors(org_id, id) ON DELETE RESTRICT
);

-- Reception journal of correctly signed deliveries. An accepted delivery id
-- is unique per webhook, which is the replay guard inside the signed window.
CREATE TABLE integration_webhook_deliveries (
    id uuid PRIMARY KEY,
    org_id uuid NOT NULL,
    webhook_id uuid NOT NULL,
    delivery_id text NOT NULL DEFAULT '' CHECK (length(delivery_id) <= 200),
    event_type text NOT NULL DEFAULT '' CHECK (length(event_type) <= 120),
    status text NOT NULL CHECK (status IN ('accepted', 'rejected')),
    error_code text NOT NULL DEFAULT '' CHECK (length(error_code) <= 120),
    body_bytes integer NOT NULL DEFAULT 0 CHECK (body_bytes >= 0),
    body_sha256 text NOT NULL DEFAULT '' CHECK (length(body_sha256) <= 64),
    runs_created integer NOT NULL DEFAULT 0 CHECK (runs_created >= 0),
    received_at timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY (org_id, webhook_id) REFERENCES integration_webhooks(org_id, id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX integration_webhook_deliveries_replay_idx
    ON integration_webhook_deliveries(webhook_id, delivery_id) WHERE status = 'accepted';
CREATE INDEX integration_webhook_deliveries_recent_idx
    ON integration_webhook_deliveries(webhook_id, received_at DESC);

ALTER TABLE agent_triggers DROP CONSTRAINT agent_triggers_type_check;
ALTER TABLE agent_triggers ADD CONSTRAINT agent_triggers_type_check
    CHECK (type IN ('manual','mention','command','keyword','every_message','schedule','event','webhook'));
CREATE INDEX agent_triggers_webhook_idx ON agent_triggers((config->>'webhook_id'))
    WHERE type = 'webhook' AND superseded_at IS NULL;

-- Structured spreadsheet rows. A table belongs to one indexed version of a
-- knowledge document and is replaced together with its fragments.
ALTER TABLE knowledge_documents ADD COLUMN tables_version integer
    CHECK (tables_version IS NULL OR tables_version > 0);

CREATE TABLE knowledge_tables (
    id uuid PRIMARY KEY,
    org_id uuid NOT NULL,
    collection_id uuid NOT NULL,
    document_id uuid NOT NULL,
    sheet_index integer NOT NULL CHECK (sheet_index >= 0),
    sheet text NOT NULL DEFAULT '' CHECK (length(sheet) <= 255),
    columns jsonb NOT NULL CHECK (jsonb_typeof(columns) = 'array'),
    row_count integer NOT NULL CHECK (row_count >= 0),
    truncated boolean NOT NULL DEFAULT false,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (document_id, sheet_index),
    UNIQUE (org_id, id),
    FOREIGN KEY (org_id, document_id) REFERENCES knowledge_documents(org_id, id) ON DELETE CASCADE,
    FOREIGN KEY (org_id, collection_id) REFERENCES knowledge_collections(org_id, id) ON DELETE CASCADE
);
CREATE INDEX knowledge_tables_collection_idx ON knowledge_tables(org_id, collection_id);

CREATE TABLE knowledge_table_rows (
    org_id uuid NOT NULL,
    table_id uuid NOT NULL,
    row_number integer NOT NULL CHECK (row_number > 0),
    cells jsonb NOT NULL CHECK (jsonb_typeof(cells) = 'array'),
    PRIMARY KEY (table_id, row_number),
    FOREIGN KEY (org_id, table_id) REFERENCES knowledge_tables(org_id, id) ON DELETE CASCADE
);

-- +goose Down
DROP TABLE IF EXISTS knowledge_table_rows;
DROP TABLE IF EXISTS knowledge_tables;
ALTER TABLE knowledge_documents DROP COLUMN IF EXISTS tables_version;

DROP INDEX IF EXISTS agent_triggers_webhook_idx;
ALTER TABLE agent_triggers DROP CONSTRAINT agent_triggers_type_check;
-- Runs started by webhook triggers keep their history without the trigger.
UPDATE agent_runs SET trigger_id = NULL
WHERE trigger_id IN (SELECT id FROM agent_triggers WHERE type = 'webhook');
DELETE FROM agent_triggers WHERE type = 'webhook';
ALTER TABLE agent_triggers ADD CONSTRAINT agent_triggers_type_check
    CHECK (type IN ('manual','mention','command','keyword','every_message','schedule','event'));

DROP TABLE IF EXISTS integration_webhook_deliveries;
DROP TABLE IF EXISTS integration_webhooks;

-- agent_mcp_servers was never modified by the Up step, so previous releases
-- find the per-agent servers exactly as they were before the upgrade.
DROP INDEX IF EXISTS agent_drafts_mcp_bindings_idx;
DROP INDEX IF EXISTS agents_mcp_bindings_idx;
ALTER TABLE agent_drafts DROP COLUMN IF EXISTS mcp_bindings;
ALTER TABLE agents DROP COLUMN IF EXISTS mcp_bindings;
DROP TABLE IF EXISTS integration_mcp_connections;
