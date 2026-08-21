-- +goose Up
ALTER TABLE chat_members DROP CONSTRAINT chat_members_notify_level_check;
UPDATE chat_members SET notify_level='default' WHERE notify_level='all';
SET CONSTRAINTS ALL IMMEDIATE;
ALTER TABLE chat_members ALTER COLUMN notify_level SET DEFAULT 'default';
ALTER TABLE chat_members ADD CONSTRAINT chat_members_notify_level_check
    CHECK (notify_level IN ('default', 'all', 'mentions', 'none'));

-- +goose Down
ALTER TABLE chat_members DROP CONSTRAINT chat_members_notify_level_check;
UPDATE chat_members SET notify_level='all' WHERE notify_level='default';
SET CONSTRAINTS ALL IMMEDIATE;
ALTER TABLE chat_members ALTER COLUMN notify_level SET DEFAULT 'all';
ALTER TABLE chat_members ADD CONSTRAINT chat_members_notify_level_check
    CHECK (notify_level IN ('all', 'mentions', 'none'));
