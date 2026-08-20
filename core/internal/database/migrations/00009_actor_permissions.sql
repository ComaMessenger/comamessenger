-- +goose Up
CREATE TABLE actor_permissions (
    org_id uuid NOT NULL,
    actor_id uuid NOT NULL,
    permission text NOT NULL CHECK (permission IN (
        'members.manage',
        'invitations.manage',
        'workspace.settings',
        'workspace.policies',
        'branding.manage',
        'integrations.manage',
        'audit.read',
        'chats.moderate'
    )),
    granted_by uuid,
    granted_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (org_id, actor_id, permission),
    FOREIGN KEY (org_id, actor_id) REFERENCES actors(org_id, id) ON DELETE CASCADE,
    FOREIGN KEY (org_id, granted_by) REFERENCES actors(org_id, id) ON DELETE SET NULL
);

CREATE INDEX actor_permissions_actor_idx ON actor_permissions(actor_id, permission);

-- Existing administrators retain their current effective access after the
-- application switches from role checks to explicit permissions.
INSERT INTO actor_permissions (org_id, actor_id, permission, granted_by)
SELECT admin.org_id, admin.id, permissions.permission, owner.id
FROM actors admin
CROSS JOIN (VALUES
    ('members.manage'),
    ('invitations.manage'),
    ('workspace.settings'),
    ('workspace.policies'),
    ('branding.manage'),
    ('integrations.manage'),
    ('audit.read'),
    ('chats.moderate')
) AS permissions(permission)
JOIN LATERAL (
    SELECT id
    FROM actors
    WHERE org_id = admin.org_id
      AND org_role = 'owner'
      AND status = 'active'
      AND deleted_at IS NULL
    ORDER BY created_at, id
    LIMIT 1
) owner ON true
WHERE admin.org_role = 'admin'
  AND admin.status = 'active'
  AND admin.deleted_at IS NULL;

-- +goose StatementBegin
CREATE FUNCTION assert_actor_permissions_target_admin(target_actor_id uuid) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
    IF EXISTS (SELECT 1 FROM actor_permissions WHERE actor_id = target_actor_id)
       AND NOT EXISTS (
           SELECT 1
           FROM actors
           WHERE id = target_actor_id
             AND org_role = 'admin'
             AND status = 'active'
             AND deleted_at IS NULL
       ) THEN
        RAISE EXCEPTION 'only active administrators may have explicit permissions' USING ERRCODE = '23514';
    END IF;
END;
$$;
-- +goose StatementEnd

-- +goose StatementBegin
CREATE FUNCTION check_actor_permissions_target() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    PERFORM assert_actor_permissions_target_admin(COALESCE(NEW.actor_id, OLD.actor_id));
    RETURN NULL;
END;
$$;
-- +goose StatementEnd

-- +goose StatementBegin
CREATE FUNCTION check_actor_role_permissions() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    PERFORM assert_actor_permissions_target_admin(NEW.id);
    RETURN NULL;
END;
$$;
-- +goose StatementEnd

CREATE CONSTRAINT TRIGGER actor_permissions_require_admin
AFTER INSERT OR UPDATE ON actor_permissions DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION check_actor_permissions_target();

CREATE CONSTRAINT TRIGGER actors_reject_permissions_for_non_admin
AFTER UPDATE OF org_role, status, deleted_at ON actors DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION check_actor_role_permissions();

-- +goose Down
DROP TRIGGER IF EXISTS actors_reject_permissions_for_non_admin ON actors;
DROP TRIGGER IF EXISTS actor_permissions_require_admin ON actor_permissions;
DROP FUNCTION IF EXISTS check_actor_role_permissions();
DROP FUNCTION IF EXISTS check_actor_permissions_target();
DROP FUNCTION IF EXISTS assert_actor_permissions_target_admin(uuid);
DROP TABLE IF EXISTS actor_permissions;
