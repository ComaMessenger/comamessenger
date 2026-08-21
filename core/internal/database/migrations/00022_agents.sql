-- +goose Up
ALTER TABLE actor_permissions DROP CONSTRAINT actor_permissions_permission_check;
ALTER TABLE actor_permissions ADD CONSTRAINT actor_permissions_permission_check CHECK (permission IN (
    'members.manage',
    'invitations.manage',
    'workspace.settings',
    'workspace.policies',
    'branding.manage',
    'integrations.manage',
    'agents.manage',
    'audit.read',
    'chats.moderate'
));

INSERT INTO actor_permissions (org_id, actor_id, permission, granted_by)
SELECT admin.org_id, admin.id, 'agents.manage', owner.id
FROM actors admin
JOIN LATERAL (
    SELECT id FROM actors
    WHERE org_id = admin.org_id AND org_role = 'owner' AND status = 'active' AND deleted_at IS NULL
    ORDER BY created_at, id LIMIT 1
) owner ON true
WHERE admin.org_role = 'admin' AND admin.status = 'active' AND admin.deleted_at IS NULL
ON CONFLICT DO NOTHING;

CREATE TABLE agents (
    actor_id uuid PRIMARY KEY,
    org_id uuid NOT NULL,
    owner_actor_id uuid NOT NULL,
    kind text NOT NULL CHECK (kind IN ('builtin', 'external')),
    description text NOT NULL DEFAULT '' CHECK (length(description) <= 2000),
    enabled boolean NOT NULL DEFAULT false,
    allowed_scopes text[] NOT NULL DEFAULT '{}'::text[] CHECK (allowed_scopes <@ ARRAY[
        'chats:read', 'messages:read', 'messages:write', 'reactions:write',
        'files:read', 'search:read', 'members:read', 'memory:read', 'memory:write'
    ]::text[]),
    provider text NOT NULL DEFAULT '' CHECK (length(provider) <= 100),
    model text NOT NULL DEFAULT '' CHECK (length(model) <= 200),
    endpoint_url text NOT NULL DEFAULT '' CHECK (length(endpoint_url) <= 2048),
    provider_config jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(provider_config) = 'object'),
    external_data_sharing_approved boolean NOT NULL DEFAULT false,
    daily_cost_limit numeric(20,8) CHECK (daily_cost_limit IS NULL OR daily_cost_limit >= 0),
    monthly_cost_limit numeric(20,8) CHECK (monthly_cost_limit IS NULL OR monthly_cost_limit >= 0),
    max_output_tokens integer NOT NULL DEFAULT 2048 CHECK (max_output_tokens BETWEEN 1 AND 1000000),
    max_tool_iterations smallint NOT NULL DEFAULT 8 CHECK (max_tool_iterations BETWEEN 0 AND 64),
    max_chain_depth smallint NOT NULL DEFAULT 3 CHECK (max_chain_depth BETWEEN 0 AND 16),
    per_chat_concurrency smallint NOT NULL DEFAULT 1 CHECK (per_chat_concurrency BETWEEN 1 AND 32),
    rate_limit_per_minute integer NOT NULL DEFAULT 60 CHECK (rate_limit_per_minute BETWEEN 1 AND 100000),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (org_id, actor_id),
    FOREIGN KEY (org_id, actor_id) REFERENCES actors(org_id, id) ON DELETE CASCADE,
    FOREIGN KEY (org_id, owner_actor_id) REFERENCES actors(org_id, id) ON DELETE RESTRICT,
    CHECK ((kind = 'builtin' AND endpoint_url = '') OR kind = 'external')
);

CREATE INDEX agents_org_enabled_idx ON agents(org_id, enabled, created_at DESC);
CREATE INDEX agents_owner_idx ON agents(owner_actor_id, created_at DESC);

CREATE TABLE agent_provider_credentials (
    agent_id uuid PRIMARY KEY REFERENCES agents(actor_id) ON DELETE CASCADE,
    org_id uuid NOT NULL,
    key_version smallint NOT NULL DEFAULT 1 CHECK (key_version > 0),
    nonce bytea NOT NULL CHECK (octet_length(nonce) = 12),
    ciphertext bytea NOT NULL CHECK (octet_length(ciphertext) >= 16),
    updated_by uuid NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY (org_id, agent_id) REFERENCES agents(org_id, actor_id) ON DELETE CASCADE,
    FOREIGN KEY (org_id, updated_by) REFERENCES actors(org_id, id) ON DELETE RESTRICT
);

