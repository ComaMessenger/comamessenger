-- +goose Up
-- Coma mail relay (ADR-0013). One registration per installation: the relay
-- key is sealed with the integration encryption key. mail_outbox holds
-- letters waiting for a retry after a temporary relay failure; the payload
-- carries one-time links, so it is sealed too and expires with the link.
CREATE TABLE mail_relay_state (
    singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
    relay_url text NOT NULL,
    app_url text NOT NULL,
    installation_id text NOT NULL DEFAULT '',
    key_sealed bytea,
    challenge text NOT NULL DEFAULT '',
    status text NOT NULL DEFAULT 'registering' CHECK (status IN ('registering', 'active', 'revoked', 'error')),
    last_error text NOT NULL DEFAULT '' CHECK (length(last_error) <= 500),
    next_attempt_at timestamptz NOT NULL DEFAULT now(),
    attempts integer NOT NULL DEFAULT 0,
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE mail_outbox (
    id uuid PRIMARY KEY,
    org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    kind text NOT NULL,
    payload bytea NOT NULL,
    attempts integer NOT NULL DEFAULT 0,
    available_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL,
    lease_until timestamptz,
    last_error text CHECK (last_error IS NULL OR length(last_error) <= 500),
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX mail_outbox_due_idx ON mail_outbox(available_at);

-- +goose Down
DROP TABLE IF EXISTS mail_outbox;
DROP TABLE IF EXISTS mail_relay_state;
