-- +goose Up
-- Phase 6.1 package C: scheduled messages of people and silent delivery.

-- A silent message is delivered as usual but raises no push, e-mail or
-- sound notification; unread counters are untouched by this flag.
ALTER TABLE messages ADD COLUMN silent boolean NOT NULL DEFAULT false;

-- Private to the author until sent. Nothing here is visible to search,
-- export, agents or other people: those read only the messages table.
CREATE TABLE scheduled_messages (
    id uuid PRIMARY KEY,
    org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    author_id uuid NOT NULL,
    chat_id uuid NOT NULL,
    thread_root_id uuid,
    reply_to_id uuid,
    -- Becomes the client_msg_id of the sent message: the ordinary
    -- idempotency of message creation guards against a double send.
    client_msg_id uuid NOT NULL,
    create_fingerprint bytea NOT NULL CHECK (octet_length(create_fingerprint) = 32),
    -- The device session family that scheduled or last changed the message.
    -- Signing that device out or revoking it cancels the send.
    session_family_id uuid NOT NULL,
    body text NOT NULL,
    body_format text NOT NULL CHECK (body_format IN ('plain', 'markdown')),
    mentioned_actor_ids uuid[] NOT NULL DEFAULT '{}',
    silent boolean NOT NULL DEFAULT false,
    send_at timestamptz NOT NULL,
    status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed')),
    failure_reason text CHECK (failure_reason IN (
        'author_inactive', 'session_revoked', 'chat_unavailable', 'not_member', 'forbidden',
        'reference_unavailable', 'attachment_unavailable', 'invalid_content', 'delivery_error')),
    message_id uuid,
    river_job_id bigint,
    version integer NOT NULL DEFAULT 1 CHECK (version > 0),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    sent_at timestamptz,
    failed_at timestamptz,
    UNIQUE (org_id, id),
    UNIQUE (author_id, client_msg_id),
    CHECK ((status = 'failed') = (failure_reason IS NOT NULL)),
    CHECK ((status = 'sent') = (sent_at IS NOT NULL)),
    CHECK (status <> 'sent' OR (body = '' AND mentioned_actor_ids = '{}')),
    FOREIGN KEY (org_id, author_id) REFERENCES actors(org_id, id) ON DELETE CASCADE,
    FOREIGN KEY (org_id, chat_id) REFERENCES chats(org_id, id) ON DELETE CASCADE,
    FOREIGN KEY (org_id, message_id) REFERENCES messages(org_id, id) ON DELETE SET NULL (message_id)
);

CREATE INDEX scheduled_messages_author_idx ON scheduled_messages(org_id, author_id, send_at) WHERE status <> 'sent';
CREATE INDEX scheduled_messages_author_chat_idx ON scheduled_messages(org_id, author_id, chat_id) WHERE status = 'pending';
CREATE INDEX scheduled_messages_retention_idx ON scheduled_messages(updated_at) WHERE status <> 'pending';

-- Files waiting for a scheduled message. While a row exists the unattached
-- file cleanup keeps the file; the file stays readable only by its uploader
-- because nothing links it to a chat until the message is sent.
CREATE TABLE scheduled_message_files (
    scheduled_message_id uuid NOT NULL,
    file_id uuid NOT NULL,
    org_id uuid NOT NULL,
    ordinal smallint NOT NULL CHECK (ordinal BETWEEN 0 AND 9),
    PRIMARY KEY (scheduled_message_id, file_id),
    UNIQUE (scheduled_message_id, ordinal),
    FOREIGN KEY (org_id, scheduled_message_id) REFERENCES scheduled_messages(org_id, id) ON DELETE CASCADE,
    FOREIGN KEY (org_id, file_id) REFERENCES files(org_id, id) ON DELETE CASCADE
);

CREATE INDEX scheduled_message_files_file_idx ON scheduled_message_files(file_id);

-- +goose Down
DROP TABLE scheduled_message_files;
DROP TABLE scheduled_messages;
ALTER TABLE messages DROP COLUMN silent;
