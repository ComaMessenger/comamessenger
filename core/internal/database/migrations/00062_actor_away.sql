-- +goose Up
-- «Отсутствую» (phase 6.7 wave 4, package A). A person has at most one
-- away status, current or planned. It is active while
-- starts_at <= now() < ends_at; every read checks that against the clock,
-- the minute sweep (identity.RunStatusExpiry) only sends the start and end
-- events and removes ended rows.
--
-- Privacy: autoreply_text, mute_push and the saved substitute are read only
-- by the owner (GET /api/v1/me/away). Everyone else gets actor_away_public,
-- which never carries them.
CREATE TABLE actor_away (
    id uuid PRIMARY KEY,                    -- the period; a new one when the dates change
    org_id uuid NOT NULL,
    actor_id uuid NOT NULL,
    kind text NOT NULL CHECK (kind IN ('vacation', 'appointment', 'trip', 'dnd', 'other')),
    label text NOT NULL DEFAULT '' CHECK (char_length(label) <= 40),
    starts_at timestamptz NOT NULL,
    ends_at timestamptz NOT NULL,
    autoreply_enabled boolean NOT NULL DEFAULT false,
    autoreply_text text NOT NULL DEFAULT '' CHECK (char_length(autoreply_text) <= 500),
    substitute_id uuid,
    mute_push boolean NOT NULL DEFAULT false,
    started_event_at timestamptz,           -- the «started» event was sent
    version integer NOT NULL DEFAULT 1 CHECK (version > 0),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (org_id, actor_id),              -- one record per person
    UNIQUE (org_id, id),
    CHECK (ends_at > starts_at AND ends_at <= starts_at + interval '180 days'),
    CHECK (kind <> 'other' OR label <> ''),
    CHECK (kind = 'other' OR label = ''),
    CHECK (NOT autoreply_enabled OR autoreply_text <> ''),
    CHECK (substitute_id IS NULL OR substitute_id <> actor_id),
    FOREIGN KEY (org_id, actor_id) REFERENCES actors(org_id, id) ON DELETE CASCADE,
    FOREIGN KEY (org_id, substitute_id) REFERENCES actors(org_id, id) ON DELETE SET NULL (substitute_id)
);
CREATE INDEX actor_away_start_idx ON actor_away(starts_at) WHERE started_event_at IS NULL;
CREATE INDEX actor_away_end_idx ON actor_away(ends_at);
CREATE INDEX actor_away_substitute_idx ON actor_away(org_id, substitute_id) WHERE substitute_id IS NOT NULL;

-- Who already got the auto-reply of this period. The row stays when the
-- auto-reply message is deleted, so a second one is never sent.
CREATE TABLE actor_away_autoreplies (
    org_id uuid NOT NULL,
    away_id uuid NOT NULL,
    peer_id uuid NOT NULL,
    message_id uuid,
    sent_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (away_id, peer_id),
    FOREIGN KEY (org_id, away_id) REFERENCES actor_away(org_id, id) ON DELETE CASCADE,
    FOREIGN KEY (org_id, peer_id) REFERENCES actors(org_id, id) ON DELETE CASCADE,
    FOREIGN KEY (org_id, message_id) REFERENCES messages(org_id, id) ON DELETE SET NULL (message_id)
);
CREATE INDEX actor_away_autoreplies_peer_idx ON actor_away_autoreplies(org_id, peer_id);
CREATE INDEX actor_away_autoreplies_message_idx ON actor_away_autoreplies(org_id, message_id) WHERE message_id IS NOT NULL;

ALTER TABLE messages ADD COLUMN auto_reply boolean NOT NULL DEFAULT false;
-- The daily limit of auto-replies of one person.
CREATE INDEX messages_auto_reply_idx ON messages(org_id, actor_id, created_at) WHERE auto_reply;

-- actor_away_public is AwayPublic of a person at p_at, as everyone in the
-- workspace sees it, or NULL: no record, it has ended, or the person is not
-- active. The substitute is shown only while they are an active person who
-- is not away themselves. No auto-reply text, no mute_push.
-- +goose StatementBegin
CREATE FUNCTION actor_away_public(p_org uuid, p_actor uuid, p_at timestamptz) RETURNS jsonb
LANGUAGE sql STABLE AS $$
    SELECT jsonb_build_object(
        'kind', aw.kind,
        'label', aw.label,
        'starts_at', aw.starts_at,
        'ends_at', aw.ends_at,
        'active', aw.starts_at <= p_at,
        'substitute_id', (
            SELECT sub.id FROM actors sub
            WHERE sub.org_id = aw.org_id AND sub.id = aw.substitute_id
              AND sub.type = 'user' AND sub.status = 'active' AND sub.deleted_at IS NULL
              AND NOT EXISTS (
                SELECT 1 FROM actor_away sa
                WHERE sa.org_id = sub.org_id AND sa.actor_id = sub.id
                  AND sa.starts_at <= p_at AND sa.ends_at > p_at)),
        'notifications_off', aw.mute_push)
    FROM actor_away aw
    JOIN actors a ON a.org_id = aw.org_id AND a.id = aw.actor_id
        AND a.status = 'active' AND a.deleted_at IS NULL
    WHERE aw.org_id = p_org AND aw.actor_id = p_actor AND aw.ends_at > p_at
$$;
-- +goose StatementEnd

-- actor_away_local is p_at on the wall clock of p_tz; a time zone PostgreSQL
-- does not know (actors.timezone is free text) falls back to UTC instead of
-- failing the whole read.
-- +goose StatementBegin
CREATE FUNCTION actor_away_local(p_at timestamptz, p_tz text) RETURNS timestamp
LANGUAGE plpgsql STABLE AS $$
BEGIN
    RETURN p_at AT TIME ZONE COALESCE(NULLIF(p_tz, ''), 'UTC');
