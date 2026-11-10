-- +goose Up
ALTER TABLE chats ADD COLUMN avatar_file_id uuid;
ALTER TABLE chats
    ADD CONSTRAINT chats_avatar_file_fk
    FOREIGN KEY (org_id, avatar_file_id) REFERENCES files(org_id, id) ON DELETE SET NULL (avatar_file_id);
ALTER TABLE chats ADD COLUMN avatar_version bigint NOT NULL DEFAULT 0 CHECK (avatar_version >= 0);
CREATE INDEX chats_avatar_file_idx ON chats(org_id, avatar_file_id) WHERE avatar_file_id IS NOT NULL;

-- +goose Down
DROP INDEX IF EXISTS chats_avatar_file_idx;
ALTER TABLE chats DROP CONSTRAINT IF EXISTS chats_avatar_file_fk;
ALTER TABLE chats DROP COLUMN IF EXISTS avatar_version;
ALTER TABLE chats DROP COLUMN IF EXISTS avatar_file_id;
