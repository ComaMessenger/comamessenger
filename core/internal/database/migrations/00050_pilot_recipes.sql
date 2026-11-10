-- +goose Up
-- Phase 5.3 pilot recipes: three new built-in roles next to the existing ids
-- (qa, onboarding and summarizer keep their ids, so existing agents stay on
-- their recipe), and room for step-by-step instructions of the pilot roles.
ALTER TABLE agents DROP CONSTRAINT IF EXISTS agents_recipe_check;
ALTER TABLE agents ADD CONSTRAINT agents_recipe_check
    CHECK (recipe IN ('custom', 'summarizer', 'qa', 'onboarding', 'control', 'slots', 'handoff'));
ALTER TABLE agent_drafts DROP CONSTRAINT IF EXISTS agent_drafts_recipe_check;
ALTER TABLE agent_drafts ADD CONSTRAINT agent_drafts_recipe_check
    CHECK (recipe IN ('custom', 'summarizer', 'qa', 'onboarding', 'control', 'slots', 'handoff'));
ALTER TABLE agents DROP CONSTRAINT IF EXISTS agents_description_check;
ALTER TABLE agents ADD CONSTRAINT agents_description_check CHECK (length(description) <= 4000);
ALTER TABLE agent_drafts DROP CONSTRAINT IF EXISTS agent_drafts_description_check;
ALTER TABLE agent_drafts ADD CONSTRAINT agent_drafts_description_check CHECK (length(description) <= 4000);

-- Personal agent cards (send_direct_card) need their own scope; existing
-- agents and keys do not get it. The scope is appended to whatever the
-- current constraints allow, so scopes added by other migrations survive.
-- +goose StatementBegin
DO $$
DECLARE
    target record;
    definition text;
BEGIN
    FOR target IN SELECT * FROM (VALUES ('agents', 'agents_allowed_scopes_check'), ('agent_api_keys', 'agent_api_keys_scopes_check')) AS t(tbl, con) LOOP
        SELECT pg_get_constraintdef(c.oid) INTO definition FROM pg_constraint c WHERE c.conname = target.con AND c.conrelid = target.tbl::regclass;
        IF definition IS NOT NULL AND position('messages:direct_cards' IN definition) = 0 THEN
            EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I', target.tbl, target.con);
            EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I %s', target.tbl, target.con,
                replace(definition, '::text]', '::text, ''messages:direct_cards''::text]'));
        END IF;
    END LOOP;
END $$;
-- +goose StatementEnd

-- Everything an agent delivers to one person privately (direct messages,
-- direct cards, edits of a direct card, direct reminders). Daily caps per
-- agent and per person across all agents are counted here.
CREATE TABLE agent_direct_deliveries (
    id uuid PRIMARY KEY,
    org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    agent_id uuid NOT NULL,
    actor_id uuid NOT NULL,
    kind text NOT NULL CHECK (kind IN ('message', 'card', 'card_update', 'reminder')),
    message_id uuid,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX agent_direct_deliveries_person_idx ON agent_direct_deliveries(org_id, actor_id, created_at DESC);

-- +goose Down
DROP TABLE IF EXISTS agent_direct_deliveries;
UPDATE agent_api_keys SET revoked_at=COALESCE(revoked_at,now()) WHERE 'messages:direct_cards'=ANY(scopes);
UPDATE agent_api_keys SET scopes=array_remove(scopes,'messages:direct_cards');
UPDATE agents SET allowed_scopes=array_remove(allowed_scopes,'messages:direct_cards');
UPDATE agent_drafts SET allowed_scopes=array_remove(allowed_scopes,'messages:direct_cards');
-- +goose StatementBegin
DO $$
DECLARE
    target record;
    definition text;
BEGIN
    FOR target IN SELECT * FROM (VALUES ('agents', 'agents_allowed_scopes_check'), ('agent_api_keys', 'agent_api_keys_scopes_check')) AS t(tbl, con) LOOP
        SELECT pg_get_constraintdef(c.oid) INTO definition FROM pg_constraint c WHERE c.conname = target.con AND c.conrelid = target.tbl::regclass;
        IF definition IS NOT NULL AND position('messages:direct_cards' IN definition) > 0 THEN
            EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I', target.tbl, target.con);
            EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I %s', target.tbl, target.con,
                replace(definition, ', ''messages:direct_cards''::text', ''));
        END IF;
    END LOOP;
END $$;
-- +goose StatementEnd
UPDATE agent_drafts SET recipe='custom' WHERE recipe IN ('control', 'slots', 'handoff');
UPDATE agents SET recipe='custom' WHERE recipe IN ('control', 'slots', 'handoff');
UPDATE agent_drafts SET description=left(description, 2000) WHERE length(description) > 2000;
UPDATE agents SET description=left(description, 2000) WHERE length(description) > 2000;
ALTER TABLE agent_drafts DROP CONSTRAINT IF EXISTS agent_drafts_description_check;
ALTER TABLE agent_drafts ADD CONSTRAINT agent_drafts_description_check CHECK (length(description) <= 2000);
ALTER TABLE agents DROP CONSTRAINT IF EXISTS agents_description_check;
ALTER TABLE agents ADD CONSTRAINT agents_description_check CHECK (length(description) <= 2000);
ALTER TABLE agent_drafts DROP CONSTRAINT IF EXISTS agent_drafts_recipe_check;
ALTER TABLE agent_drafts ADD CONSTRAINT agent_drafts_recipe_check
    CHECK (recipe IN ('custom', 'summarizer', 'qa', 'onboarding'));
ALTER TABLE agents DROP CONSTRAINT IF EXISTS agents_recipe_check;
ALTER TABLE agents ADD CONSTRAINT agents_recipe_check
    CHECK (recipe IN ('custom', 'summarizer', 'qa', 'onboarding'));
