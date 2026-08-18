-- +goose Up
CREATE EXTENSION IF NOT EXISTS citext;

CREATE TABLE organizations (
    id uuid PRIMARY KEY,
    singleton boolean NOT NULL DEFAULT true UNIQUE CHECK (singleton),
    name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 120),
    slug citext NOT NULL UNIQUE CHECK (slug::text ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
    settings jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(settings) = 'object'),
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE actors (
    id uuid PRIMARY KEY,
    org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
    type text NOT NULL CHECK (type IN ('user', 'agent')),
    org_role text NOT NULL CHECK (org_role IN ('owner', 'admin', 'member')),
    display_name text NOT NULL CHECK (length(btrim(display_name)) BETWEEN 1 AND 120),
    handle citext NOT NULL CHECK (handle::text ~ '^[a-z0-9][a-z0-9_.-]{1,31}$'),
    avatar_file_id uuid,
    status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'deactivated')),
    timezone text NOT NULL DEFAULT 'UTC' CHECK (length(timezone) BETWEEN 1 AND 64),
    created_at timestamptz NOT NULL DEFAULT now(),
    deleted_at timestamptz,
    UNIQUE (org_id, handle),
    UNIQUE (org_id, id)
);

CREATE TABLE users (
    actor_id uuid PRIMARY KEY REFERENCES actors(id) ON DELETE RESTRICT,
    org_id uuid NOT NULL,
    email citext NOT NULL,
    password_hash text NOT NULL,
    email_verified_at timestamptz,
    last_seen_at timestamptz,
    preferences jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(preferences) = 'object'),
    UNIQUE (org_id, email),
    FOREIGN KEY (org_id, actor_id) REFERENCES actors(org_id, id) ON DELETE RESTRICT
);

CREATE TABLE sessions (
    id uuid PRIMARY KEY,
    org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
    actor_id uuid NOT NULL REFERENCES users(actor_id) ON DELETE CASCADE,
    family_id uuid NOT NULL,
    refresh_hash bytea NOT NULL UNIQUE CHECK (octet_length(refresh_hash) = 32),
    user_agent text NOT NULL DEFAULT '',
    ip_address inet,
    created_at timestamptz NOT NULL DEFAULT now(),
    last_seen_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL,
    revoked_at timestamptz,
    replaced_by uuid REFERENCES sessions(id) ON DELETE SET NULL,
    CHECK (expires_at > created_at)
);

CREATE INDEX sessions_actor_active_idx ON sessions(actor_id, created_at DESC) WHERE revoked_at IS NULL;
CREATE INDEX sessions_family_idx ON sessions(family_id);

CREATE TABLE invitations (
    id uuid PRIMARY KEY,
    org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    email citext NOT NULL,
    org_role text NOT NULL DEFAULT 'member' CHECK (org_role IN ('admin', 'member')),
    token_hash bytea NOT NULL UNIQUE CHECK (octet_length(token_hash) = 32),
    created_by uuid NOT NULL REFERENCES actors(id) ON DELETE RESTRICT,
    created_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL,
    accepted_at timestamptz,
    accepted_by uuid REFERENCES actors(id) ON DELETE RESTRICT,
    revoked_at timestamptz,
    CHECK (expires_at > created_at),
    CHECK ((accepted_at IS NULL) = (accepted_by IS NULL))
);

CREATE INDEX invitations_pending_idx ON invitations(org_id, email, expires_at)
    WHERE accepted_at IS NULL AND revoked_at IS NULL;

CREATE TABLE chats (
    id uuid PRIMARY KEY,
    org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    kind text NOT NULL CHECK (kind IN ('direct', 'group', 'channel')),
    visibility text NOT NULL CHECK (visibility IN ('private', 'public')),
    name text,
    topic text NOT NULL DEFAULT '' CHECK (length(topic) <= 500),
    direct_pair_key text,
    created_by uuid NOT NULL REFERENCES actors(id) ON DELETE RESTRICT,
    settings jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(settings) = 'object'),
    created_at timestamptz NOT NULL DEFAULT now(),
    archived_at timestamptz,
    last_message_at timestamptz,
    CHECK (
        (kind = 'direct' AND visibility = 'private' AND direct_pair_key IS NOT NULL AND name IS NULL)
        OR
        (kind IN ('group', 'channel') AND direct_pair_key IS NULL AND length(btrim(name)) BETWEEN 1 AND 120)
    ),
    UNIQUE (org_id, id)
);

CREATE UNIQUE INDEX chats_direct_pair_idx ON chats(org_id, direct_pair_key) WHERE kind = 'direct';
CREATE INDEX chats_public_idx ON chats(org_id, kind, created_at DESC) WHERE visibility = 'public' AND archived_at IS NULL;

CREATE TABLE chat_members (
    chat_id uuid NOT NULL,
    actor_id uuid NOT NULL,
    org_id uuid NOT NULL,
    role text NOT NULL CHECK (role IN ('owner', 'admin', 'member')),
    joined_at timestamptz NOT NULL DEFAULT now(),
    notify_level text NOT NULL DEFAULT 'all' CHECK (notify_level IN ('all', 'mentions', 'none')),
    muted_until timestamptz,
    PRIMARY KEY (chat_id, actor_id),
    FOREIGN KEY (org_id, chat_id) REFERENCES chats(org_id, id) ON DELETE CASCADE,
    FOREIGN KEY (org_id, actor_id) REFERENCES actors(org_id, id) ON DELETE RESTRICT
);

CREATE INDEX chat_members_actor_idx ON chat_members(actor_id, joined_at DESC);

