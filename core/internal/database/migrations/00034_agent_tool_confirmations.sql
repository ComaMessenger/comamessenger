-- +goose Up
ALTER TABLE agent_runs ADD COLUMN published_message_id uuid;
CREATE UNIQUE INDEX agent_runs_published_message_idx ON agent_runs(published_message_id) WHERE published_message_id IS NOT NULL;

CREATE TABLE agent_tool_confirmations (
    id uuid PRIMARY KEY,
    org_id uuid NOT NULL,
    agent_id uuid NOT NULL,
    run_id uuid NOT NULL,
    tool_call_id uuid NOT NULL,
    correlation_id uuid NOT NULL,
    tool_name text NOT NULL CHECK (length(tool_name) BETWEEN 1 AND 120),
    required_scope text NOT NULL CHECK (length(required_scope) BETWEEN 1 AND 120),
    arguments jsonb NOT NULL CHECK (jsonb_typeof(arguments) = 'object'),
    status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'denied', 'completed', 'failed', 'expired')),
    result jsonb,
    error_code text NOT NULL DEFAULT '' CHECK (length(error_code) <= 120),
    requested_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL DEFAULT (now() + interval '24 hours'),
    decided_at timestamptz,
    decided_by uuid,
    completed_at timestamptz,
    UNIQUE (org_id, run_id, tool_call_id),
    FOREIGN KEY (org_id, agent_id) REFERENCES agents(org_id, actor_id) ON DELETE RESTRICT,
    FOREIGN KEY (org_id, run_id) REFERENCES agent_runs(org_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (org_id, decided_by) REFERENCES actors(org_id, id) ON DELETE RESTRICT
);

CREATE INDEX agent_tool_confirmations_pending_idx
    ON agent_tool_confirmations(org_id, requested_at DESC)
    WHERE status = 'pending';

-- +goose Down
DROP TABLE IF EXISTS agent_tool_confirmations;
DROP INDEX IF EXISTS agent_runs_published_message_idx;
ALTER TABLE agent_runs DROP COLUMN IF EXISTS published_message_id;
