-- +goose Up
ALTER TABLE actor_permissions DROP CONSTRAINT actor_permissions_permission_check;
ALTER TABLE actor_permissions ADD CONSTRAINT actor_permissions_permission_check CHECK (permission IN (
    'members.manage','invitations.manage','workspace.settings','workspace.policies',
    'branding.manage','integrations.manage','agents.manage','agents.build',
    'agents.publish','agents.approve','agents.observe','audit.read','chats.moderate'
));

INSERT INTO actor_permissions(org_id,actor_id,permission,granted_by)
SELECT legacy.org_id,legacy.actor_id,expanded.permission,legacy.granted_by
FROM actor_permissions legacy
CROSS JOIN (VALUES ('agents.build'),('agents.publish'),('agents.approve'),('agents.observe')) expanded(permission)
WHERE legacy.permission='agents.manage'
ON CONFLICT DO NOTHING;

-- +goose Down
DELETE FROM actor_permissions WHERE permission IN ('agents.build','agents.publish','agents.approve','agents.observe');
ALTER TABLE actor_permissions DROP CONSTRAINT actor_permissions_permission_check;
ALTER TABLE actor_permissions ADD CONSTRAINT actor_permissions_permission_check CHECK (permission IN (
    'members.manage','invitations.manage','workspace.settings','workspace.policies',
    'branding.manage','integrations.manage','agents.manage','audit.read','chats.moderate'
));
