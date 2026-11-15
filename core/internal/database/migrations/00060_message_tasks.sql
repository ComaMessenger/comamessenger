-- +goose Up
-- Phase 6.6 wave 3, package T: tasks («Задача»). A task is a message of type
-- task: messages.body is built by the server from the title and the
-- description, so search, agents and older clients see it as text. The task
-- itself is the same for every reader of the chat and lives in the tables
-- below. Access is checked on every read; nothing about it is stored.
ALTER TABLE messages DROP CONSTRAINT messages_type_check;
ALTER TABLE messages ADD CONSTRAINT messages_type_check CHECK (type IN ('text', 'request', 'task'));
ALTER TABLE messages ADD CONSTRAINT messages_task_blocks_check CHECK (type <> 'task' OR blocks IS NULL);

CREATE TABLE message_tasks (
    org_id uuid NOT NULL,
    message_id uuid PRIMARY KEY,
    chat_id uuid NOT NULL,
    author_id uuid NOT NULL,
    -- 1–200 characters; a deleted task message loses its texts (empty).
    title text NOT NULL CHECK (char_length(title) <= 200),
    description text NOT NULL DEFAULT '' CHECK (char_length(description) <= 4000),
    -- «из сообщения»; NULL once the source is deleted for good.
    source_message_id uuid,
    assignee_kind text NOT NULL CHECK (assignee_kind IN ('person', 'department', 'position')),
    -- NULL while a queue is not taken, or once the person is deleted for good.
    assignee_id uuid,
    -- The department or position of a queue; NULL once it is deleted.
    audience_department_id uuid,
    audience_position_id uuid,
    -- Its name at the moment the queue was built; kept after renames.
    audience_label text NOT NULL DEFAULT '' CHECK (char_length(audience_label) <= 60),
    status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'in_progress', 'done', 'canceled')),
    status_changed_by uuid,
    status_changed_at timestamptz,
    canceled_reason text CHECK (canceled_reason IN ('author', 'moderator', 'message_deleted')),
    due_at timestamptz,
    remind_before_due boolean NOT NULL DEFAULT false,
    due_soon_job_id bigint,
    due_soon_sent_at timestamptz,
    overdue_job_id bigint,
    overdue_sent_at timestamptz,
    items_total smallint NOT NULL DEFAULT 0 CHECK (items_total BETWEEN 0 AND 30),
    items_done smallint NOT NULL DEFAULT 0 CHECK (items_done BETWEEN 0 AND items_total),
    last_nudge_at timestamptz,
    nudge_count smallint NOT NULL DEFAULT 0 CHECK (nudge_count BETWEEN 0 AND 5),
    version integer NOT NULL DEFAULT 1 CHECK (version > 0),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (org_id, message_id),
    -- The id columns only belong to their kind. They may become NULL when
    -- the department, position or person is deleted for good (ON DELETE SET
    -- NULL), so the checks do not demand them; the service sets them.
    CHECK (assignee_kind = 'department' OR audience_department_id IS NULL),
    CHECK (assignee_kind = 'position' OR audience_position_id IS NULL),
    CHECK (assignee_kind = 'person' OR audience_label <> ''),
    CHECK (NOT remind_before_due OR due_at IS NOT NULL),
    CHECK ((status = 'canceled') = (canceled_reason IS NOT NULL)),
    FOREIGN KEY (org_id, message_id) REFERENCES messages(org_id, id) ON DELETE CASCADE,
    FOREIGN KEY (org_id, chat_id) REFERENCES chats(org_id, id) ON DELETE CASCADE,
    -- Like messages.actor_id: an author is never deleted from under a task.
    FOREIGN KEY (org_id, author_id) REFERENCES actors(org_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (org_id, assignee_id) REFERENCES actors(org_id, id) ON DELETE SET NULL (assignee_id),
    FOREIGN KEY (org_id, source_message_id) REFERENCES messages(org_id, id) ON DELETE SET NULL (source_message_id),
    FOREIGN KEY (org_id, audience_department_id) REFERENCES departments(org_id, id) ON DELETE SET NULL (audience_department_id),
    FOREIGN KEY (org_id, audience_position_id) REFERENCES positions(org_id, id) ON DELETE SET NULL (audience_position_id)
);
-- Open tasks of a chat: the slot and the list.
CREATE INDEX message_tasks_chat_open_idx
    ON message_tasks(org_id, chat_id, due_at NULLS LAST, message_id)
    WHERE status IN ('open', 'in_progress');
-- Closed tasks of a chat, latest first.
CREATE INDEX message_tasks_chat_closed_idx
    ON message_tasks(org_id, chat_id, status, status_changed_at DESC, message_id)
    WHERE status IN ('done', 'canceled');
