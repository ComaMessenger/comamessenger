-- +goose Up
ALTER TABLE actors
    ADD COLUMN title text NOT NULL DEFAULT '',
    ADD COLUMN about text NOT NULL DEFAULT '',
    ADD CONSTRAINT actors_title_length CHECK (length(title) <= 120),
    ADD CONSTRAINT actors_about_length CHECK (length(about) <= 280);

-- +goose Down
ALTER TABLE actors
    DROP CONSTRAINT actors_about_length,
    DROP CONSTRAINT actors_title_length,
    DROP COLUMN about,
    DROP COLUMN title;
