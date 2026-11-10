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

-- +goose Down
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
