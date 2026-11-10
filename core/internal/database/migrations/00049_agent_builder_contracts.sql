-- +goose Up
-- Phase 5.3 builder contracts. Every new field belongs to the agent version
-- (draft, published row and version config) and has a default that keeps the
-- behaviour of existing agents exactly as it was:
--
-- * confirmation_policy: per write tool "auto" (runs itself) or "confirm"
--   (waits for a person). The column default is the policy Core enforced
--   globally before this migration (every write tool except the interactive
--   ones waits), so existing agents and rows written by an older Core during
--   a rolling deploy keep confirming. New agents get the safer per-tool
--   defaults written explicitly by Core.
-- * tone: '' (no tone line) or concise / friendly / formal.
-- * read_only_chat_ids / write_only_chat_ids: subsets of the agent chats
--   where it only reads or only writes. Empty means it reads and writes in
--   every chat it belongs to, which is today's behaviour.

ALTER TABLE agents
    ADD COLUMN confirmation_policy jsonb NOT NULL
        DEFAULT '{"post_message":"confirm","reply_in_thread":"confirm","add_reaction":"confirm","remember":"confirm","send_direct_message":"confirm","post_card":"auto","update_card":"auto","start_collection":"auto","schedule_followup":"auto"}'::jsonb
        CHECK (jsonb_typeof(confirmation_policy) = 'object' AND octet_length(confirmation_policy::text) <= 4096),
    ADD COLUMN tone text NOT NULL DEFAULT ''
        CHECK (tone IN ('', 'concise', 'friendly', 'formal')),
    ADD COLUMN read_only_chat_ids uuid[] NOT NULL DEFAULT '{}'::uuid[]
        CHECK (cardinality(read_only_chat_ids) <= 100),
    ADD COLUMN write_only_chat_ids uuid[] NOT NULL DEFAULT '{}'::uuid[]
        CHECK (cardinality(write_only_chat_ids) <= 100);

ALTER TABLE agent_drafts
    ADD COLUMN confirmation_policy jsonb NOT NULL
        DEFAULT '{"post_message":"confirm","reply_in_thread":"confirm","add_reaction":"confirm","remember":"confirm","send_direct_message":"confirm","post_card":"auto","update_card":"auto","start_collection":"auto","schedule_followup":"auto"}'::jsonb
        CHECK (jsonb_typeof(confirmation_policy) = 'object' AND octet_length(confirmation_policy::text) <= 4096),
    ADD COLUMN tone text NOT NULL DEFAULT ''
        CHECK (tone IN ('', 'concise', 'friendly', 'formal')),
    ADD COLUMN read_only_chat_ids uuid[] NOT NULL DEFAULT '{}'::uuid[]
        CHECK (cardinality(read_only_chat_ids) <= 100),
    ADD COLUMN write_only_chat_ids uuid[] NOT NULL DEFAULT '{}'::uuid[]
        CHECK (cardinality(write_only_chat_ids) <= 100);

-- The activity feed reads runs of the whole workspace newest first. A plain
-- CREATE INDEX inside the migration transaction: agent_runs of a pilot
-- installation holds thousands of rows, so the write lock lasts milliseconds;
-- CONCURRENTLY would need a migration outside a transaction for no gain.
CREATE INDEX agent_runs_org_created_idx ON agent_runs(org_id, created_at DESC, id DESC);

-- Incoming webhooks are released for agents by integrations.manage, as MCP
-- connections are. Webhooks already used by an agent rule stay released, so
-- nothing changes for agents in production.
ALTER TABLE integration_webhooks ADD COLUMN agent_use_allowed boolean NOT NULL DEFAULT false;
UPDATE integration_webhooks hook SET agent_use_allowed=true
WHERE EXISTS(SELECT 1 FROM agent_triggers trigger WHERE trigger.org_id=hook.org_id AND trigger.type='webhook'
    AND trigger.superseded_at IS NULL AND trigger.config->>'webhook_id'=hook.id::text);

-- Why an agent wrote a message is recorded when it is written, so later rule
-- edits do not rewrite the past. Older messages keep NULL (kind only).
ALTER TABLE message_agent_provenance
    ADD COLUMN trigger text CHECK (trigger IS NULL OR length(trigger) <= 40),
    ADD COLUMN trigger_label text CHECK (trigger_label IS NULL OR length(trigger_label) <= 120);

-- The collection worker checks an open collection at most once a minute
-- unless a reminder or the deadline is due.
ALTER TABLE agent_collections ADD COLUMN checked_at timestamptz;

-- +goose Down
-- Only columns and an index added above are removed; no row is deleted, so
-- the step succeeds with agents, versions, runs and keys present. Version
-- configs keep the extra keys, which older Core builds ignore.
-- An agent that only reads or only writes in some chats would read and
-- write everywhere under the older schema: it is paused instead, and its
-- reminders and follow-ups stop as with any pause.
UPDATE agents SET enabled=false, operational_status='paused', updated_at=now()
WHERE (cardinality(read_only_chat_ids) > 0 OR cardinality(write_only_chat_ids) > 0) AND enabled AND deleted_at IS NULL;
UPDATE agent_collections collection SET next_reminder_at=NULL, reminders_canceled_at=COALESCE(reminders_canceled_at, now())
FROM agents agent WHERE agent.org_id=collection.org_id AND agent.actor_id=collection.agent_id AND NOT agent.enabled
    AND collection.status='open' AND collection.next_reminder_at IS NOT NULL;
UPDATE agent_followups followup SET status='canceled', reason='agent_paused', finished_at=now()
FROM agents agent WHERE agent.org_id=followup.org_id AND agent.actor_id=followup.agent_id AND NOT agent.enabled AND followup.status='pending';
ALTER TABLE agent_collections DROP COLUMN IF EXISTS checked_at;
ALTER TABLE message_agent_provenance DROP COLUMN IF EXISTS trigger_label, DROP COLUMN IF EXISTS trigger;
ALTER TABLE integration_webhooks DROP COLUMN IF EXISTS agent_use_allowed;
DROP INDEX IF EXISTS agent_runs_org_created_idx;
ALTER TABLE agent_drafts
    DROP COLUMN IF EXISTS write_only_chat_ids,
    DROP COLUMN IF EXISTS read_only_chat_ids,
    DROP COLUMN IF EXISTS tone,
    DROP COLUMN IF EXISTS confirmation_policy;
ALTER TABLE agents
    DROP COLUMN IF EXISTS write_only_chat_ids,
    DROP COLUMN IF EXISTS read_only_chat_ids,
    DROP COLUMN IF EXISTS tone,
    DROP COLUMN IF EXISTS confirmation_policy;
