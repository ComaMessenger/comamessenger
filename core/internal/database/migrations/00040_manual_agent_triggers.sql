-- +goose Up
ALTER TABLE agent_triggers DROP CONSTRAINT agent_triggers_type_check;
ALTER TABLE agent_triggers ADD CONSTRAINT agent_triggers_type_check
    CHECK (type IN ('manual','mention','command','keyword','every_message','schedule','event'));

-- +goose Down
ALTER TABLE agent_triggers DROP CONSTRAINT agent_triggers_type_check;
DELETE FROM agent_triggers WHERE type='manual';
ALTER TABLE agent_triggers ADD CONSTRAINT agent_triggers_type_check
    CHECK (type IN ('mention','command','keyword','every_message','schedule','event'));
