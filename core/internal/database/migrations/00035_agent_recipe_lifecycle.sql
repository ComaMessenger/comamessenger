-- +goose Up
ALTER TABLE agent_triggers ADD COLUMN superseded_at timestamptz;
CREATE INDEX agent_triggers_current_idx ON agent_triggers(agent_id, created_at) WHERE superseded_at IS NULL;

-- +goose Down
DROP INDEX IF EXISTS agent_triggers_current_idx;
ALTER TABLE agent_triggers DROP COLUMN IF EXISTS superseded_at;
