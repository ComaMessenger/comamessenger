-- +goose Up
-- +goose StatementBegin
CREATE FUNCTION assert_agent_actor_types(target_agent_id uuid) RETURNS void
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

-- +goose StatementBegin
CREATE FUNCTION check_agent_actor_types() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    PERFORM assert_agent_actor_types(NEW.actor_id);
    RETURN NULL;
END;
$$;
-- +goose StatementEnd

-- +goose StatementBegin
CREATE FUNCTION check_actor_agent_references() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    referenced_agent_id uuid;
BEGIN
    FOR referenced_agent_id IN
        SELECT actor_id FROM agents WHERE actor_id = NEW.id OR owner_actor_id = NEW.id
    LOOP
        PERFORM assert_agent_actor_types(referenced_agent_id);
    END LOOP;
    RETURN NULL;
END;
$$;
-- +goose StatementEnd

CREATE CONSTRAINT TRIGGER agents_require_actor_types
AFTER INSERT OR UPDATE OF actor_id, org_id, owner_actor_id ON agents
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_agent_actor_types();

CREATE CONSTRAINT TRIGGER actors_preserve_agent_references
AFTER UPDATE OF type, status, deleted_at ON actors
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_actor_agent_references();

-- +goose Down
DROP TRIGGER IF EXISTS actors_preserve_agent_references ON actors;
DROP TRIGGER IF EXISTS agents_require_actor_types ON agents;
DROP FUNCTION IF EXISTS check_actor_agent_references();
DROP FUNCTION IF EXISTS check_agent_actor_types();
DROP FUNCTION IF EXISTS assert_agent_actor_types(uuid);