CREATE TABLE agent_api_keys (
    id uuid PRIMARY KEY,
    org_id uuid NOT NULL,
    agent_id uuid NOT NULL,
    name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 120),
    key_hash bytea NOT NULL UNIQUE CHECK (octet_length(key_hash) = 32),
    key_prefix text NOT NULL CHECK (length(key_prefix) BETWEEN 12 AND 80),
    scopes text[] NOT NULL CHECK (scopes <@ ARRAY[
        'chats:read', 'messages:read', 'messages:write', 'reactions:write',
        'files:read', 'search:read', 'members:read', 'memory:read', 'memory:write'
    ]::text[]),
    rate_limit_per_minute integer NOT NULL DEFAULT 60 CHECK (rate_limit_per_minute BETWEEN 1 AND 100000),
    created_by uuid NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    last_used_at timestamptz,
    expires_at timestamptz,
    revoked_at timestamptz,
    FOREIGN KEY (org_id, agent_id) REFERENCES agents(org_id, actor_id) ON DELETE CASCADE,
    FOREIGN KEY (org_id, created_by) REFERENCES actors(org_id, id) ON DELETE RESTRICT,
    CHECK (expires_at IS NULL OR expires_at > created_at)
);

CREATE INDEX agent_api_keys_active_idx ON agent_api_keys(agent_id, created_at DESC)
    WHERE revoked_at IS NULL;

CREATE TABLE agent_triggers (
    id uuid PRIMARY KEY,
    org_id uuid NOT NULL,
    agent_id uuid NOT NULL,
    type text NOT NULL CHECK (type IN ('mention', 'command', 'keyword', 'every_message', 'schedule', 'event')),
    config jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(config) = 'object'),
    enabled boolean NOT NULL DEFAULT true,
    timezone text NOT NULL DEFAULT 'UTC' CHECK (length(timezone) BETWEEN 1 AND 64),
    missed_runs_policy text NOT NULL DEFAULT 'skip' CHECK (missed_runs_policy IN ('skip', 'latest')),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (org_id, id),
    FOREIGN KEY (org_id, agent_id) REFERENCES agents(org_id, actor_id) ON DELETE CASCADE
);

CREATE INDEX agent_triggers_enabled_idx ON agent_triggers(agent_id, type) WHERE enabled;