CREATE TABLE audit_log (
    id uuid PRIMARY KEY,
    org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
    actor_id uuid REFERENCES actors(id) ON DELETE SET NULL,
    action text NOT NULL CHECK (length(action) BETWEEN 1 AND 120),
    target_type text NOT NULL CHECK (length(target_type) BETWEEN 1 AND 64),
    target_id uuid,
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX audit_log_org_created_idx ON audit_log(org_id, created_at DESC);

-- +goose StatementBegin
CREATE FUNCTION assert_organization_has_owner(target_org_id uuid) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
    IF EXISTS (SELECT 1 FROM organizations WHERE id = target_org_id)
       AND NOT EXISTS (
           SELECT 1 FROM actors
           WHERE org_id = target_org_id AND org_role = 'owner' AND status = 'active' AND deleted_at IS NULL
       ) THEN
        RAISE EXCEPTION 'organization must have at least one active owner' USING ERRCODE = '23514';
    END IF;
END;
$$;
-- +goose StatementEnd

-- +goose StatementBegin
CREATE FUNCTION check_organization_owner_from_organization() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    PERFORM assert_organization_has_owner(NEW.id);
    RETURN NULL;
END;
$$;
-- +goose StatementEnd

-- +goose StatementBegin
CREATE FUNCTION check_organization_owner_from_actor() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    affected_chat_id uuid;
BEGIN
    IF TG_OP IN ('UPDATE', 'DELETE') THEN
        PERFORM assert_organization_has_owner(OLD.org_id);
        FOR affected_chat_id IN
            SELECT chat_id FROM chat_members WHERE actor_id = OLD.id AND role = 'owner'
        LOOP
            PERFORM assert_chat_has_owner(affected_chat_id);
        END LOOP;
    END IF;
    IF TG_OP IN ('INSERT', 'UPDATE') THEN
        PERFORM assert_organization_has_owner(NEW.org_id);
    END IF;
    RETURN NULL;
END;
$$;
-- +goose StatementEnd

CREATE CONSTRAINT TRIGGER organizations_require_owner
AFTER INSERT OR UPDATE ON organizations DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION check_organization_owner_from_organization();

CREATE CONSTRAINT TRIGGER actors_preserve_organization_owner
AFTER INSERT OR UPDATE OR DELETE ON actors DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION check_organization_owner_from_actor();

-- +goose StatementBegin
CREATE FUNCTION assert_chat_has_owner(target_chat_id uuid) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM chats WHERE id = target_chat_id AND kind IN ('group', 'channel') AND archived_at IS NULL
    ) AND NOT EXISTS (
        SELECT 1
        FROM chat_members cm
        JOIN actors a ON a.id = cm.actor_id
        WHERE cm.chat_id = target_chat_id AND cm.role = 'owner'
          AND a.status = 'active' AND a.deleted_at IS NULL
    ) THEN
        RAISE EXCEPTION 'group or channel must have at least one active owner' USING ERRCODE = '23514';
    END IF;
END;
$$;
-- +goose StatementEnd

-- +goose StatementBegin
CREATE FUNCTION check_chat_owner_from_chat() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP IN ('UPDATE', 'DELETE') THEN
        PERFORM assert_chat_has_owner(OLD.id);
    END IF;
    IF TG_OP IN ('INSERT', 'UPDATE') THEN
        PERFORM assert_chat_has_owner(NEW.id);
    END IF;
    RETURN NULL;
END;
$$;
-- +goose StatementEnd

-- +goose StatementBegin
CREATE FUNCTION check_chat_owner_from_member() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP IN ('UPDATE', 'DELETE') THEN
        PERFORM assert_chat_has_owner(OLD.chat_id);
    END IF;
    IF TG_OP IN ('INSERT', 'UPDATE') THEN
        PERFORM assert_chat_has_owner(NEW.chat_id);
    END IF;
    RETURN NULL;
END;
$$;
-- +goose StatementEnd

CREATE CONSTRAINT TRIGGER chats_require_owner
AFTER INSERT OR UPDATE OR DELETE ON chats DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION check_chat_owner_from_chat();

CREATE CONSTRAINT TRIGGER chat_members_preserve_owner
AFTER INSERT OR UPDATE OR DELETE ON chat_members DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION check_chat_owner_from_member();

-- +goose Down
DROP TRIGGER IF EXISTS chat_members_preserve_owner ON chat_members;
DROP TRIGGER IF EXISTS chats_require_owner ON chats;
DROP FUNCTION IF EXISTS check_chat_owner_from_member();
DROP FUNCTION IF EXISTS check_chat_owner_from_chat();
DROP FUNCTION IF EXISTS assert_chat_has_owner(uuid);
DROP TRIGGER IF EXISTS actors_preserve_organization_owner ON actors;
DROP TRIGGER IF EXISTS organizations_require_owner ON organizations;
DROP FUNCTION IF EXISTS check_organization_owner_from_actor();
DROP FUNCTION IF EXISTS check_organization_owner_from_organization();
DROP FUNCTION IF EXISTS assert_organization_has_owner(uuid);
DROP TABLE IF EXISTS audit_log;
DROP TABLE IF EXISTS chat_members;
DROP TABLE IF EXISTS chats;
DROP TABLE IF EXISTS invitations;
DROP TABLE IF EXISTS sessions;
DROP TABLE IF EXISTS users;
DROP TABLE IF EXISTS actors;
DROP TABLE IF EXISTS organizations;
DROP EXTENSION IF EXISTS citext;
