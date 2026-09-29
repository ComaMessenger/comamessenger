-- +goose Up
-- Mobile devices receive push through the project relay (ADR-0012). A device
-- is bound to a session family, so refresh rotation keeps it and logout,
-- revocation or a password change stop delivery.
CREATE TABLE mobile_push_devices (
    id uuid PRIMARY KEY,
    org_id uuid NOT NULL,
    actor_id uuid NOT NULL,
    session_family_id uuid NOT NULL,
    platform text NOT NULL CHECK (platform IN ('ios', 'android')),
    relay_handle text NOT NULL CHECK (length(relay_handle) BETWEEN 32 AND 256),
    notification_key bytea NOT NULL CHECK (octet_length(notification_key) = 32),
    app_version text NOT NULL DEFAULT '' CHECK (length(app_version) <= 64),
    locale text NOT NULL DEFAULT '' CHECK (length(locale) <= 16),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (org_id, relay_handle),
    FOREIGN KEY (org_id, actor_id) REFERENCES actors(org_id, id) ON DELETE CASCADE
);
CREATE INDEX mobile_push_devices_actor_idx ON mobile_push_devices(org_id, actor_id);
CREATE INDEX mobile_push_devices_family_idx ON mobile_push_devices(session_family_id);
CREATE TABLE mobile_push_deliveries (
    org_id uuid NOT NULL,
    event_seq bigint NOT NULL,
    device_id uuid NOT NULL REFERENCES mobile_push_devices(id) ON DELETE CASCADE,
    available_at timestamptz NOT NULL DEFAULT now(),
    attempts integer NOT NULL DEFAULT 0,
    sent_at timestamptz,
    last_error text,
    lease_token uuid,
    lease_until timestamptz,
    PRIMARY KEY (org_id, event_seq, device_id),
    FOREIGN KEY (org_id, event_seq) REFERENCES events(org_id, seq) ON DELETE CASCADE
);
CREATE INDEX mobile_push_deliveries_pending_idx ON mobile_push_deliveries(available_at, lease_until) WHERE sent_at IS NULL;
-- +goose Down
DROP TABLE IF EXISTS mobile_push_deliveries;
DROP TABLE IF EXISTS mobile_push_devices;
