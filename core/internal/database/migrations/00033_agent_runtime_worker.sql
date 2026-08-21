-- +goose Up
ALTER TABLE agents DROP CONSTRAINT agents_allowed_scopes_check;
ALTER TABLE agents ADD CONSTRAINT agents_allowed_scopes_check CHECK (allowed_scopes <@ ARRAY[
    'chats:read', 'messages:read', 'messages:write', 'reactions:write',
    'files:read', 'search:read', 'members:read', 'memory:read', 'memory:write',
    'runtime:execute', 'runtime:worker'
]::text[]);
ALTER TABLE agent_api_keys DROP CONSTRAINT agent_api_keys_scopes_check;
ALTER TABLE agent_api_keys ADD CONSTRAINT agent_api_keys_scopes_check CHECK (scopes <@ ARRAY[
    'chats:read', 'messages:read', 'messages:write', 'reactions:write',
    'files:read', 'search:read', 'members:read', 'memory:read', 'memory:write',
    'runtime:execute', 'runtime:worker'
]::text[]);

-- +goose Down
UPDATE agent_api_keys SET revoked_at=COALESCE(revoked_at,now()) WHERE 'runtime:worker'=ANY(scopes);
UPDATE agents SET allowed_scopes=array_remove(allowed_scopes,'runtime:worker');
ALTER TABLE agent_api_keys DROP CONSTRAINT agent_api_keys_scopes_check;
ALTER TABLE agent_api_keys ADD CONSTRAINT agent_api_keys_scopes_check CHECK (scopes <@ ARRAY[
    'chats:read', 'messages:read', 'messages:write', 'reactions:write',
    'files:read', 'search:read', 'members:read', 'memory:read', 'memory:write', 'runtime:execute'
]::text[]);
ALTER TABLE agents DROP CONSTRAINT agents_allowed_scopes_check;
ALTER TABLE agents ADD CONSTRAINT agents_allowed_scopes_check CHECK (allowed_scopes <@ ARRAY[
    'chats:read', 'messages:read', 'messages:write', 'reactions:write',
    'files:read', 'search:read', 'members:read', 'memory:read', 'memory:write', 'runtime:execute'
]::text[]);
