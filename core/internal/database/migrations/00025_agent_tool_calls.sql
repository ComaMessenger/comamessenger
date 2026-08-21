-- +goose Up
CREATE TABLE agent_tool_calls (
    id uuid PRIMARY KEY,
    org_id uuid NOT NULL,
    agent_id uuid NOT NULL,
    run_id uuid,
    correlation_id uuid NOT NULL,
    tool_name text NOT NULL CHECK (length(tool_name) BETWEEN 1 AND 120),
    mode text NOT NULL CHECK (mode IN ('read', 'write')),
    required_scope text NOT NULL CHECK (length(required_scope) BETWEEN 1 AND 120),
    input_summary jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(input_summary) = 'object'),
    status text NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'completed', 'failed')),
    output_bytes integer NOT NULL DEFAULT 0 CHECK (output_bytes >= 0),
    error_code text NOT NULL DEFAULT '' CHECK (length(error_code) <= 120),
    started_at timestamptz NOT NULL DEFAULT now(),
    finished_at timestamptz,
    FOREIGN KEY (org_id, agent_id) REFERENCES agents(org_id, actor_id) ON DELETE CASCADE,
    FOREIGN KEY (org_id, run_id) REFERENCES agent_runs(org_id, id) ON DELETE RESTRICT
);

CREATE INDEX agent_tool_calls_agent_started_idx ON agent_tool_calls(agent_id, started_at DESC);
CREATE INDEX agent_tool_calls_run_idx ON agent_tool_calls(run_id, started_at) WHERE run_id IS NOT NULL;
CREATE INDEX agent_tool_calls_correlation_idx ON agent_tool_calls(correlation_id, started_at);

-- +goose Down
DROP TABLE agent_tool_calls;
