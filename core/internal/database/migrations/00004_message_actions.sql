-- +goose Up
ALTER TABLE events
    ADD COLUMN data jsonb NOT NULL DEFAULT '{}'::jsonb
        CHECK (jsonb_typeof(data) = 'object');

ALTER TABLE messages
    ADD COLUMN forwarded_from jsonb
        CHECK (forwarded_from IS NULL OR jsonb_typeof(forwarded_from) = 'object');

CREATE TABLE thread_followers (
    org_id uuid NOT NULL,
    thread_root_id uuid NOT NULL,
    actor_id uuid NOT NULL,
    followed_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (thread_root_id, actor_id),
    FOREIGN KEY (org_id, thread_root_id) REFERENCES messages(org_id, id) ON DELETE CASCADE,
    FOREIGN KEY (org_id, actor_id) REFERENCES actors(org_id, id) ON DELETE CASCADE
);

CREATE INDEX thread_followers_actor_idx
    ON thread_followers(org_id, actor_id, followed_at DESC, thread_root_id);

CREATE TABLE reactions (
    org_id uuid NOT NULL,
    message_id uuid NOT NULL,
    actor_id uuid NOT NULL,
    emoji text NOT NULL CHECK (octet_length(emoji) BETWEEN 1 AND 64),
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (message_id, actor_id, emoji),
    FOREIGN KEY (org_id, message_id) REFERENCES messages(org_id, id) ON DELETE CASCADE,
    FOREIGN KEY (org_id, actor_id) REFERENCES actors(org_id, id) ON DELETE CASCADE
);

CREATE INDEX reactions_message_idx
    ON reactions(org_id, message_id, created_at, actor_id);

CREATE TABLE message_pins (
    org_id uuid NOT NULL,
    message_id uuid PRIMARY KEY,
    pinned_by uuid NOT NULL,
    pinned_at timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY (org_id, message_id) REFERENCES messages(org_id, id) ON DELETE CASCADE,
    FOREIGN KEY (org_id, pinned_by) REFERENCES actors(org_id, id) ON DELETE RESTRICT
);

CREATE INDEX message_pins_chat_lookup_idx
    ON message_pins(org_id, pinned_at DESC);

-- +goose Down
DROP TABLE IF EXISTS message_pins;
DROP TABLE IF EXISTS reactions;
DROP TABLE IF EXISTS thread_followers;
ALTER TABLE messages DROP COLUMN IF EXISTS forwarded_from;
ALTER TABLE events DROP COLUMN IF EXISTS data;
