-- +goose Up
-- Phase 5.3 package B: interactive agent messages, response collections and
-- agent follow-ups. Every addition is nullable or a new table, so older Core
-- builds keep working against the migrated schema.

-- New agent scopes. The list carries every scope introduced by phase 5.3
-- (knowledge:read and tables:read belong to packages A and H), so the
-- migration order of parallel packages cannot drop another package's scope.
ALTER TABLE agents DROP CONSTRAINT agents_allowed_scopes_check;
ALTER TABLE agents ADD CONSTRAINT agents_allowed_scopes_check CHECK (allowed_scopes <@ ARRAY[
    'chats:read', 'messages:read', 'messages:write', 'reactions:write',
    'files:read', 'search:read', 'members:read', 'memory:read', 'memory:write',
    'runtime:execute', 'runtime:worker',
    'knowledge:read', 'messages:interactive', 'followups:write', 'tables:read'
]::text[]);
ALTER TABLE agent_api_keys DROP CONSTRAINT agent_api_keys_scopes_check;
ALTER TABLE agent_api_keys ADD CONSTRAINT agent_api_keys_scopes_check CHECK (scopes <@ ARRAY[
    'chats:read', 'messages:read', 'messages:write', 'reactions:write',
    'files:read', 'search:read', 'members:read', 'memory:read', 'memory:write',
    'runtime:execute', 'runtime:worker',
    'knowledge:read', 'messages:interactive', 'followups:write', 'tables:read'
]::text[]);

-- Optional versioned structured part of a message (card, actions, sources).
-- The body stays the plain-text fallback for clients without block support.
ALTER TABLE messages
    ADD COLUMN blocks jsonb CHECK (blocks IS NULL OR (jsonb_typeof(blocks) = 'object' AND octet_length(blocks::text) <= 65536));

-- Source of truth for button presses. The unique key makes a press
-- idempotent per actor; the card projection inside messages.blocks is
-- rewritten in the same transaction.
CREATE TABLE message_action_responses (
    id uuid PRIMARY KEY,
    org_id uuid NOT NULL,
    message_id uuid NOT NULL,
    action_id text NOT NULL CHECK (action_id ~ '^[a-z0-9][a-z0-9_.-]{0,63}$'),
    actor_id uuid NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (message_id, action_id, actor_id),
    FOREIGN KEY (org_id, message_id) REFERENCES messages(org_id, id) ON DELETE CASCADE,
    FOREIGN KEY (org_id, actor_id) REFERENCES actors(org_id, id) ON DELETE CASCADE
);
CREATE INDEX message_action_responses_message_idx ON message_action_responses(org_id, message_id, created_at);

-- A pending tool confirmation may be mirrored by a card in the run's chat.
ALTER TABLE agent_tool_confirmations ADD COLUMN card_message_id uuid;

CREATE TABLE agent_collections (
    id uuid PRIMARY KEY,
    org_id uuid NOT NULL,
    agent_id uuid NOT NULL,
    agent_version integer,
    run_id uuid,
    chat_id uuid NOT NULL,
    message_id uuid NOT NULL,
    response_kind text NOT NULL CHECK (response_kind IN ('reaction', 'action', 'reply')),
    match_values text[] NOT NULL DEFAULT '{}' CHECK (cardinality(match_values) <= 20),
    expected_actor_ids uuid[] NOT NULL CHECK (cardinality(expected_actor_ids) BETWEEN 1 AND 500),
    deadline_at timestamptz NOT NULL,
    remind_every_seconds integer CHECK (remind_every_seconds IS NULL OR remind_every_seconds BETWEEN 300 AND 604800),
    max_reminders smallint NOT NULL DEFAULT 0 CHECK (max_reminders BETWEEN 0 AND 5),
    reminder_channel text NOT NULL DEFAULT 'thread' CHECK (reminder_channel IN ('thread', 'direct')),
    reminder_text text NOT NULL DEFAULT '' CHECK (length(reminder_text) <= 2000),
    report_chat_id uuid NOT NULL,
    report_thread_root_id uuid,
    note text NOT NULL DEFAULT '' CHECK (length(note) <= 2000),
    status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'completed', 'expired', 'canceled')),
    next_reminder_at timestamptz,
    reminders_canceled_at timestamptz,
    cancel_reason text NOT NULL DEFAULT '' CHECK (length(cancel_reason) <= 120),
    report_run_id uuid,
    created_at timestamptz NOT NULL DEFAULT now(),
    closed_at timestamptz,
    UNIQUE (org_id, id),
    FOREIGN KEY (org_id, agent_id) REFERENCES agents(org_id, actor_id) ON DELETE CASCADE,
    FOREIGN KEY (org_id, chat_id) REFERENCES chats(org_id, id) ON DELETE CASCADE,
    FOREIGN KEY (org_id, message_id) REFERENCES messages(org_id, id) ON DELETE CASCADE,
    FOREIGN KEY (org_id, report_chat_id) REFERENCES chats(org_id, id) ON DELETE CASCADE
);
CREATE INDEX agent_collections_due_idx ON agent_collections(deadline_at) WHERE status = 'open';
CREATE INDEX agent_collections_reminder_idx ON agent_collections(next_reminder_at) WHERE status = 'open' AND next_reminder_at IS NOT NULL;
CREATE INDEX agent_collections_agent_idx ON agent_collections(org_id, agent_id, created_at DESC);

