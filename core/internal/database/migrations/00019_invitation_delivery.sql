-- +goose Up
ALTER TABLE invitations ADD COLUMN email_sent_at timestamptz;

-- +goose Down
ALTER TABLE invitations DROP COLUMN email_sent_at;
