-- +goose Up
ALTER TABLE agents DROP CONSTRAINT agents_check;
ALTER TABLE agents ADD CONSTRAINT agents_endpoint_kind_check CHECK (
    kind = 'external' OR endpoint_url = '' OR provider = 'openai-compatible'
);

-- +goose Down
ALTER TABLE agents DROP CONSTRAINT agents_endpoint_kind_check;
ALTER TABLE agents ADD CONSTRAINT agents_check CHECK (
    (kind = 'builtin' AND endpoint_url = '') OR kind = 'external'
);