-- «На мне» and the badge.
CREATE INDEX message_tasks_assignee_open_idx
    ON message_tasks(org_id, assignee_id, due_at NULLS LAST, message_id)
    WHERE status IN ('open', 'in_progress') AND assignee_id IS NOT NULL;
-- Closed «на мне» of the last days.
CREATE INDEX message_tasks_assignee_closed_idx
    ON message_tasks(org_id, assignee_id, status_changed_at DESC)
    WHERE status IN ('done', 'canceled') AND assignee_id IS NOT NULL;
-- «Поставил(а) я».
CREATE INDEX message_tasks_author_idx
    ON message_tasks(org_id, author_id, status, updated_at DESC);
-- Hard deletes of a source message or a person set these to NULL.
CREATE INDEX message_tasks_source_idx ON message_tasks(org_id, source_message_id) WHERE source_message_id IS NOT NULL;
CREATE INDEX message_tasks_department_idx ON message_tasks(org_id, audience_department_id) WHERE audience_department_id IS NOT NULL;
CREATE INDEX message_tasks_position_idx ON message_tasks(org_id, audience_position_id) WHERE audience_position_id IS NOT NULL;

-- Candidates of a queue: the snapshot taken when it was built. They stay
-- after the task is taken, closed or deleted; «Ждут вас» filters by status.
CREATE TABLE message_task_candidates (
    org_id uuid NOT NULL,
    message_id uuid NOT NULL,
    actor_id uuid NOT NULL,
    PRIMARY KEY (message_id, actor_id),
    FOREIGN KEY (org_id, message_id) REFERENCES message_tasks(org_id, message_id) ON DELETE CASCADE,
    FOREIGN KEY (org_id, actor_id) REFERENCES actors(org_id, id) ON DELETE CASCADE
);
CREATE INDEX message_task_candidates_actor_idx ON message_task_candidates(org_id, actor_id);

CREATE TABLE message_task_items (
    id uuid PRIMARY KEY,
    org_id uuid NOT NULL,
    message_id uuid NOT NULL,
    position smallint NOT NULL CHECK (position BETWEEN 0 AND 29),
    -- 1–200 characters; empty once the task message is deleted.
    text text NOT NULL CHECK (char_length(text) <= 200),
    assignee_id uuid,
    -- When the current assignee was set: the push of item_assigned names the
    -- latest item of the person.
    assigned_at timestamptz,
    done_at timestamptz,
    done_by uuid,
    created_by uuid NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (message_id, position) DEFERRABLE INITIALLY DEFERRED,
    CHECK (done_at IS NOT NULL OR done_by IS NULL),
    FOREIGN KEY (org_id, message_id) REFERENCES message_tasks(org_id, message_id) ON DELETE CASCADE,
    FOREIGN KEY (org_id, assignee_id) REFERENCES actors(org_id, id) ON DELETE SET NULL (assignee_id),
    FOREIGN KEY (org_id, done_by) REFERENCES actors(org_id, id) ON DELETE SET NULL (done_by),
    -- Deleting the person must not take items from under the counters.
    FOREIGN KEY (org_id, created_by) REFERENCES actors(org_id, id) ON DELETE RESTRICT
);
-- My open items.
CREATE INDEX message_task_items_assignee_idx
    ON message_task_items(org_id, assignee_id, message_id) WHERE done_at IS NULL AND assignee_id IS NOT NULL;
CREATE INDEX message_task_items_done_by_idx ON message_task_items(org_id, done_by) WHERE done_by IS NOT NULL;

-- «Напомнить» of every task one person got in the last 24 hours: a person
-- gets at most 10 such pushes a day, the rest are recorded without one.
CREATE TABLE message_task_nudge_log (
    org_id uuid NOT NULL,
    actor_id uuid NOT NULL,
    nudged_at timestamptz NOT NULL,
    FOREIGN KEY (org_id, actor_id) REFERENCES actors(org_id, id) ON DELETE CASCADE
);
CREATE INDEX message_task_nudge_log_idx ON message_task_nudge_log(org_id, actor_id, nudged_at);

-- +goose Down
DROP TABLE IF EXISTS message_task_nudge_log;
DROP TABLE IF EXISTS message_task_items;
DROP TABLE IF EXISTS message_task_candidates;
DROP TABLE IF EXISTS message_tasks;
UPDATE messages SET type = 'text' WHERE type = 'task';
ALTER TABLE messages DROP CONSTRAINT IF EXISTS messages_task_blocks_check;
ALTER TABLE messages DROP CONSTRAINT messages_type_check;
ALTER TABLE messages ADD CONSTRAINT messages_type_check CHECK (type IN ('text', 'request'));
