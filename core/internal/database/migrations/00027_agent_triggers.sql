-- +goose Up
ALTER TABLE agent_triggers ADD COLUMN next_run_at timestamptz;
ALTER TABLE agent_runs ADD COLUMN scheduled_for timestamptz;
CREATE UNIQUE INDEX agent_runs_schedule_delivery_idx ON agent_runs(trigger_id, scheduled_for) WHERE trigger_id IS NOT NULL AND scheduled_for IS NOT NULL;
CREATE INDEX agent_triggers_schedule_due_idx ON agent_triggers(next_run_at) WHERE enabled AND type='schedule';

CREATE TABLE message_agent_provenance (
    message_id uuid PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
    org_id uuid NOT NULL,
    agent_id uuid NOT NULL,
    run_id uuid NOT NULL,
    correlation_id uuid NOT NULL,
    chain_depth smallint NOT NULL CHECK (chain_depth BETWEEN 0 AND 16),
    created_at timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY (org_id, agent_id) REFERENCES agents(org_id, actor_id) ON DELETE CASCADE,
    FOREIGN KEY (org_id, run_id) REFERENCES agent_runs(org_id, id) ON DELETE RESTRICT
);

-- +goose Down
DROP TABLE message_agent_provenance;
DROP INDEX agent_triggers_schedule_due_idx;
DROP INDEX agent_runs_schedule_delivery_idx;
ALTER TABLE agent_runs DROP COLUMN scheduled_for;
ALTER TABLE agent_triggers DROP COLUMN next_run_at;