CREATE TABLE agent_runs (
    id uuid PRIMARY KEY,
    org_id uuid NOT NULL,
    agent_id uuid NOT NULL,
    trigger_id uuid,
    trigger_event_seq bigint CHECK (trigger_event_seq IS NULL OR trigger_event_seq > 0),
    chat_id uuid,
    thread_root_id uuid,
    requested_by uuid,
    client_run_id uuid,
    correlation_id uuid NOT NULL UNIQUE,
    chain_depth smallint NOT NULL DEFAULT 0 CHECK (chain_depth BETWEEN 0 AND 16),
    status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'completed', 'failed', 'canceled', 'timed_out')),
    provider text NOT NULL DEFAULT '' CHECK (length(provider) <= 100),
    model text NOT NULL DEFAULT '' CHECK (length(model) <= 200),
    input_tokens bigint NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
    output_tokens bigint NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
    cost numeric(20,8) NOT NULL DEFAULT 0 CHECK (cost >= 0),
    currency char(3) NOT NULL DEFAULT 'USD',
    error_code text NOT NULL DEFAULT '' CHECK (length(error_code) <= 120),
    attempt smallint NOT NULL DEFAULT 1 CHECK (attempt BETWEEN 1 AND 100),
    created_at timestamptz NOT NULL DEFAULT now(),
    started_at timestamptz,
    finished_at timestamptz,
    cancel_requested_at timestamptz,
    UNIQUE (agent_id, client_run_id),
    UNIQUE (org_id, id),
    FOREIGN KEY (org_id, agent_id) REFERENCES agents(org_id, actor_id) ON DELETE CASCADE,
    FOREIGN KEY (org_id, trigger_id) REFERENCES agent_triggers(org_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (org_id, chat_id) REFERENCES chats(org_id, id) ON DELETE CASCADE,
    FOREIGN KEY (org_id, requested_by) REFERENCES actors(org_id, id) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX agent_runs_trigger_delivery_idx
    ON agent_runs(agent_id, trigger_id, trigger_event_seq)
    WHERE trigger_id IS NOT NULL AND trigger_event_seq IS NOT NULL;
CREATE INDEX agent_runs_agent_created_idx ON agent_runs(agent_id, created_at DESC);
CREATE INDEX agent_runs_queue_idx ON agent_runs(status, created_at) WHERE status IN ('queued', 'running');

CREATE TABLE agent_usage (
    id uuid PRIMARY KEY,
    org_id uuid NOT NULL,
    agent_id uuid NOT NULL,
    run_id uuid,
    correlation_id uuid NOT NULL,
    provider text NOT NULL CHECK (length(provider) BETWEEN 1 AND 100),
    model text NOT NULL CHECK (length(model) BETWEEN 1 AND 200),
    input_tokens bigint NOT NULL CHECK (input_tokens >= 0),
    output_tokens bigint NOT NULL CHECK (output_tokens >= 0),
    cost numeric(20,8) NOT NULL CHECK (cost >= 0),
    currency char(3) NOT NULL DEFAULT 'USD',
    price_source text NOT NULL CHECK (price_source IN ('provider', 'configured', 'estimated', 'unknown')),
    created_at timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY (org_id, agent_id) REFERENCES agents(org_id, actor_id) ON DELETE CASCADE,
    FOREIGN KEY (org_id, run_id) REFERENCES agent_runs(org_id, id) ON DELETE RESTRICT
);

CREATE INDEX agent_usage_agent_created_idx ON agent_usage(agent_id, created_at DESC);
CREATE INDEX agent_usage_org_created_idx ON agent_usage(org_id, created_at DESC);

CREATE TABLE agent_memory (
    org_id uuid NOT NULL,
    agent_id uuid NOT NULL,
    namespace text NOT NULL DEFAULT 'default' CHECK (namespace ~ '^[a-z0-9][a-z0-9_.-]{0,63}$'),
    key text NOT NULL CHECK (length(key) BETWEEN 1 AND 255),
    value jsonb NOT NULL,
    embedding_model text,
    embedding_dimensions integer CHECK (embedding_dimensions BETWEEN 1 AND 4096),
    embedding vector,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (agent_id, namespace, key),
    FOREIGN KEY (org_id, agent_id) REFERENCES agents(org_id, actor_id) ON DELETE CASCADE,
    CHECK ((embedding IS NULL) = (embedding_dimensions IS NULL)),
    CHECK (embedding IS NULL OR vector_dims(embedding) = embedding_dimensions)
);

CREATE INDEX agent_memory_org_agent_idx ON agent_memory(org_id, agent_id, namespace);

CREATE TABLE agent_checkpoints (
    org_id uuid NOT NULL,
    agent_id uuid PRIMARY KEY,
    last_event_seq bigint NOT NULL DEFAULT 0 CHECK (last_event_seq >= 0),
    updated_at timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY (org_id, agent_id) REFERENCES agents(org_id, actor_id) ON DELETE CASCADE
);

CREATE TABLE agent_mcp_servers (
    id uuid PRIMARY KEY,
    org_id uuid NOT NULL,
    agent_id uuid NOT NULL,
    name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 120),
    endpoint_url text NOT NULL CHECK (length(endpoint_url) BETWEEN 1 AND 2048),
    enabled boolean NOT NULL DEFAULT false,
    allowed_tools text[] NOT NULL DEFAULT '{}'::text[],
    encrypted_headers bytea,
    timeout_ms integer NOT NULL DEFAULT 10000 CHECK (timeout_ms BETWEEN 100 AND 120000),
    max_output_bytes integer NOT NULL DEFAULT 262144 CHECK (max_output_bytes BETWEEN 1024 AND 4194304),
    require_write_confirmation boolean NOT NULL DEFAULT true,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY (org_id, agent_id) REFERENCES agents(org_id, actor_id) ON DELETE CASCADE,
    UNIQUE (agent_id, name)
);

-- +goose Down
DROP TABLE IF EXISTS agent_mcp_servers;
DROP TABLE IF EXISTS agent_checkpoints;
DROP TABLE IF EXISTS agent_memory;
DROP TABLE IF EXISTS agent_usage;
DROP TABLE IF EXISTS agent_runs;
DROP TABLE IF EXISTS agent_triggers;
DROP TABLE IF EXISTS agent_api_keys;
DROP TABLE IF EXISTS agent_provider_credentials;
DROP TABLE IF EXISTS agents;
DELETE FROM actor_permissions WHERE permission = 'agents.manage';
ALTER TABLE actor_permissions DROP CONSTRAINT actor_permissions_permission_check;
ALTER TABLE actor_permissions ADD CONSTRAINT actor_permissions_permission_check CHECK (permission IN (
    'members.manage',
    'invitations.manage',
    'workspace.settings',
    'workspace.policies',
    'branding.manage',
    'integrations.manage',
    'audit.read',
    'chats.moderate'
));
