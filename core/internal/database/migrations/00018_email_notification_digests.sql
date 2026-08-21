-- +goose Up
CREATE TABLE email_digest_items (
    org_id uuid NOT NULL,
    event_seq bigint NOT NULL,
    actor_id uuid NOT NULL,
    available_at timestamptz NOT NULL,
    attempts integer NOT NULL DEFAULT 0,
    sent_at timestamptz,
    last_error text,
    lease_token uuid,
    lease_until timestamptz,
    PRIMARY KEY (org_id, event_seq, actor_id),
    FOREIGN KEY (org_id, event_seq) REFERENCES events(org_id, seq) ON DELETE CASCADE,
    FOREIGN KEY (org_id, actor_id) REFERENCES actors(org_id, id) ON DELETE CASCADE,
    FOREIGN KEY (actor_id) REFERENCES users(actor_id) ON DELETE CASCADE
);

CREATE INDEX email_digest_items_pending_idx
    ON email_digest_items(available_at, lease_until) WHERE sent_at IS NULL;

-- +goose Down
DROP TABLE IF EXISTS email_digest_items;