-- Per-person reminder ledger; the daily cap across all agents is computed
-- from sent_at.
CREATE TABLE agent_reminders (
    id uuid PRIMARY KEY,
    org_id uuid NOT NULL,
    collection_id uuid NOT NULL,
    actor_id uuid NOT NULL,
    message_id uuid,
    sent_at timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY (org_id, collection_id) REFERENCES agent_collections(org_id, id) ON DELETE CASCADE,
    FOREIGN KEY (org_id, actor_id) REFERENCES actors(org_id, id) ON DELETE CASCADE
);
CREATE INDEX agent_reminders_actor_idx ON agent_reminders(org_id, actor_id, sent_at DESC);
CREATE INDEX agent_reminders_collection_idx ON agent_reminders(collection_id, actor_id);

CREATE TABLE agent_followups (
    id uuid PRIMARY KEY,
    org_id uuid NOT NULL,
    agent_id uuid NOT NULL,
    agent_version integer,
    source_run_id uuid NOT NULL,
    tool_call_id uuid NOT NULL,
    chat_id uuid NOT NULL,
    thread_root_id uuid,
    due_at timestamptz NOT NULL,
    context jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(context) = 'object' AND octet_length(context::text) <= 16384),
    note text NOT NULL DEFAULT '' CHECK (length(note) <= 2000),
    status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'dispatched', 'canceled', 'skipped')),
    reason text NOT NULL DEFAULT '' CHECK (length(reason) <= 120),
    run_id uuid,
    created_at timestamptz NOT NULL DEFAULT now(),
    finished_at timestamptz,
    UNIQUE (org_id, source_run_id, tool_call_id),
    FOREIGN KEY (org_id, agent_id) REFERENCES agents(org_id, actor_id) ON DELETE CASCADE,
    FOREIGN KEY (org_id, chat_id) REFERENCES chats(org_id, id) ON DELETE CASCADE
);
CREATE INDEX agent_followups_due_idx ON agent_followups(due_at) WHERE status = 'pending';
CREATE INDEX agent_followups_agent_idx ON agent_followups(org_id, agent_id, status);

-- +goose Down
DROP TABLE IF EXISTS agent_followups;
DROP TABLE IF EXISTS agent_reminders;
DROP TABLE IF EXISTS agent_collections;
ALTER TABLE agent_tool_confirmations DROP COLUMN IF EXISTS card_message_id;
DROP TABLE IF EXISTS message_action_responses;
ALTER TABLE messages DROP COLUMN IF EXISTS blocks;
UPDATE agent_api_keys SET revoked_at=COALESCE(revoked_at,now()) WHERE scopes && ARRAY['messages:interactive','followups:write']::text[];
UPDATE agents SET allowed_scopes=array_remove(array_remove(allowed_scopes,'messages:interactive'),'followups:write');
UPDATE agent_drafts SET allowed_scopes=array_remove(array_remove(allowed_scopes,'messages:interactive'),'followups:write');
ALTER TABLE agent_api_keys DROP CONSTRAINT agent_api_keys_scopes_check;
ALTER TABLE agent_api_keys ADD CONSTRAINT agent_api_keys_scopes_check CHECK (scopes <@ ARRAY[
    'chats:read', 'messages:read', 'messages:write', 'reactions:write',
    'files:read', 'search:read', 'members:read', 'memory:read', 'memory:write',
    'runtime:execute', 'runtime:worker', 'knowledge:read', 'tables:read'
]::text[]);
ALTER TABLE agents DROP CONSTRAINT agents_allowed_scopes_check;
ALTER TABLE agents ADD CONSTRAINT agents_allowed_scopes_check CHECK (allowed_scopes <@ ARRAY[
    'chats:read', 'messages:read', 'messages:write', 'reactions:write',
    'files:read', 'search:read', 'members:read', 'memory:read', 'memory:write',
    'runtime:execute', 'runtime:worker', 'knowledge:read', 'tables:read'
]::text[]);
