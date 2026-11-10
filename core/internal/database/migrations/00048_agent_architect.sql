-- +goose Up
-- The Architect is a per-workspace system agent: it never runs in the agent
-- runtime, it only owns the usage records of the conversations that build
-- other agents. Product queries already exclude every system_role.
ALTER TABLE agents DROP CONSTRAINT IF EXISTS agents_system_role_check;
ALTER TABLE agents ADD CONSTRAINT agents_system_role_check
    CHECK (system_role IS NULL OR system_role IN ('runtime_worker', 'architect'));

-- One conversation of a person with the Architect. It belongs to the person
-- and, once a draft exists, to that agent; it expires after inactivity.
CREATE TABLE agent_architect_sessions (
    id uuid PRIMARY KEY,
    org_id uuid NOT NULL,
    user_id uuid NOT NULL,
    agent_id uuid,
    llm_connection_id uuid,
    locale text NOT NULL DEFAULT 'ru' CHECK (locale IN ('ru', 'en')),
    status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'closed')),
    questions_asked integer NOT NULL DEFAULT 0 CHECK (questions_asked BETWEEN 0 AND 4),
    messages jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(messages) = 'array'),
    transcript jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(transcript) = 'array'),
    test_examples jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(test_examples) = 'array'),
    assumptions jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(assumptions) = 'array'),
    model_calls integer NOT NULL DEFAULT 0 CHECK (model_calls >= 0),
    input_tokens bigint NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
    output_tokens bigint NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
    cost numeric(20,8) NOT NULL DEFAULT 0 CHECK (cost >= 0),
    -- The turn in progress: its owner renews the lease before every model
    -- call and saves only while it still holds the token.
    turn_started_at timestamptz,
    turn_token uuid,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL,
    UNIQUE (org_id, id),
    FOREIGN KEY (org_id, user_id) REFERENCES actors(org_id, id) ON DELETE CASCADE,
    FOREIGN KEY (org_id, agent_id) REFERENCES agents(org_id, actor_id) ON DELETE CASCADE
);

CREATE INDEX agent_architect_sessions_owner_idx
    ON agent_architect_sessions(org_id, user_id, agent_id, updated_at DESC) WHERE status = 'active';
CREATE INDEX agent_architect_sessions_expiry_idx ON agent_architect_sessions(expires_at);

-- Every model call of the Architect, by person. It outlives conversations
-- (closing or deleting one does not reset anyone's allowance) and is the
-- atomic counter for the per-minute rate, failed calls included.
CREATE TABLE agent_architect_calls (
    id uuid PRIMARY KEY,
    org_id uuid NOT NULL,
    user_id uuid NOT NULL,
    session_id uuid NOT NULL,
    status text NOT NULL DEFAULT 'started' CHECK (status IN ('started', 'completed', 'failed')),
    input_tokens bigint NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
    output_tokens bigint NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
    cost numeric(20,8) NOT NULL DEFAULT 0 CHECK (cost >= 0),
    created_at timestamptz NOT NULL,
    finished_at timestamptz,
    FOREIGN KEY (org_id, user_id) REFERENCES actors(org_id, id) ON DELETE CASCADE
);

CREATE INDEX agent_architect_calls_org_idx ON agent_architect_calls(org_id, created_at);
CREATE INDEX agent_architect_calls_user_idx ON agent_architect_calls(org_id, user_id, created_at);

-- +goose Down
DROP TABLE IF EXISTS agent_architect_calls;
DROP TABLE IF EXISTS agent_architect_sessions;
DELETE FROM actors
WHERE id IN (SELECT actor_id FROM agents WHERE system_role='architect');
ALTER TABLE agents DROP CONSTRAINT IF EXISTS agents_system_role_check;
ALTER TABLE agents ADD CONSTRAINT agents_system_role_check
    CHECK (system_role IS NULL OR system_role IN ('runtime_worker'));
