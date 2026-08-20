-- +goose Up
-- Ownership is a singleton capability. The existing deferred constraint keeps
-- at least one active owner; this index prevents two concurrent active owners.
CREATE UNIQUE INDEX actors_one_active_owner_per_org
ON actors(org_id)
WHERE org_role = 'owner' AND status = 'active' AND deleted_at IS NULL;

-- +goose Down
DROP INDEX IF EXISTS actors_one_active_owner_per_org;
