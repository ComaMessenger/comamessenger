-- +goose Up
ALTER TABLE organizations
    ADD COLUMN agent_rate_limit_per_minute integer NOT NULL DEFAULT 10000
    CHECK (agent_rate_limit_per_minute BETWEEN 1 AND 1000000);

ALTER TABLE agents
    ADD COLUMN provider_rate_limit_per_minute integer NOT NULL DEFAULT 300
    CHECK (provider_rate_limit_per_minute BETWEEN 1 AND 100000);

CREATE TABLE agent_rate_limit_buckets (
    org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    dimension text NOT NULL CHECK (dimension IN ('organization', 'agent', 'key', 'provider')),
    subject text NOT NULL CHECK (length(subject) BETWEEN 1 AND 300),
    window_start timestamptz NOT NULL,
    request_count integer NOT NULL CHECK (request_count > 0),
    PRIMARY KEY (org_id, dimension, subject, window_start)
);

CREATE INDEX agent_rate_limit_buckets_expiry_idx ON agent_rate_limit_buckets(window_start);

-- +goose Down
DROP TABLE agent_rate_limit_buckets;
ALTER TABLE agents DROP COLUMN provider_rate_limit_per_minute;
ALTER TABLE organizations DROP COLUMN agent_rate_limit_per_minute;
