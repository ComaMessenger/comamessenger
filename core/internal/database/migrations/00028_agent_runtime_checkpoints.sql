-- +goose Up
CREATE TABLE agent_runtime_checkpoints (
    org_id uuid NOT NULL,
    agent_id uuid NOT NULL,
    consumer text NOT NULL CHECK (consumer ~ '^[a-z0-9][a-z0-9_.-]{0,63}$'),
    last_event_seq bigint NOT NULL CHECK (last_event_seq >= 0),
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (agent_id, consumer),
    FOREIGN KEY (org_id, agent_id) REFERENCES agents(org_id, actor_id) ON DELETE CASCADE
);

-- +goose Down
DROP TABLE agent_runtime_checkpoints;
