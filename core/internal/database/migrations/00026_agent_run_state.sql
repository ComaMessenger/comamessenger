-- +goose Up
ALTER TABLE agent_runs
    ADD COLUMN input jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(input) = 'object'),
    ADD COLUMN result_summary jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(result_summary) = 'object'),
    ADD COLUMN lease_token uuid,
    ADD COLUMN lease_expires_at timestamptz,
    ADD COLUMN timeout_at timestamptz,
    ADD COLUMN next_attempt_at timestamptz NOT NULL DEFAULT now(),
    ADD COLUMN max_attempts smallint NOT NULL DEFAULT 3 CHECK (max_attempts BETWEEN 1 AND 20),
    ADD CONSTRAINT agent_runs_lease_state_check CHECK (
        (status = 'running' AND lease_token IS NOT NULL AND lease_expires_at IS NOT NULL AND started_at IS NOT NULL)
        OR (status <> 'running' AND lease_token IS NULL AND lease_expires_at IS NULL)
    );

DROP INDEX agent_runs_queue_idx;
CREATE INDEX agent_runs_queue_idx ON agent_runs(next_attempt_at, created_at) WHERE status = 'queued';
CREATE INDEX agent_runs_lease_expiry_idx ON agent_runs(lease_expires_at) WHERE status = 'running';
CREATE INDEX agent_runs_chat_active_idx ON agent_runs(agent_id, chat_id) WHERE status = 'running';

-- +goose Down
DROP INDEX agent_runs_chat_active_idx;
DROP INDEX agent_runs_lease_expiry_idx;
DROP INDEX agent_runs_queue_idx;
CREATE INDEX agent_runs_queue_idx ON agent_runs(status, created_at) WHERE status IN ('queued', 'running');
ALTER TABLE agent_runs
    DROP CONSTRAINT agent_runs_lease_state_check,
    DROP COLUMN max_attempts,
    DROP COLUMN next_attempt_at,
    DROP COLUMN timeout_at,
    DROP COLUMN lease_expires_at,
    DROP COLUMN lease_token,
    DROP COLUMN result_summary,
    DROP COLUMN input;
