-- +goose Up
ALTER TABLE agents DROP CONSTRAINT agents_allowed_scopes_check;
ALTER TABLE agents ADD CONSTRAINT agents_allowed_scopes_check CHECK (allowed_scopes <@ ARRAY[
    'chats:read', 'messages:read', 'messages:write', 'reactions:write',
    'files:read', 'search:read', 'members:read', 'memory:read', 'memory:write', 'runtime:execute'
]::text[]);
ALTER TABLE agent_api_keys DROP CONSTRAINT agent_api_keys_scopes_check;
ALTER TABLE agent_api_keys ADD CONSTRAINT agent_api_keys_scopes_check CHECK (scopes <@ ARRAY[
    'chats:read', 'messages:read', 'messages:write', 'reactions:write',
    'files:read', 'search:read', 'members:read', 'memory:read', 'memory:write', 'runtime:execute'
]::text[]);

CREATE TABLE agent_provider_calls (
    id uuid PRIMARY KEY,
    org_id uuid NOT NULL,
    agent_id uuid NOT NULL,
    run_id uuid NOT NULL,
    correlation_id uuid NOT NULL,
    provider text NOT NULL CHECK (length(provider) BETWEEN 1 AND 100),
    model text NOT NULL CHECK (length(model) BETWEEN 1 AND 200),
    status text NOT NULL DEFAULT 'started' CHECK (status IN ('started','completed','failed')),
    reserved_cost numeric(20,8) NOT NULL CHECK (reserved_cost >= 0),
    actual_cost numeric(20,8),
    currency char(3) NOT NULL DEFAULT 'USD',
    input_tokens bigint NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
    output_tokens bigint NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
    price_source text NOT NULL DEFAULT 'unknown' CHECK (price_source IN ('provider','configured','estimated','unknown')),
    created_at timestamptz NOT NULL DEFAULT now(),
    finished_at timestamptz,
    FOREIGN KEY (org_id, agent_id) REFERENCES agents(org_id, actor_id) ON DELETE CASCADE,
    FOREIGN KEY (org_id, run_id) REFERENCES agent_runs(org_id, id) ON DELETE CASCADE
);

CREATE INDEX agent_provider_calls_budget_idx ON agent_provider_calls(agent_id, created_at, status);
CREATE INDEX agent_provider_calls_run_idx ON agent_provider_calls(run_id, created_at);

-- +goose Down
DROP TABLE agent_provider_calls;
ALTER TABLE agent_api_keys DROP CONSTRAINT agent_api_keys_scopes_check;
ALTER TABLE agent_api_keys ADD CONSTRAINT agent_api_keys_scopes_check CHECK (scopes <@ ARRAY[
    'chats:read', 'messages:read', 'messages:write', 'reactions:write',
    'files:read', 'search:read', 'members:read', 'memory:read', 'memory:write'
]::text[]);
ALTER TABLE agents DROP CONSTRAINT agents_allowed_scopes_check;
ALTER TABLE agents ADD CONSTRAINT agents_allowed_scopes_check CHECK (allowed_scopes <@ ARRAY[
    'chats:read', 'messages:read', 'messages:write', 'reactions:write',
    'files:read', 'search:read', 'members:read', 'memory:read', 'memory:write'
]::text[]);
