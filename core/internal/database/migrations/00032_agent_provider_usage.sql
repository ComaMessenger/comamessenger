-- +goose Up
ALTER TABLE agent_usage ADD COLUMN provider_call_id uuid;
ALTER TABLE agent_usage ADD CONSTRAINT agent_usage_provider_call_fk
    FOREIGN KEY (provider_call_id) REFERENCES agent_provider_calls(id) ON DELETE RESTRICT;
CREATE UNIQUE INDEX agent_usage_provider_call_unique
    ON agent_usage(provider_call_id) WHERE provider_call_id IS NOT NULL;

-- +goose Down
DROP INDEX agent_usage_provider_call_unique;
ALTER TABLE agent_usage DROP CONSTRAINT agent_usage_provider_call_fk;
ALTER TABLE agent_usage DROP COLUMN provider_call_id;
