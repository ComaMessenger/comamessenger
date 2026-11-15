-- +goose Up
-- Phase 6.7 wave 4, package P: polls («Опрос»). A poll is a message of type
-- poll: messages.body is built by the server from the question and the
-- options, so search, agents and older clients see it as text.
--
-- Anonymity is honest: for an anonymous poll the server never stores which
-- person chose which option. message_polls.option_counts is the only record
-- of the choice there; message_poll_voters says only who has voted (to
-- refuse a second vote and to remind the others). message_poll_votes keeps
-- the choice of ordinary polls only, and a trigger refuses any row of an
-- anonymous poll, so a bug in the service cannot store one.
ALTER TABLE messages DROP CONSTRAINT messages_type_check;
ALTER TABLE messages ADD CONSTRAINT messages_type_check CHECK (type IN ('text', 'request', 'task', 'poll'));
ALTER TABLE messages ADD CONSTRAINT messages_poll_blocks_check CHECK (type <> 'poll' OR blocks IS NULL);

CREATE TABLE message_polls (
    org_id uuid NOT NULL,
    message_id uuid PRIMARY KEY,
    chat_id uuid NOT NULL,
    author_id uuid NOT NULL,
    -- 1–300 characters; a deleted poll message loses its texts (empty).
    question text NOT NULL CHECK (char_length(question) <= 300),
    -- 2–10 options of 1–100 characters; empty strings once deleted.
    options text[] NOT NULL CHECK (cardinality(options) BETWEEN 2 AND 10),
    multiple boolean NOT NULL DEFAULT false,
    anonymous boolean NOT NULL DEFAULT false,
    due_at timestamptz,
    close_job_id bigint,
    status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
    closed_reason text CHECK (closed_reason IN ('author', 'moderator', 'expired', 'message_deleted')),
    closed_by uuid,
    closed_at timestamptz,
    -- Votes per option; for an anonymous poll the only record of the choice.
    option_counts integer[] NOT NULL,
    voter_count integer NOT NULL DEFAULT 0 CHECK (voter_count >= 0),
    last_remind_at timestamptz,
    remind_count smallint NOT NULL DEFAULT 0 CHECK (remind_count BETWEEN 0 AND 5),
    version integer NOT NULL DEFAULT 1 CHECK (version > 0),
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (org_id, message_id),
    CHECK (cardinality(option_counts) = cardinality(options)),
    CHECK (0 <= ALL (option_counts)),
    CHECK ((status = 'closed') = (closed_at IS NOT NULL AND closed_reason IS NOT NULL)),
    FOREIGN KEY (org_id, message_id) REFERENCES messages(org_id, id) ON DELETE CASCADE,
    FOREIGN KEY (org_id, chat_id) REFERENCES chats(org_id, id) ON DELETE CASCADE,
    FOREIGN KEY (org_id, author_id) REFERENCES actors(org_id, id) ON DELETE CASCADE,
    FOREIGN KEY (org_id, closed_by) REFERENCES actors(org_id, id) ON DELETE SET NULL (closed_by)
);
-- «Ждут вас»: open polls with a due date.
CREATE INDEX message_polls_open_due_idx ON message_polls(org_id, chat_id, due_at)
    WHERE status = 'open' AND due_at IS NOT NULL;
-- Limits: open polls of a chat and of an author.
CREATE INDEX message_polls_open_chat_idx ON message_polls(org_id, chat_id) WHERE status = 'open';
CREATE INDEX message_polls_open_author_idx ON message_polls(org_id, author_id) WHERE status = 'open';

-- Who has voted. For every poll; for an anonymous one without the choice.
CREATE TABLE message_poll_voters (
    org_id uuid NOT NULL,
    message_id uuid NOT NULL,
    actor_id uuid NOT NULL,
    voted_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (message_id, actor_id),
    UNIQUE (org_id, message_id, actor_id),
    FOREIGN KEY (org_id, message_id) REFERENCES message_polls(org_id, message_id) ON DELETE CASCADE,
    FOREIGN KEY (org_id, actor_id) REFERENCES actors(org_id, id) ON DELETE CASCADE
);
CREATE INDEX message_poll_voters_actor_idx ON message_poll_voters(org_id, actor_id, message_id);

-- The choice. Ordinary polls only: an anonymous poll never has rows here.
CREATE TABLE message_poll_votes (
    org_id uuid NOT NULL,
    message_id uuid NOT NULL,
    actor_id uuid NOT NULL,
    option_index smallint NOT NULL CHECK (option_index BETWEEN 0 AND 9),
    voted_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (message_id, actor_id, option_index),
    FOREIGN KEY (org_id, message_id, actor_id)
        REFERENCES message_poll_voters(org_id, message_id, actor_id) ON DELETE CASCADE
);
CREATE INDEX message_poll_votes_option_idx ON message_poll_votes(message_id, option_index, voted_at);

-- +goose StatementBegin
CREATE FUNCTION message_poll_votes_not_anonymous() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF EXISTS (SELECT 1 FROM message_polls p WHERE p.message_id = NEW.message_id AND p.anonymous) THEN
        RAISE EXCEPTION 'the choice of an anonymous poll is never stored'
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END;
$$;
-- +goose StatementEnd
CREATE TRIGGER message_poll_votes_not_anonymous
    BEFORE INSERT OR UPDATE ON message_poll_votes
    FOR EACH ROW EXECUTE FUNCTION message_poll_votes_not_anonymous();

-- «Напомнить не ответившим» one person got in the last 24 hours from all
-- polls: at most 10 such pushes a day. No link to any option.
CREATE TABLE message_poll_reminders (
    org_id uuid NOT NULL,
    actor_id uuid NOT NULL,
    message_id uuid NOT NULL,
    sent_at timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY (org_id, actor_id) REFERENCES actors(org_id, id) ON DELETE CASCADE,
    FOREIGN KEY (org_id, message_id) REFERENCES message_polls(org_id, message_id) ON DELETE CASCADE
);
CREATE INDEX message_poll_reminders_actor_idx ON message_poll_reminders(org_id, actor_id, sent_at);

-- +goose Down
DROP TABLE IF EXISTS message_poll_reminders;
DROP TRIGGER IF EXISTS message_poll_votes_not_anonymous ON message_poll_votes;
DROP TABLE IF EXISTS message_poll_votes;
DROP FUNCTION IF EXISTS message_poll_votes_not_anonymous();
DROP TABLE IF EXISTS message_poll_voters;
DROP TABLE IF EXISTS message_polls;
UPDATE messages SET type = 'text' WHERE type = 'poll';
ALTER TABLE messages DROP CONSTRAINT IF EXISTS messages_poll_blocks_check;
ALTER TABLE messages DROP CONSTRAINT messages_type_check;
ALTER TABLE messages ADD CONSTRAINT messages_type_check CHECK (type IN ('text', 'request', 'task'));
