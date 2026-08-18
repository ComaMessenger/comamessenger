-- +goose Up
ALTER TABLE messages
    ADD COLUMN mentioned_actor_ids uuid[] NOT NULL DEFAULT '{}'::uuid[];

CREATE INDEX messages_mentions_idx
    ON messages USING gin (mentioned_actor_ids);

ALTER TABLE events
    ADD COLUMN exclude_session_id uuid;

CREATE TABLE chat_reads (
    org_id uuid NOT NULL,
    chat_id uuid NOT NULL,
    actor_id uuid NOT NULL,
    last_read_seq bigint NOT NULL CHECK (last_read_seq > 0),
    last_read_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (chat_id, actor_id),
    FOREIGN KEY (org_id, chat_id) REFERENCES chats(org_id, id) ON DELETE CASCADE,
    FOREIGN KEY (org_id, actor_id) REFERENCES actors(org_id, id) ON DELETE CASCADE
);

CREATE INDEX chat_reads_actor_idx ON chat_reads(org_id, actor_id, chat_id);

CREATE TABLE thread_reads (
    org_id uuid NOT NULL,
    thread_root_id uuid NOT NULL,
    actor_id uuid NOT NULL,
    last_read_seq bigint NOT NULL CHECK (last_read_seq > 0),
    last_read_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (thread_root_id, actor_id),
    FOREIGN KEY (org_id, thread_root_id) REFERENCES messages(org_id, id) ON DELETE CASCADE,
    FOREIGN KEY (org_id, actor_id) REFERENCES actors(org_id, id) ON DELETE CASCADE
);

CREATE INDEX thread_reads_actor_idx ON thread_reads(org_id, actor_id, thread_root_id);

CREATE TABLE drafts (
    org_id uuid NOT NULL,
    actor_id uuid NOT NULL,
    chat_id uuid NOT NULL,
    thread_root_id uuid,
    scope_id uuid GENERATED ALWAYS AS (COALESCE(thread_root_id, chat_id)) STORED,
    body text NOT NULL CHECK (octet_length(body) <= 1048576),
    body_format text NOT NULL DEFAULT 'plain' CHECK (body_format IN ('plain', 'markdown')),
    version integer NOT NULL DEFAULT 1 CHECK (version > 0),
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (actor_id, scope_id),
    FOREIGN KEY (org_id, actor_id) REFERENCES actors(org_id, id) ON DELETE CASCADE,
    FOREIGN KEY (org_id, chat_id) REFERENCES chats(org_id, id) ON DELETE CASCADE,
    FOREIGN KEY (org_id, chat_id, thread_root_id) REFERENCES messages(org_id, chat_id, id) ON DELETE CASCADE
);

CREATE INDEX drafts_actor_updated_idx ON drafts(org_id, actor_id, updated_at DESC);

-- +goose Down
DROP TABLE IF EXISTS drafts;
DROP TABLE IF EXISTS thread_reads;
DROP TABLE IF EXISTS chat_reads;
ALTER TABLE events DROP COLUMN IF EXISTS exclude_session_id;
DROP INDEX IF EXISTS messages_mentions_idx;
ALTER TABLE messages DROP COLUMN IF EXISTS mentioned_actor_ids;
