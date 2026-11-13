-- +goose NO TRANSACTION
-- +goose Up
-- Shared media of a chat («Медиа», «Файлы», «Голосовые», «Ссылки» in chat
-- info): two pointer tables kept next to messages, so a page of a chat's
-- photos or links is an index range scan whatever the size of the chat.
--
-- chat_attachments has a row per file attached to a live message, with the
-- kind fixed at attach time (the MIME and voice columns of a ready file never
-- change). message_links has a row per URL found in a live message's text.
-- Both are written in the transaction that writes the message and lose the
-- rows of a deleted message; message.BackfillShared fills them for messages
-- written before this migration, in small batches after the server starts.
--
-- Only new tables are created. The foreign keys to messages take a brief
-- lock on it, so each statement gives up after 5 s instead of queueing behind
-- a long query; a deploy then fails and is retried. Every block is safe to
-- re-run.

-- +goose StatementBegin
DO $$
BEGIN
    SET LOCAL lock_timeout = '5s';
    CREATE TABLE IF NOT EXISTS chat_attachments (
        org_id uuid NOT NULL,
        chat_id uuid NOT NULL,
        message_id uuid NOT NULL,
        file_id uuid NOT NULL,
        ordinal smallint NOT NULL CHECK (ordinal BETWEEN 0 AND 9),
        actor_id uuid NOT NULL,
        created_seq bigint NOT NULL CHECK (created_seq > 0),
        kind text NOT NULL CHECK (kind IN ('media', 'files', 'voice')),
        PRIMARY KEY (message_id, file_id),
        FOREIGN KEY (org_id, message_id) REFERENCES messages(org_id, id) ON DELETE CASCADE
    );
END
$$;
-- +goose StatementEnd

-- +goose StatementBegin
DO $$
BEGIN
    SET LOCAL lock_timeout = '5s';
    CREATE TABLE IF NOT EXISTS message_links (
        org_id uuid NOT NULL,
        chat_id uuid NOT NULL,
        message_id uuid NOT NULL,
        position smallint NOT NULL CHECK (position BETWEEN 0 AND 49),
        actor_id uuid NOT NULL,
        created_seq bigint NOT NULL CHECK (created_seq > 0),
        url text NOT NULL CHECK (length(url) BETWEEN 8 AND 2048),
        domain text NOT NULL CHECK (length(domain) BETWEEN 1 AND 255),
        label text CHECK (label IS NULL OR length(label) BETWEEN 1 AND 300),
        -- Characters (not bytes) from the start of the body to the URL: the
        -- text around it is cut from the body when a page is read.
        text_offset integer NOT NULL CHECK (text_offset >= 0),
        PRIMARY KEY (message_id, position),
        FOREIGN KEY (org_id, message_id) REFERENCES messages(org_id, id) ON DELETE CASCADE
    );
END
$$;
-- +goose StatementEnd

-- Pages read newest first by chat (and kind); counts are index-only scans.
-- An agent that only writes to a chat sees its own messages only: its pages
-- and counts use the *_author_idx indexes, so they never walk the whole chat.
CREATE INDEX IF NOT EXISTS chat_attachments_feed_idx
    ON chat_attachments(chat_id, kind, created_seq DESC, ordinal DESC);
CREATE INDEX IF NOT EXISTS chat_attachments_author_idx
    ON chat_attachments(actor_id, chat_id, kind, created_seq DESC, ordinal DESC);
CREATE INDEX IF NOT EXISTS message_links_feed_idx
    ON message_links(chat_id, created_seq DESC, position DESC);
CREATE INDEX IF NOT EXISTS message_links_author_idx
    ON message_links(actor_id, chat_id, created_seq DESC, position DESC);

-- Progress of message.BackfillShared: the last message id handled, in id
-- order, and when it finished. One row per backfill.
CREATE TABLE IF NOT EXISTS shared_backfill (
    name text PRIMARY KEY,
    last_message_id uuid,
    done_at timestamptz,
    updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO shared_backfill (name) VALUES ('chat_shared') ON CONFLICT DO NOTHING;

-- +goose Down
DROP TABLE IF EXISTS shared_backfill;
DROP TABLE IF EXISTS message_links;
DROP TABLE IF EXISTS chat_attachments;
