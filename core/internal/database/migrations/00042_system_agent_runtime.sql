-- +goose Up
ALTER TABLE agents
    ADD COLUMN system_role text
        CHECK (system_role IS NULL OR system_role IN ('runtime_worker'));

CREATE UNIQUE INDEX agents_system_role_idx
    ON agents(org_id, system_role)
    WHERE system_role IS NOT NULL AND deleted_at IS NULL;

-- +goose Down
DELETE FROM actors
WHERE id IN (SELECT actor_id FROM agents WHERE system_role='runtime_worker');
DROP INDEX IF EXISTS agents_system_role_idx;
ALTER TABLE agents DROP COLUMN IF EXISTS system_role;
