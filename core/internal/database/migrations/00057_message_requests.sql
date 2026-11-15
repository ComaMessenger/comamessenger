-- +goose Up
-- Phase 6.4 wave 1, package R1: requests («Запрос»). A request is a message
-- of type request: its body is the question and is shared like any message.
-- Who is asked and who answered what live only in the two tables below,
-- never in messages.blocks or in the chat-wide realtime frames: only the
-- author and chat admins may read them, checked on every read.
ALTER TABLE messages DROP CONSTRAINT messages_type_check;
ALTER TABLE messages ADD CONSTRAINT messages_type_check CHECK (type IN ('text', 'request'));
ALTER TABLE messages ADD CONSTRAINT messages_request_blocks_check CHECK (type <> 'request' OR blocks IS NULL);

CREATE TABLE message_requests (
    org_id uuid NOT NULL,
    message_id uuid PRIMARY KEY,
    chat_id uuid NOT NULL,
    author_id uuid NOT NULL,
    -- department and position arrive with wave 2, together with their id
    -- columns; until then the server refuses them.
    audience_kind text NOT NULL CHECK (audience_kind IN ('people', 'chat', 'department', 'position')),
    -- The only recipient's name (or, from wave 2, the department or position)
    -- at the moment of sending; empty for chat and for several people.
    audience_label text NOT NULL DEFAULT '' CHECK (char_length(audience_label) <= 60),
    answer_preset text NOT NULL CHECK (answer_preset IN ('ack', 'yes_no', 'attend', 'done', 'custom')),
    custom_options text[] NOT NULL DEFAULT '{}',
    allow_comment boolean NOT NULL DEFAULT true,
    due_at timestamptz,
    auto_remind boolean NOT NULL DEFAULT false,
    auto_remind_at timestamptz,
    auto_remind_job_id bigint,
    auto_reminded_at timestamptz,
    status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
    closed_reason text CHECK (closed_reason IN ('author', 'moderator', 'message_deleted', 'expired')),
    closed_by uuid,
    closed_at timestamptz,
    recipient_count integer NOT NULL CHECK (recipient_count BETWEEN 1 AND 500),
    answered_count integer NOT NULL DEFAULT 0 CHECK (answered_count >= 0),
    -- The last first answer or change: a request without a due date closes
    -- 30 days after it (or after creation without answers).
    last_answer_at timestamptz,
    last_manual_remind_at timestamptz,
    manual_remind_count smallint NOT NULL DEFAULT 0 CHECK (manual_remind_count BETWEEN 0 AND 5),
    expire_at timestamptz NOT NULL,
    expire_job_id bigint,
    version integer NOT NULL DEFAULT 1 CHECK (version > 0),
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (org_id, message_id),
    CHECK ((answer_preset = 'custom') = (cardinality(custom_options) BETWEEN 2 AND 4)),
    CHECK (answer_preset = 'custom' OR custom_options = '{}'),
    CHECK (audience_kind NOT IN ('department', 'position') OR audience_label <> ''),
    CHECK (NOT auto_remind OR (due_at IS NOT NULL AND auto_remind_at IS NOT NULL)),
    CHECK ((status = 'closed') = (closed_at IS NOT NULL AND closed_reason IS NOT NULL)),
    FOREIGN KEY (org_id, message_id) REFERENCES messages(org_id, id) ON DELETE CASCADE,
    FOREIGN KEY (org_id, chat_id) REFERENCES chats(org_id, id) ON DELETE CASCADE,
    FOREIGN KEY (org_id, author_id) REFERENCES actors(org_id, id) ON DELETE CASCADE
);
CREATE INDEX message_requests_chat_open_idx ON message_requests(org_id, chat_id) WHERE status = 'open';
CREATE INDEX message_requests_author_open_idx ON message_requests(org_id, author_id) WHERE status = 'open';

-- The recipients fixed at the moment of sending and their answers, one row
-- per recipient. Whoever joins the chat later is not asked.
CREATE TABLE message_request_recipients (
    org_id uuid NOT NULL,
    message_id uuid NOT NULL,
    actor_id uuid NOT NULL,
    -- Copy of the request's chat for the per-chat «Ждут вас» counters.
    chat_id uuid NOT NULL,
    option_index smallint CHECK (option_index BETWEEN 0 AND 3),
    comment text NOT NULL DEFAULT '' CHECK (char_length(comment) <= 280),
    answered_at timestamptz,
    answered_late boolean NOT NULL DEFAULT false,
    changed_at timestamptz,
    last_reminded_at timestamptz,
    reminded_count smallint NOT NULL DEFAULT 0 CHECK (reminded_count >= 0),
    -- Copy of the request's status (false once closed), so the «Ждут вас»
    -- indexes keep only open requests and do not grow with history.
    request_open boolean NOT NULL DEFAULT true,
    version integer NOT NULL DEFAULT 1 CHECK (version > 0),
    PRIMARY KEY (message_id, actor_id),
    CHECK ((option_index IS NULL) = (answered_at IS NULL)),
    CHECK (option_index IS NOT NULL OR comment = ''),
    FOREIGN KEY (org_id, message_id) REFERENCES message_requests(org_id, message_id) ON DELETE CASCADE,
    FOREIGN KEY (org_id, actor_id) REFERENCES actors(org_id, id) ON DELETE CASCADE
);
-- «Ждут вас»: my open requests without an answer, then answered ones.
CREATE INDEX message_request_recipients_inbox_idx
    ON message_request_recipients(org_id, actor_id, (answered_at IS NOT NULL), message_id DESC) WHERE request_open;
CREATE INDEX message_request_recipients_chat_idx
    ON message_request_recipients(org_id, actor_id, chat_id) WHERE answered_at IS NULL AND request_open;

-- Every request reminder a person got, for the limit of 10 a day from all
-- requests. Entries older than a day are removed when the person is
-- reminded again; nothing here names the request.
CREATE TABLE message_request_reminder_log (
    org_id uuid NOT NULL,
    actor_id uuid NOT NULL,
    reminded_at timestamptz NOT NULL,
    FOREIGN KEY (org_id, actor_id) REFERENCES actors(org_id, id) ON DELETE CASCADE
);
CREATE INDEX message_request_reminder_log_actor_idx ON message_request_reminder_log(org_id, actor_id, reminded_at);

-- +goose Down
DROP TABLE IF EXISTS message_request_reminder_log;
DROP TABLE IF EXISTS message_request_recipients;
DROP TABLE IF EXISTS message_requests;
UPDATE messages SET type = 'text' WHERE type = 'request';
ALTER TABLE messages DROP CONSTRAINT IF EXISTS messages_request_blocks_check;
ALTER TABLE messages DROP CONSTRAINT messages_type_check;
ALTER TABLE messages ADD CONSTRAINT messages_type_check CHECK (type IN ('text'));
