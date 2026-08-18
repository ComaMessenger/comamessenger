-- +goose Up
ALTER TABLE message_revisions
    ADD COLUMN mentioned_actor_ids uuid[] NOT NULL DEFAULT '{}'::uuid[];

-- +goose Down
ALTER TABLE message_revisions DROP COLUMN IF EXISTS mentioned_actor_ids;
