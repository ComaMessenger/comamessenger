-- +goose Up
CREATE TABLE notification_snoozes (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    org_id uuid NOT NULL,
    actor_id uuid NOT NULL,
    starts_at timestamptz NOT NULL,
    ends_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    CHECK (ends_at > starts_at),
    FOREIGN KEY (org_id, actor_id) REFERENCES actors(org_id, id) ON DELETE CASCADE,
    FOREIGN KEY (actor_id) REFERENCES users(actor_id) ON DELETE CASCADE
);

CREATE INDEX notification_snoozes_actor_interval_idx
    ON notification_snoozes(org_id, actor_id, starts_at, ends_at);

-- +goose Down
DROP TABLE IF EXISTS notification_snoozes;
