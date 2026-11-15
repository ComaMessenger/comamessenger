-- +goose Up
-- Personal reminders about messages («Напомнить мне», phase 6.4 wave 1).
-- Only the owner ever reads or changes a row; access to the message is
-- checked on every read and when the reminder fires, never stored.
--
-- A reminder without a message and without a note is not kept: that is a
-- rule of package reminder, not a CHECK, so that deleting a chat (which
-- cascades to both messages and reminders) never trips over the
-- intermediate SET NULL of message_id.
CREATE TABLE message_reminders (
    id uuid PRIMARY KEY,
    org_id uuid NOT NULL,
    actor_id uuid NOT NULL,
    -- NULL after the message was deleted while the reminder had a note.
    message_id uuid,
    chat_id uuid NOT NULL,
    note text NOT NULL DEFAULT '' CHECK (char_length(note) <= 200),
    remind_at timestamptz NOT NULL,
    state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'fired')),
    fired_at timestamptz,
    fired_late boolean NOT NULL DEFAULT false,
    river_job_id bigint,
    version integer NOT NULL DEFAULT 1 CHECK (version > 0),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (org_id, id),
    CHECK ((state = 'fired') = (fired_at IS NOT NULL)),
    FOREIGN KEY (org_id, actor_id) REFERENCES actors(org_id, id) ON DELETE CASCADE,
    FOREIGN KEY (org_id, message_id) REFERENCES messages(org_id, id) ON DELETE SET NULL (message_id),
    FOREIGN KEY (org_id, chat_id) REFERENCES chats(org_id, id) ON DELETE CASCADE
);

-- One reminder per message and person.
CREATE UNIQUE INDEX message_reminders_one_idx
    ON message_reminders(actor_id, message_id) WHERE message_id IS NOT NULL;
-- Pending list (by remind_at) and the pending limit.
CREATE INDEX message_reminders_list_idx
    ON message_reminders(org_id, actor_id, state, remind_at, id);
-- Fired list (latest first) and reminders_fired_total.
CREATE INDEX message_reminders_fired_idx
    ON message_reminders(org_id, actor_id, fired_at DESC, id DESC) WHERE state = 'fired';
-- The bell in the feed of one chat.
CREATE INDEX message_reminders_chat_idx
    ON message_reminders(org_id, actor_id, chat_id) WHERE message_id IS NOT NULL;
-- Message deletion finds every reminder of the message.
CREATE INDEX message_reminders_message_idx
    ON message_reminders(message_id) WHERE message_id IS NOT NULL;
-- Chat deletion cascades through chat_id.
CREATE INDEX message_reminders_chat_fk_idx ON message_reminders(chat_id);
-- The sweep of pending reminders whose job is gone, and retention of fired ones.
CREATE INDEX message_reminders_overdue_idx ON message_reminders(remind_at) WHERE state = 'pending';
CREATE INDEX message_reminders_retention_idx ON message_reminders(fired_at) WHERE state = 'fired';

-- +goose Down
DROP TABLE IF EXISTS message_reminders;
