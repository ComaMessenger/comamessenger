-- +goose Up
CREATE TABLE password_reset_tokens (
    id uuid PRIMARY KEY,
    org_id uuid NOT NULL,
    actor_id uuid NOT NULL,
    token_hash bytea NOT NULL UNIQUE CHECK (octet_length(token_hash) = 32),
    delivery text NOT NULL CHECK (delivery IN ('email', 'operator')),
    issued_by uuid,
    created_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL,
    used_at timestamptz,
    FOREIGN KEY (org_id, actor_id) REFERENCES actors(org_id, id) ON DELETE CASCADE,
    FOREIGN KEY (org_id, issued_by) REFERENCES actors(org_id, id) ON DELETE SET NULL (issued_by),
    CHECK (expires_at > created_at),
    CHECK (used_at IS NULL OR used_at >= created_at)
);

CREATE INDEX password_reset_tokens_actor_pending_idx
    ON password_reset_tokens(org_id, actor_id, expires_at)
    WHERE used_at IS NULL;

-- +goose Down
DROP TABLE IF EXISTS password_reset_tokens;
