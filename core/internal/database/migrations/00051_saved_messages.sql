-- +goose Up
-- Saved messages («Важные»): a private bookmark of one person on one message.
-- Unlike message_pins it is never shown to other members. The row goes away
-- with the person, the chat or the message; loss of access (leaving the chat,
-- removal, archive) only hides it, see message.ListSaved.
CREATE TABLE saved_messages (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    org_id uuid NOT NULL,
    actor_id uuid NOT NULL,
    message_id uuid NOT NULL,
    chat_id uuid NOT NULL,
    saved_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (actor_id, message_id),
    FOREIGN KEY (org_id, actor_id) REFERENCES actors(org_id, id) ON DELETE CASCADE,
    FOREIGN KEY (org_id, message_id) REFERENCES messages(org_id, id) ON DELETE CASCADE,
    FOREIGN KEY (org_id, chat_id) REFERENCES chats(org_id, id) ON DELETE CASCADE
);

CREATE INDEX saved_messages_actor_idx ON saved_messages(org_id, actor_id, id DESC);
CREATE INDEX saved_messages_actor_chat_idx ON saved_messages(org_id, actor_id, chat_id, id DESC);
CREATE INDEX saved_messages_message_idx ON saved_messages(message_id);
CREATE INDEX saved_messages_chat_idx ON saved_messages(chat_id);

-- +goose Down
DROP TABLE IF EXISTS saved_messages;
