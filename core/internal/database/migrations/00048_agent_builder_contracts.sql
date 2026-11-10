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

-- The activity feed reads runs of the whole workspace newest first.
CREATE INDEX agent_runs_org_created_idx ON agent_runs(org_id, created_at DESC, id DESC);

-- +goose Down
-- Only columns and an index added above are removed; no row is deleted, so
-- the step succeeds with agents, versions, runs and keys present. Version
-- configs keep the extra keys, which older Core builds ignore.
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
