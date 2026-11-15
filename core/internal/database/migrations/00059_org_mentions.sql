-- +goose Up
-- Phase 6.5 wave 2, package S2: department mentions («@отдел») and the
-- department and position audiences of requests.
--
-- A mentioned department is expanded into people when the message is sent
-- or edited: its active people (with subdepartments, primary and
-- additional members) who are members of the chat, the author left out.
-- They are added to mentioned_actor_ids, so push, the mention counter and
-- the «you were mentioned» highlight work unchanged. The department ids are
-- kept to show the token and «Уведомлены N человек» to the author.
ALTER TABLE messages ADD COLUMN mentioned_department_ids uuid[] NOT NULL DEFAULT '{}';
-- [{department_id, notified_count}] at the moment of sending or of the last
-- edit.
ALTER TABLE messages ADD COLUMN mentioned_departments jsonb NOT NULL DEFAULT '[]';
ALTER TABLE message_revisions ADD COLUMN mentioned_department_ids uuid[] NOT NULL DEFAULT '{}';
-- A scheduled message keeps the departments, never the people: they are
-- expanded only when it is sent.
ALTER TABLE scheduled_messages ADD COLUMN mentioned_department_ids uuid[] NOT NULL DEFAULT '{}';
ALTER TABLE scheduled_messages ADD CONSTRAINT scheduled_messages_mentioned_departments_check CHECK (
    cardinality(mentioned_department_ids) <= 10);

-- The addressed department or position. After it is deleted the link is
-- NULL and audience_label keeps the name, so the request and its answers
-- live on.
ALTER TABLE message_requests ADD COLUMN audience_department_id uuid;
ALTER TABLE message_requests ADD COLUMN audience_position_id uuid;
ALTER TABLE message_requests ADD CONSTRAINT message_requests_audience_department_fk
    FOREIGN KEY (org_id, audience_department_id) REFERENCES departments(org_id, id) ON DELETE SET NULL (audience_department_id);
ALTER TABLE message_requests ADD CONSTRAINT message_requests_audience_position_fk
    FOREIGN KEY (org_id, audience_position_id) REFERENCES positions(org_id, id) ON DELETE SET NULL (audience_position_id);
ALTER TABLE message_requests ADD CONSTRAINT message_requests_audience_ref_check CHECK (
    (audience_department_id IS NULL OR audience_kind = 'department')
    AND (audience_position_id IS NULL OR audience_kind = 'position'));
CREATE INDEX message_requests_audience_department_idx ON message_requests(org_id, audience_department_id) WHERE audience_department_id IS NOT NULL;
CREATE INDEX message_requests_audience_position_idx ON message_requests(org_id, audience_position_id) WHERE audience_position_id IS NOT NULL;

-- +goose Down
DROP INDEX IF EXISTS message_requests_audience_position_idx;
DROP INDEX IF EXISTS message_requests_audience_department_idx;
ALTER TABLE message_requests DROP CONSTRAINT IF EXISTS message_requests_audience_ref_check;
ALTER TABLE message_requests DROP CONSTRAINT IF EXISTS message_requests_audience_position_fk;
ALTER TABLE message_requests DROP CONSTRAINT IF EXISTS message_requests_audience_department_fk;
ALTER TABLE message_requests DROP COLUMN IF EXISTS audience_position_id;
ALTER TABLE message_requests DROP COLUMN IF EXISTS audience_department_id;
ALTER TABLE scheduled_messages DROP CONSTRAINT IF EXISTS scheduled_messages_mentioned_departments_check;
ALTER TABLE scheduled_messages DROP COLUMN IF EXISTS mentioned_department_ids;
ALTER TABLE message_revisions DROP COLUMN IF EXISTS mentioned_department_ids;
ALTER TABLE messages DROP COLUMN IF EXISTS mentioned_departments;
ALTER TABLE messages DROP COLUMN IF EXISTS mentioned_department_ids;
