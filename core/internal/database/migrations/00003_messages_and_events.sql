-- +goose Up
ALTER TABLE organizations
    ADD COLUMN event_seq bigint NOT NULL DEFAULT 0 CHECK (event_seq >= 0);

CREATE TABLE messages (
    id uuid PRIMARY KEY,
    org_id uuid NOT NULL,
    chat_id uuid NOT NULL,
    actor_id uuid NOT NULL,
    client_msg_id uuid NOT NULL,
    create_fingerprint bytea NOT NULL CHECK (octet_length(create_fingerprint) = 32),
    type text NOT NULL DEFAULT 'text' CHECK (type IN ('text')),
    body text NOT NULL CHECK (octet_length(body) <= 1048576),
    body_format text NOT NULL DEFAULT 'plain' CHECK (body_format IN ('plain', 'markdown')),
    reply_to_id uuid,
    thread_root_id uuid,
    version integer NOT NULL DEFAULT 1 CHECK (version > 0),
    created_seq bigint NOT NULL CHECK (created_seq > 0),
    created_at timestamptz NOT NULL DEFAULT now(),
    edited_at timestamptz,
    deleted_at timestamptz,
    UNIQUE (org_id, id),
    UNIQUE (org_id, chat_id, id),
    UNIQUE (actor_id, client_msg_id),
    UNIQUE (org_id, created_seq),
    FOREIGN KEY (org_id, chat_id) REFERENCES chats(org_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (org_id, actor_id) REFERENCES actors(org_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (org_id, chat_id, reply_to_id) REFERENCES messages(org_id, chat_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (org_id, chat_id, thread_root_id) REFERENCES messages(org_id, chat_id, id) ON DELETE RESTRICT
);

CREATE INDEX messages_chat_feed_idx
    ON messages(chat_id, created_seq DESC) WHERE thread_root_id IS NULL;
CREATE INDEX messages_thread_idx
    ON messages(thread_root_id, created_seq DESC) WHERE thread_root_id IS NOT NULL;

CREATE TABLE message_revisions (
    id uuid PRIMARY KEY,
    org_id uuid NOT NULL,
    message_id uuid NOT NULL,
    version integer NOT NULL CHECK (version > 0),
    body text NOT NULL CHECK (octet_length(body) <= 1048576),
    body_format text NOT NULL CHECK (body_format IN ('plain', 'markdown')),
    edited_by uuid NOT NULL,
    edited_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (message_id, version),
    FOREIGN KEY (org_id, message_id) REFERENCES messages(org_id, id) ON DELETE CASCADE,
    FOREIGN KEY (org_id, edited_by) REFERENCES actors(org_id, id) ON DELETE RESTRICT
);

CREATE TABLE events (
    org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    seq bigint NOT NULL CHECK (seq > 0),
    type text NOT NULL CHECK (type ~ '^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$'),
    actor_id uuid,
    chat_id uuid,
    subject_id uuid NOT NULL,
    audience_actor_id uuid,
    occurred_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (org_id, seq),
    FOREIGN KEY (org_id, actor_id) REFERENCES actors(org_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (org_id, chat_id) REFERENCES chats(org_id, id) ON DELETE CASCADE,
    FOREIGN KEY (org_id, audience_actor_id) REFERENCES actors(org_id, id) ON DELETE RESTRICT
);

CREATE INDEX events_org_occurred_idx ON events(org_id, occurred_at);
CREATE INDEX events_chat_seq_idx ON events(chat_id, seq) WHERE chat_id IS NOT NULL;

-- +goose Down
DROP TABLE IF EXISTS events;
DROP TABLE IF EXISTS message_revisions;
DROP TABLE IF EXISTS messages;
ALTER TABLE organizations DROP COLUMN IF EXISTS event_seq;
