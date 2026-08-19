-- +goose Up
CREATE TABLE web_push_subscriptions (
    id uuid PRIMARY KEY,
    org_id uuid NOT NULL,
    actor_id uuid NOT NULL,
    session_id uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    endpoint text NOT NULL CHECK (length(endpoint) BETWEEN 16 AND 4096),
    p256dh text NOT NULL CHECK (length(p256dh) BETWEEN 16 AND 512),
    auth text NOT NULL CHECK (length(auth) BETWEEN 8 AND 256),
    user_agent text NOT NULL DEFAULT '',
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (actor_id, endpoint),
    FOREIGN KEY (org_id, actor_id) REFERENCES actors(org_id, id) ON DELETE CASCADE
);
CREATE INDEX web_push_actor_idx ON web_push_subscriptions(org_id, actor_id);
CREATE TABLE notification_jobs (
    org_id uuid NOT NULL,
    event_seq bigint NOT NULL,
    available_at timestamptz NOT NULL DEFAULT now(),
    attempts integer NOT NULL DEFAULT 0,
    last_error text,
    PRIMARY KEY (org_id, event_seq),
    FOREIGN KEY (org_id, event_seq) REFERENCES events(org_id, seq) ON DELETE CASCADE
);
CREATE TABLE notification_deliveries (
    org_id uuid NOT NULL,
    event_seq bigint NOT NULL,
    subscription_id uuid NOT NULL REFERENCES web_push_subscriptions(id) ON DELETE CASCADE,
    available_at timestamptz NOT NULL DEFAULT now(),
    attempts integer NOT NULL DEFAULT 0,
    sent_at timestamptz,
    last_error text,
    lease_token uuid,
    lease_until timestamptz,
    PRIMARY KEY (org_id, event_seq, subscription_id),
    FOREIGN KEY (org_id, event_seq) REFERENCES events(org_id, seq) ON DELETE CASCADE
);
CREATE INDEX notification_deliveries_pending_idx ON notification_deliveries(available_at, lease_until) WHERE sent_at IS NULL;
-- +goose Down
DROP TABLE IF EXISTS notification_deliveries;
DROP TABLE IF EXISTS notification_jobs;
DROP TABLE IF EXISTS web_push_subscriptions;
