-- +goose Up

-- knowledge.manage is the first permission that may also be granted to a
-- regular member. Every other explicit permission still requires an active
-- administrator.
ALTER TABLE actor_permissions DROP CONSTRAINT actor_permissions_permission_check;
ALTER TABLE actor_permissions ADD CONSTRAINT actor_permissions_permission_check CHECK (permission IN (
    'members.manage','invitations.manage','workspace.settings','workspace.policies',
    'branding.manage','integrations.manage','agents.manage','agents.build',
    'agents.publish','agents.approve','agents.observe','audit.read','chats.moderate',
    'knowledge.manage'
));

-- +goose StatementBegin
CREATE OR REPLACE FUNCTION assert_actor_permissions_target_admin(target_actor_id uuid) RETURNS void
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
       )
       AND (
           EXISTS (
               SELECT 1 FROM actor_permissions
               WHERE actor_id = target_actor_id AND permission <> 'knowledge.manage'
           )
           OR NOT EXISTS (
               SELECT 1
               FROM actors
               WHERE id = target_actor_id
                 AND org_role = 'member'
                 AND status = 'active'
                 AND deleted_at IS NULL
           )
       ) THEN
        RAISE EXCEPTION 'only active administrators may have explicit permissions' USING ERRCODE = '23514';
    END IF;
END;
$$;
-- +goose StatementEnd

-- Administrators manage the knowledge base by default; the owner may revoke it.
INSERT INTO actor_permissions (org_id, actor_id, permission, granted_by)
SELECT admin.org_id, admin.id, 'knowledge.manage', owner.id
FROM actors admin
JOIN LATERAL (
    SELECT id FROM actors
    WHERE org_id = admin.org_id AND org_role = 'owner' AND status = 'active' AND deleted_at IS NULL
    ORDER BY created_at, id
    LIMIT 1
) owner ON true
WHERE admin.org_role = 'admin' AND admin.status = 'active' AND admin.deleted_at IS NULL
ON CONFLICT DO NOTHING;

ALTER TABLE agents DROP CONSTRAINT agents_allowed_scopes_check;
ALTER TABLE agents ADD CONSTRAINT agents_allowed_scopes_check CHECK (allowed_scopes <@ ARRAY[
    'chats:read', 'messages:read', 'messages:write', 'reactions:write',
    'files:read', 'search:read', 'members:read', 'memory:read', 'memory:write',
    'runtime:execute', 'runtime:worker', 'knowledge:read'
]::text[]);
ALTER TABLE agent_api_keys DROP CONSTRAINT agent_api_keys_scopes_check;
ALTER TABLE agent_api_keys ADD CONSTRAINT agent_api_keys_scopes_check CHECK (scopes <@ ARRAY[
    'chats:read', 'messages:read', 'messages:write', 'reactions:write',
    'files:read', 'search:read', 'members:read', 'memory:read', 'memory:write',
    'runtime:execute', 'runtime:worker', 'knowledge:read'
]::text[]);

-- Embeddings are generated only through a connection that names an embedding
-- model and explicitly allows document text to leave the deployment.
ALTER TABLE agent_llm_connections
    ADD COLUMN embedding_model text NOT NULL DEFAULT '' CHECK (length(embedding_model) <= 200),
    ADD COLUMN embedding_data_sharing_approved boolean NOT NULL DEFAULT false;

-- Bound collections follow the 5.2 draft/publish model: the draft keeps the
-- edited set, publishing copies it to the agent and into the version config.
ALTER TABLE agents ADD COLUMN knowledge_collection_ids uuid[] NOT NULL DEFAULT '{}'::uuid[]
    CHECK (cardinality(knowledge_collection_ids) <= 50);
ALTER TABLE agent_drafts ADD COLUMN knowledge_collection_ids uuid[] NOT NULL DEFAULT '{}'::uuid[]
    CHECK (cardinality(knowledge_collection_ids) <= 50);

