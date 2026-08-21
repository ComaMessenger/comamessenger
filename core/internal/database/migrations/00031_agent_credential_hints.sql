-- +goose Up
ALTER TABLE agent_provider_credentials
    ADD COLUMN key_hint text NOT NULL DEFAULT ''
    CHECK (length(key_hint) <= 32);

-- +goose Down
ALTER TABLE agent_provider_credentials DROP COLUMN key_hint;
