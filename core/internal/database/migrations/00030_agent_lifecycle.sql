-- +goose Up
ALTER TABLE agents
    ADD COLUMN recipe text NOT NULL DEFAULT 'custom'
        CHECK (recipe IN ('custom', 'summarizer', 'qa', 'onboarding')),
    ADD COLUMN recipe_version integer NOT NULL DEFAULT 1 CHECK (recipe_version > 0),
    ADD COLUMN execution_timeout_seconds integer NOT NULL DEFAULT 600
        CHECK (execution_timeout_seconds BETWEEN 30 AND 3600),
    ADD COLUMN deleted_at timestamptz;

CREATE INDEX agents_org_active_idx ON agents(org_id, created_at DESC)
    WHERE deleted_at IS NULL;

-- +goose StatementBegin
CREATE OR REPLACE FUNCTION assert_agent_actor_types(target_agent_id uuid) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
    target agents%ROWTYPE;
BEGIN
    SELECT * INTO target FROM agents WHERE actor_id = target_agent_id;
    IF NOT FOUND THEN
        RETURN;
    END IF;
    IF target.deleted_at IS NULL AND NOT EXISTS (
        SELECT 1 FROM actors
        WHERE org_id = target.org_id AND id = target.actor_id AND type = 'agent'
          AND status = 'active' AND deleted_at IS NULL
    ) THEN
        RAISE EXCEPTION 'active agent row requires an active agent actor' USING ERRCODE = '23514';
    END IF;
    IF target.deleted_at IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM actors
        WHERE org_id = target.org_id AND id = target.actor_id AND type = 'agent'
          AND status = 'deactivated' AND deleted_at IS NOT NULL
    ) THEN
        RAISE EXCEPTION 'deleted agent row requires a deactivated agent actor' USING ERRCODE = '23514';
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM actors
        WHERE org_id = target.org_id AND id = target.owner_actor_id AND type = 'user'
          AND status = 'active' AND deleted_at IS NULL
    ) THEN
        RAISE EXCEPTION 'agent owner must be an active user actor' USING ERRCODE = '23514';
    END IF;
END;
$$;
-- +goose StatementEnd

-- +goose Down
DROP INDEX IF EXISTS agents_org_active_idx;

-- +goose StatementBegin
CREATE OR REPLACE FUNCTION assert_agent_actor_types(target_agent_id uuid) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
    target agents%ROWTYPE;
BEGIN
    SELECT * INTO target FROM agents WHERE actor_id = target_agent_id;
    IF NOT FOUND THEN
        RETURN;
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM actors
        WHERE org_id = target.org_id AND id = target.actor_id AND type = 'agent'
          AND status = 'active' AND deleted_at IS NULL
    ) THEN
        RAISE EXCEPTION 'agent row requires an active agent actor' USING ERRCODE = '23514';
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM actors
        WHERE org_id = target.org_id AND id = target.owner_actor_id AND type = 'user'
          AND status = 'active' AND deleted_at IS NULL
    ) THEN
        RAISE EXCEPTION 'agent owner must be an active user actor' USING ERRCODE = '23514';
    END IF;
END;
$$;
-- +goose StatementEnd

ALTER TABLE agents
    DROP COLUMN deleted_at,
    DROP COLUMN execution_timeout_seconds,
    DROP COLUMN recipe_version,
    DROP COLUMN recipe;