CREATE TABLE knowledge_collections (
    id uuid PRIMARY KEY,
    org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 120),
    description text NOT NULL DEFAULT '' CHECK (length(description) <= 2000),
    access text NOT NULL DEFAULT 'organization' CHECK (access IN ('organization', 'chats')),
    embedding_connection_id uuid,
    created_by uuid NOT NULL,
    updated_by uuid NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (org_id, id),
    FOREIGN KEY (org_id, embedding_connection_id) REFERENCES agent_llm_connections(org_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (org_id, created_by) REFERENCES actors(org_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (org_id, updated_by) REFERENCES actors(org_id, id) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX knowledge_collections_org_name_idx ON knowledge_collections(org_id, lower(btrim(name)));
CREATE INDEX knowledge_collections_embedding_connection_idx ON knowledge_collections(embedding_connection_id)
    WHERE embedding_connection_id IS NOT NULL;

CREATE TABLE knowledge_collection_chats (
    org_id uuid NOT NULL,
    collection_id uuid NOT NULL,
    chat_id uuid NOT NULL,
    PRIMARY KEY (collection_id, chat_id),
    FOREIGN KEY (org_id, collection_id) REFERENCES knowledge_collections(org_id, id) ON DELETE CASCADE,
    FOREIGN KEY (org_id, chat_id) REFERENCES chats(org_id, id) ON DELETE CASCADE
);

CREATE INDEX knowledge_collection_chats_chat_idx ON knowledge_collection_chats(org_id, chat_id);

CREATE TABLE knowledge_documents (
    id uuid PRIMARY KEY,
    org_id uuid NOT NULL,
    collection_id uuid NOT NULL,
    kind text NOT NULL CHECK (kind IN ('file', 'page')),
    title text NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 255),
    file_id uuid,
    body text CHECK (body IS NULL OR octet_length(body) <= 1048576),
    status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'ready', 'failed')),
    error_code text NOT NULL DEFAULT '' CHECK (length(error_code) <= 120),
    embedding_status text NOT NULL DEFAULT 'none' CHECK (embedding_status IN ('none', 'pending', 'ready', 'failed')),
    content_version integer NOT NULL DEFAULT 1 CHECK (content_version > 0),
    chunk_count integer NOT NULL DEFAULT 0 CHECK (chunk_count >= 0),
    indexed_at timestamptz,
    created_by uuid NOT NULL,
    updated_by uuid NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (org_id, id),
    CHECK ((kind = 'file') = (file_id IS NOT NULL)),
    CHECK ((kind = 'page') = (body IS NOT NULL)),
    FOREIGN KEY (org_id, collection_id) REFERENCES knowledge_collections(org_id, id) ON DELETE CASCADE,
    FOREIGN KEY (org_id, file_id) REFERENCES files(org_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (org_id, created_by) REFERENCES actors(org_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (org_id, updated_by) REFERENCES actors(org_id, id) ON DELETE RESTRICT
);

CREATE INDEX knowledge_documents_collection_idx ON knowledge_documents(org_id, collection_id, updated_at DESC);
CREATE INDEX knowledge_documents_file_idx ON knowledge_documents(file_id) WHERE file_id IS NOT NULL;

CREATE TABLE knowledge_chunks (
    id uuid PRIMARY KEY,
    org_id uuid NOT NULL,
    collection_id uuid NOT NULL,
    document_id uuid NOT NULL,
    position integer NOT NULL CHECK (position >= 0),
    section text NOT NULL DEFAULT '' CHECK (length(section) <= 500),
    content text NOT NULL CHECK (length(content) BETWEEN 1 AND 8000),
    search_vector tsvector GENERATED ALWAYS AS (
        setweight(to_tsvector('russian'::regconfig, coalesce(section, '')), 'A') ||
        setweight(to_tsvector('english'::regconfig, coalesce(section, '')), 'A') ||
        setweight(to_tsvector('simple'::regconfig, coalesce(section, '')), 'A') ||
        setweight(to_tsvector('russian'::regconfig, coalesce(content, '')), 'B') ||
        setweight(to_tsvector('english'::regconfig, coalesce(content, '')), 'B') ||
        setweight(to_tsvector('simple'::regconfig, coalesce(content, '')), 'B')
    ) STORED,
    embedding_provider text CHECK (embedding_provider IS NULL OR length(embedding_provider) BETWEEN 1 AND 100),
    embedding_model text CHECK (embedding_model IS NULL OR length(embedding_model) BETWEEN 1 AND 200),
    embedding_dimensions integer CHECK (embedding_dimensions BETWEEN 1 AND 4096),
    embedding vector,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (document_id, position),
    UNIQUE (org_id, id),
    FOREIGN KEY (org_id, document_id) REFERENCES knowledge_documents(org_id, id) ON DELETE CASCADE,
    FOREIGN KEY (org_id, collection_id) REFERENCES knowledge_collections(org_id, id) ON DELETE CASCADE,
    CHECK ((embedding IS NULL) = (embedding_dimensions IS NULL)),
    CHECK ((embedding IS NULL) = (embedding_model IS NULL)),
    CHECK (embedding IS NULL OR vector_dims(embedding) = embedding_dimensions)
);

CREATE INDEX knowledge_chunks_search_vector_idx ON knowledge_chunks USING gin(search_vector);
CREATE INDEX knowledge_chunks_collection_idx ON knowledge_chunks(org_id, collection_id);

-- Every fragment handed to a model is recorded per tool call. Chunk and
-- document ids deliberately carry no foreign key: the audit trail survives
-- document deletion, the text itself does not.
CREATE TABLE agent_run_knowledge_chunks (
    org_id uuid NOT NULL,
    run_id uuid NOT NULL,
    tool_call_id uuid NOT NULL REFERENCES agent_tool_calls(id) ON DELETE CASCADE,
    chunk_id uuid NOT NULL,
    document_id uuid NOT NULL,
    collection_id uuid NOT NULL,
    document_title text NOT NULL CHECK (length(document_title) <= 255),
    section text NOT NULL DEFAULT '' CHECK (length(section) <= 500),
    position integer NOT NULL CHECK (position >= 0),
    rank smallint NOT NULL CHECK (rank > 0),
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tool_call_id, chunk_id),
    FOREIGN KEY (org_id, run_id) REFERENCES agent_runs(org_id, id) ON DELETE CASCADE
);