EXCEPTION WHEN invalid_parameter_value OR data_exception THEN
    RETURN p_at AT TIME ZONE 'UTC';
END
$$;
-- +goose StatementEnd

-- actor_away_status_text is the custom status text older clients show for
-- an active away status (decision 12): «В отпуске до 30 ноября», «На приёме
-- до 14:00», «Нет на месте до 2 декабря, 18:00». A status that ends at
-- midnight ends with the day before. In Russian: older clients are Russian.
-- +goose StatementBegin
CREATE FUNCTION actor_away_status_text(p_kind text, p_label text, p_ends timestamptz, p_tz text, p_at timestamptz) RETURNS text
LANGUAGE plpgsql STABLE AS $$
DECLARE
    months text[] := ARRAY['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа',
                           'сентября', 'октября', 'ноября', 'декабря'];
    local_end timestamp := actor_away_local(p_ends, p_tz);
    local_now timestamp := actor_away_local(p_at, p_tz);
    day date;
    name text;
    until text;
BEGIN
    name := CASE p_kind
        WHEN 'vacation' THEN 'В отпуске'
        WHEN 'appointment' THEN 'На приёме'
        WHEN 'trip' THEN 'На выезде'
        WHEN 'dnd' THEN 'Не беспокоить'
        ELSE p_label
    END;
    IF local_end::time = time '00:00' THEN
        day := local_end::date - 1;
        until := extract(day FROM day)::int || ' ' || months[extract(month FROM day)::int];
    ELSIF local_end::date = local_now::date THEN
        until := to_char(local_end, 'HH24:MI');
    ELSE
        until := extract(day FROM local_end)::int || ' ' || months[extract(month FROM local_end)::int]
            || ', ' || to_char(local_end, 'HH24:MI');
    END IF;
    RETURN left(name || ' до ' || until, 100);
END
$$;
-- +goose StatementEnd

-- actor_shown_status is what others see as the custom status of a person
-- (status_emoji, status_text, status_expires_at): the away status while it
-- is active, otherwise p_own — the custom status as the reader already
-- computed it. NULL columns when the away status is not active.
-- +goose StatementBegin
CREATE FUNCTION actor_away_shown(p_org uuid, p_actor uuid, p_at timestamptz,
    OUT emoji text, OUT status_text text, OUT expires_at timestamptz)
LANGUAGE sql STABLE AS $$
    SELECT CASE aw.kind
               WHEN 'vacation' THEN '🌴' WHEN 'appointment' THEN '🩺' WHEN 'trip' THEN '🚗'
               WHEN 'dnd' THEN '🔕' ELSE '⏸' END,
           actor_away_status_text(aw.kind, aw.label, aw.ends_at,
               COALESCE(NULLIF(NULLIF(a.timezone, ''), 'UTC'), o.settings->>'default_timezone', 'UTC'), p_at),
           aw.ends_at
    FROM actor_away aw
    JOIN actors a ON a.org_id = aw.org_id AND a.id = aw.actor_id
        AND a.status = 'active' AND a.deleted_at IS NULL
    JOIN organizations o ON o.id = aw.org_id
    WHERE aw.org_id = p_org AND aw.actor_id = p_actor AND aw.starts_at <= p_at AND aw.ends_at > p_at
$$;
-- +goose StatementEnd

-- +goose StatementBegin
CREATE FUNCTION actor_shown_status_emoji(p_org uuid, p_actor uuid, p_at timestamptz, p_own text) RETURNS text
LANGUAGE sql STABLE AS $$
    SELECT COALESCE((SELECT s.emoji FROM actor_away_shown(p_org, p_actor, p_at) s), p_own)
$$;
-- +goose StatementEnd

-- +goose StatementBegin
CREATE FUNCTION actor_shown_status_text(p_org uuid, p_actor uuid, p_at timestamptz, p_own text) RETURNS text
LANGUAGE sql STABLE AS $$
    SELECT COALESCE((SELECT s.status_text FROM actor_away_shown(p_org, p_actor, p_at) s), p_own)
$$;
-- +goose StatementEnd

-- +goose StatementBegin
CREATE FUNCTION actor_shown_status_expires_at(p_org uuid, p_actor uuid, p_at timestamptz, p_own timestamptz) RETURNS timestamptz
LANGUAGE sql STABLE AS $$
    SELECT CASE WHEN s.expires_at IS NOT NULL THEN s.expires_at ELSE p_own END
    FROM (SELECT (SELECT x.expires_at FROM actor_away_shown(p_org, p_actor, p_at) x) AS expires_at) s
$$;
-- +goose StatementEnd

-- +goose Down
DROP FUNCTION IF EXISTS actor_shown_status_expires_at(uuid, uuid, timestamptz, timestamptz);
DROP FUNCTION IF EXISTS actor_shown_status_text(uuid, uuid, timestamptz, text);
DROP FUNCTION IF EXISTS actor_shown_status_emoji(uuid, uuid, timestamptz, text);
DROP FUNCTION IF EXISTS actor_away_shown(uuid, uuid, timestamptz);
DROP FUNCTION IF EXISTS actor_away_status_text(text, text, timestamptz, text, timestamptz);
DROP FUNCTION IF EXISTS actor_away_local(timestamptz, text);
DROP FUNCTION IF EXISTS actor_away_public(uuid, uuid, timestamptz);
DROP INDEX IF EXISTS messages_auto_reply_idx;
ALTER TABLE messages DROP COLUMN IF EXISTS auto_reply;
DROP TABLE IF EXISTS actor_away_autoreplies;
DROP TABLE IF EXISTS actor_away;
