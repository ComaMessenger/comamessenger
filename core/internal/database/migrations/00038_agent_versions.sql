-- +goose Up
ALTER TABLE agents
    ADD COLUMN operational_status text NOT NULL DEFAULT 'draft'
        CHECK (operational_status IN ('draft', 'active', 'paused', 'needs_attention')),
    ADD COLUMN published_version integer CHECK (published_version IS NULL OR published_version > 0),
    ADD COLUMN published_at timestamptz;

CREATE TABLE agent_drafts (
    org_id uuid NOT NULL,
    agent_id uuid PRIMARY KEY,
    version integer NOT NULL CHECK (version > 0),
    recipe text NOT NULL CHECK (recipe IN ('custom', 'summarizer', 'qa', 'onboarding')),
    description text NOT NULL DEFAULT '' CHECK (length(description) <= 2000),
    allowed_scopes text[] NOT NULL DEFAULT '{}'::text[],
    llm_connection_id uuid,
    provider text NOT NULL DEFAULT '' CHECK (length(provider) <= 100),
    model text NOT NULL DEFAULT '' CHECK (length(model) <= 200),
    endpoint_url text NOT NULL DEFAULT '' CHECK (length(endpoint_url) <= 2048),
    external_data_sharing_approved boolean NOT NULL DEFAULT false,
    daily_cost_limit numeric(20,8) CHECK (daily_cost_limit IS NULL OR daily_cost_limit >= 0),
    monthly_cost_limit numeric(20,8) CHECK (monthly_cost_limit IS NULL OR monthly_cost_limit >= 0),
    max_output_tokens integer NOT NULL CHECK (max_output_tokens BETWEEN 1 AND 1000000),
    max_tool_iterations smallint NOT NULL CHECK (max_tool_iterations BETWEEN 0 AND 64),
    max_chain_depth smallint NOT NULL CHECK (max_chain_depth BETWEEN 0 AND 16),
    per_chat_concurrency smallint NOT NULL CHECK (per_chat_concurrency BETWEEN 1 AND 32),
    rate_limit_per_minute integer NOT NULL CHECK (rate_limit_per_minute BETWEEN 1 AND 100000),
    provider_rate_limit_per_minute integer NOT NULL CHECK (provider_rate_limit_per_minute BETWEEN 1 AND 100000),
    execution_timeout_seconds integer NOT NULL CHECK (execution_timeout_seconds BETWEEN 30 AND 3600),
    chat_ids uuid[] NOT NULL DEFAULT '{}'::uuid[],
    created_by uuid NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY (org_id, agent_id) REFERENCES agents(org_id, actor_id) ON DELETE CASCADE,
    FOREIGN KEY (org_id, created_by) REFERENCES actors(org_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (org_id, llm_connection_id) REFERENCES agent_llm_connections(org_id, id) ON DELETE RESTRICT
);

CREATE TABLE agent_versions (
    id uuid PRIMARY KEY,
    org_id uuid NOT NULL,
    agent_id uuid NOT NULL,
    version integer NOT NULL CHECK (version > 0),
    config jsonb NOT NULL CHECK (jsonb_typeof(config) = 'object'),
    created_by uuid NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    published_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (agent_id, version),
    UNIQUE (org_id, id),
    FOREIGN KEY (org_id, agent_id) REFERENCES agents(org_id, actor_id) ON DELETE CASCADE,
    FOREIGN KEY (org_id, created_by) REFERENCES actors(org_id, id) ON DELETE RESTRICT
);

ALTER TABLE agent_runs
    ADD COLUMN agent_version integer CHECK (agent_version IS NULL OR agent_version > 0);

INSERT INTO agent_drafts (
    org_id,agent_id,version,recipe,description,allowed_scopes,llm_connection_id,provider,model,endpoint_url,
    external_data_sharing_approved,daily_cost_limit,monthly_cost_limit,max_output_tokens,max_tool_iterations,
    max_chain_depth,per_chat_concurrency,rate_limit_per_minute,provider_rate_limit_per_minute,
    execution_timeout_seconds,chat_ids,created_by,created_at,updated_at
)
SELECT agent.org_id,agent.actor_id,1,agent.recipe,agent.description,agent.allowed_scopes,agent.llm_connection_id,
       agent.provider,agent.model,agent.endpoint_url,agent.external_data_sharing_approved,agent.daily_cost_limit,
       agent.monthly_cost_limit,agent.max_output_tokens,agent.max_tool_iterations,agent.max_chain_depth,
       agent.per_chat_concurrency,agent.rate_limit_per_minute,agent.provider_rate_limit_per_minute,
       agent.execution_timeout_seconds,
       COALESCE((SELECT array_agg(member.chat_id ORDER BY member.chat_id) FROM chat_members member
                 WHERE member.org_id=agent.org_id AND member.actor_id=agent.actor_id),'{}'::uuid[]),
       agent.owner_actor_id,agent.created_at,agent.updated_at
FROM agents agent
WHERE agent.deleted_at IS NULL AND NOT agent.enabled;

INSERT INTO agent_versions (id,org_id,agent_id,version,config,created_by,created_at,published_at)
SELECT gen_random_uuid(),agent.org_id,agent.actor_id,1,
       jsonb_build_object(
           'recipe',agent.recipe,'description',agent.description,'allowed_scopes',to_jsonb(agent.allowed_scopes),
           'llm_connection_id',agent.llm_connection_id,'provider',agent.provider,'model',agent.model,
           'endpoint_url',agent.endpoint_url,'external_data_sharing_approved',agent.external_data_sharing_approved,
           'daily_cost_limit',agent.daily_cost_limit::text,'monthly_cost_limit',agent.monthly_cost_limit::text,
           'max_output_tokens',agent.max_output_tokens,'max_tool_iterations',agent.max_tool_iterations,
           'max_chain_depth',agent.max_chain_depth,'per_chat_concurrency',agent.per_chat_concurrency,
           'rate_limit_per_minute',agent.rate_limit_per_minute,
           'provider_rate_limit_per_minute',agent.provider_rate_limit_per_minute,
           'execution_timeout_seconds',agent.execution_timeout_seconds,
           'chat_ids',to_jsonb(COALESCE((SELECT array_agg(member.chat_id ORDER BY member.chat_id)
                    FROM chat_members member WHERE member.org_id=agent.org_id AND member.actor_id=agent.actor_id),'{}'::uuid[]))
       ),agent.owner_actor_id,agent.created_at,agent.updated_at
FROM agents agent
WHERE agent.deleted_at IS NULL AND agent.enabled;

UPDATE agents
SET operational_status=CASE WHEN enabled THEN 'active' ELSE 'draft' END,
    published_version=CASE WHEN enabled THEN 1 ELSE NULL END,
    published_at=CASE WHEN enabled THEN updated_at ELSE NULL END;

UPDATE agent_runs run
SET agent_version=agent.published_version
FROM agents agent
WHERE agent.org_id=run.org_id AND agent.actor_id=run.agent_id AND agent.published_version IS NOT NULL;

CREATE INDEX agent_versions_agent_published_idx ON agent_versions(agent_id,version DESC);
CREATE INDEX agent_drafts_org_updated_idx ON agent_drafts(org_id,updated_at DESC);

-- +goose Down
DROP INDEX IF EXISTS agent_drafts_org_updated_idx;
DROP INDEX IF EXISTS agent_versions_agent_published_idx;
ALTER TABLE agent_runs DROP COLUMN IF EXISTS agent_version;
DROP TABLE IF EXISTS agent_versions;
DROP TABLE IF EXISTS agent_drafts;
ALTER TABLE agents
    DROP COLUMN IF EXISTS published_at,
    DROP COLUMN IF EXISTS published_version,
    DROP COLUMN IF EXISTS operational_status;