CREATE INDEX agent_run_knowledge_chunks_run_idx ON agent_run_knowledge_chunks(org_id, run_id, created_at);

-- +goose Down
DROP TABLE IF EXISTS agent_run_knowledge_chunks;
DROP TABLE IF EXISTS knowledge_chunks;
DROP TABLE IF EXISTS knowledge_documents;
DROP TABLE IF EXISTS knowledge_collection_chats;
DROP TABLE IF EXISTS knowledge_collections;
ALTER TABLE agent_drafts DROP COLUMN IF EXISTS knowledge_collection_ids;
ALTER TABLE agents DROP COLUMN IF EXISTS knowledge_collection_ids;
ALTER TABLE agent_llm_connections
    DROP COLUMN IF EXISTS embedding_data_sharing_approved,
    DROP COLUMN IF EXISTS embedding_model;

UPDATE agent_api_keys SET revoked_at = COALESCE(revoked_at, now()) WHERE 'knowledge:read' = ANY(scopes);
UPDATE agent_api_keys SET scopes = array_remove(scopes, 'knowledge:read');
UPDATE agents SET allowed_scopes = array_remove(allowed_scopes, 'knowledge:read');
UPDATE agent_drafts SET allowed_scopes = array_remove(allowed_scopes, 'knowledge:read');
ALTER TABLE agent_api_keys DROP CONSTRAINT agent_api_keys_scopes_check;
ALTER TABLE agent_api_keys ADD CONSTRAINT agent_api_keys_scopes_check CHECK (scopes <@ ARRAY[
    'chats:read', 'messages:read', 'messages:write', 'reactions:write',
    'files:read', 'search:read', 'members:read', 'memory:read', 'memory:write',
    'runtime:execute', 'runtime:worker'
]::text[]);
ALTER TABLE agents DROP CONSTRAINT agents_allowed_scopes_check;
ALTER TABLE agents ADD CONSTRAINT agents_allowed_scopes_check CHECK (allowed_scopes <@ ARRAY[
    'chats:read', 'messages:read', 'messages:write', 'reactions:write',
    'files:read', 'search:read', 'members:read', 'memory:read', 'memory:write',
    'runtime:execute', 'runtime:worker'
]::text[]);

DELETE FROM actor_permissions WHERE permission = 'knowledge.manage';

-- +goose StatementBegin
CREATE OR REPLACE FUNCTION assert_actor_permissions_target_admin(target_actor_id uuid) RETURNS void
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

ALTER TABLE actor_permissions DROP CONSTRAINT actor_permissions_permission_check;
ALTER TABLE actor_permissions ADD CONSTRAINT actor_permissions_permission_check CHECK (permission IN (
    'members.manage','invitations.manage','workspace.settings','workspace.policies',
    'branding.manage','integrations.manage','agents.manage','agents.build',
    'agents.publish','agents.approve','agents.observe','audit.read','chats.moderate'
));
