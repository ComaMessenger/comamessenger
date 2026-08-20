-- +goose Up
CREATE TABLE email_change_tokens (
    id uuid PRIMARY KEY,
    org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    actor_id uuid NOT NULL REFERENCES users(actor_id) ON DELETE CASCADE,
    new_email citext NOT NULL,
    token_hash bytea NOT NULL UNIQUE CHECK (octet_length(token_hash) = 32),
    created_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL,
    used_at timestamptz,
    CHECK (expires_at > created_at)
);

CREATE UNIQUE INDEX email_change_tokens_actor_pending_idx
    ON email_change_tokens(actor_id)
    WHERE used_at IS NULL;

-- +goose Down
DROP TABLE IF EXISTS email_change_tokens;
