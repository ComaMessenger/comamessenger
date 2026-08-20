-- +goose Up
ALTER TABLE users ADD COLUMN must_change_password_at timestamptz;

-- +goose Down
ALTER TABLE users DROP COLUMN IF EXISTS must_change_password_at;
