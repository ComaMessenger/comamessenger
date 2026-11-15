-- +goose Up
-- Org structure («Оргструктура», phase 6.5 wave 2, package S1): departments
-- with nesting, a lead and primary/additional memberships, a directory of
-- positions with one position per person, and two permissions a regular
-- member may hold: org.manage («Вести оргструктуру») and
-- requests.address_groups («Обращаться к отделам и ролям»).
--
-- Rules the schema cannot express (no cycles, depth 8, limits, a lead is a
-- member, exactly one primary membership while a person has any) are kept by
-- core/internal/orgstructure under the organization row lock.
--
-- organizations.org_version grows by one with every write of the structure;
-- GET /org returns it as the ETag and org.updated carries it.

ALTER TABLE organizations ADD COLUMN org_version bigint NOT NULL DEFAULT 1 CHECK (org_version > 0);

CREATE TABLE positions (
    org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    id uuid PRIMARY KEY,
    name text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 60 AND name = btrim(name)),
    sort_key integer,
    version integer NOT NULL DEFAULT 1 CHECK (version > 0),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (org_id, id)
);
CREATE UNIQUE INDEX positions_name_idx ON positions(org_id, lower(btrim(name)));

CREATE TABLE departments (
    org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    id uuid PRIMARY KEY,
    parent_id uuid,
    name text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 60 AND name = btrim(name)),
    lead_actor_id uuid,
    chat_id uuid,
    sort_key integer,
    version integer NOT NULL DEFAULT 1 CHECK (version > 0),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (org_id, id),
    CHECK (parent_id IS DISTINCT FROM id),
    -- No cascade: the service moves the children of a deleted department.
    FOREIGN KEY (org_id, parent_id) REFERENCES departments(org_id, id),
    FOREIGN KEY (org_id, lead_actor_id) REFERENCES actors(org_id, id) ON DELETE SET NULL (lead_actor_id),
    FOREIGN KEY (org_id, chat_id) REFERENCES chats(org_id, id) ON DELETE SET NULL (chat_id)
);
-- A name is unique among siblings, ignoring case.
CREATE UNIQUE INDEX departments_sibling_name_idx
    ON departments(org_id, coalesce(parent_id, '00000000-0000-0000-0000-000000000000'::uuid), lower(btrim(name)));
CREATE INDEX departments_parent_idx ON departments(org_id, parent_id);
-- One department per chat.
CREATE UNIQUE INDEX departments_chat_idx ON departments(chat_id) WHERE chat_id IS NOT NULL;
CREATE INDEX departments_lead_idx ON departments(org_id, lead_actor_id) WHERE lead_actor_id IS NOT NULL;

CREATE TABLE department_members (
    org_id uuid NOT NULL,
    department_id uuid NOT NULL,
    actor_id uuid NOT NULL,
    is_primary boolean NOT NULL,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (department_id, actor_id),
    FOREIGN KEY (org_id, department_id) REFERENCES departments(org_id, id) ON DELETE CASCADE,
    FOREIGN KEY (org_id, actor_id) REFERENCES actors(org_id, id) ON DELETE CASCADE
);
-- One primary department per person.
CREATE UNIQUE INDEX department_members_primary_idx ON department_members(org_id, actor_id) WHERE is_primary;
CREATE INDEX department_members_actor_idx ON department_members(org_id, actor_id);

ALTER TABLE actors ADD COLUMN position_id uuid;
ALTER TABLE actors ADD CONSTRAINT actors_position_fk
    FOREIGN KEY (org_id, position_id) REFERENCES positions(org_id, id) ON DELETE SET NULL (position_id);
ALTER TABLE actors ADD CONSTRAINT actors_position_user_check CHECK (position_id IS NULL OR type = 'user');
CREATE INDEX actors_position_idx ON actors(org_id, position_id) WHERE position_id IS NOT NULL;

-- Permissions. A regular member may hold knowledge.manage, org.manage and
-- requests.address_groups; everything else still needs an active
-- administrator. Neither new permission is granted to anyone here:
-- members.manage covers org.manage, and requests.address_groups is not given
-- to administrators by default (owner's decision).
ALTER TABLE actor_permissions DROP CONSTRAINT actor_permissions_permission_check;
ALTER TABLE actor_permissions ADD CONSTRAINT actor_permissions_permission_check CHECK (permission IN (
    'members.manage','invitations.manage','workspace.settings','workspace.policies',
    'branding.manage','integrations.manage','agents.manage','agents.build',
    'agents.publish','agents.approve','agents.observe','audit.read','chats.moderate',
    'knowledge.manage','org.manage','requests.address_groups'
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
               WHERE actor_id = target_actor_id
                 AND permission NOT IN ('knowledge.manage', 'org.manage', 'requests.address_groups')
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

-- +goose Down
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

DELETE FROM actor_permissions WHERE permission IN ('org.manage', 'requests.address_groups');
ALTER TABLE actor_permissions DROP CONSTRAINT actor_permissions_permission_check;
ALTER TABLE actor_permissions ADD CONSTRAINT actor_permissions_permission_check CHECK (permission IN (
    'members.manage','invitations.manage','workspace.settings','workspace.policies',
    'branding.manage','integrations.manage','agents.manage','agents.build',
    'agents.publish','agents.approve','agents.observe','audit.read','chats.moderate',
    'knowledge.manage'
));

ALTER TABLE actors DROP CONSTRAINT IF EXISTS actors_position_user_check;
ALTER TABLE actors DROP CONSTRAINT IF EXISTS actors_position_fk;
DROP INDEX IF EXISTS actors_position_idx;
ALTER TABLE actors DROP COLUMN IF EXISTS position_id;
DROP TABLE IF EXISTS department_members;
DROP TABLE IF EXISTS departments;
DROP TABLE IF EXISTS positions;
ALTER TABLE organizations DROP COLUMN IF EXISTS org_version;
