package push

import (
	"context"
	"encoding/json"
	"fmt"
	"time"
)

// «Отсутствую» (phase 6.7 wave 4). While a person's away status with
// «Не присылать уведомления» (mute_push) is active:
//   - no push and no e-mail digest is made for them (awayAllows in eligible,
//     awayDigestSuppressed for items queued before it started);
//   - except their own reminders («Напомнить мне»), which ring as usual,
//   - and direct messages from the workspace owner and administrators,
//     which come without sound (awayQuiet in quietNotification).
//
// Badges and counters are not touched. away.substitute.assigned tells the
// substitute «Вы замещаете …» (category away, the notify_system setting).

const awayAssignedEvent = "away.substitute.assigned"

// awayMutedAt: the recipient `recipient` has an active away status with
// mute_push at the instant `at` (SQL expressions).
func awayMutedAt(org, recipient, at string) string {
	return `EXISTS (SELECT 1 FROM actor_away amu WHERE amu.org_id=` + org + ` AND amu.actor_id=` + recipient +
		` AND amu.mute_push AND amu.starts_at<=` + at + ` AND amu.ends_at>` + at + `)`
}

// awayAdminDirect: a new message in a direct chat whose author is the
// owner or an administrator of the workspace.
const awayAdminDirect = `(r.category='message' AND e.type='message.created' AND r.kind='direct' AND EXISTS (
	SELECT 1 FROM actors boss WHERE boss.org_id=e.org_id AND boss.id=e.actor_id AND boss.type='user' AND boss.org_role IN ('owner','admin')))`

// awayAllows is the condition of eligible: everything reaches a person who
// is not away with mute_push; one who is gets only their reminders and
// direct messages from the owner and administrators.
var awayAllows = `(r.category='reminder' OR ` + awayAdminDirect + ` OR NOT ` + awayMutedAt("e.org_id", "r.recipient_id", "e.occurred_at") + `)`

// awayMuted is the column of eligible that keeps those two exceptions out
// of the e-mail digest.
var awayMuted = awayMutedAt("e.org_id", "r.recipient_id", "e.occurred_at")

// awayQuiet: at delivery the recipient (users row u) is away with
// mute_push, so whatever still reaches them, but a reminder, is silent.
var awayQuiet = `(e.type<>'reminder.fired' AND ` + awayMutedAt("u.org_id", "u.actor_id", "now()") + `)`

// awayDigestSuppressed closes digest items of people who are away with
// mute_push now: items queued before the status started are not mailed.
var awayDigestSuppressed = `UPDATE email_digest_items i SET sent_at=now(),last_error='suppressed_away',lease_token=NULL,lease_until=NULL
	WHERE i.sent_at IS NULL AND i.available_at<=now() AND (i.lease_until IS NULL OR i.lease_until<now()) AND ` + awayMutedAt("i.org_id", "i.actor_id", "now()")

// awayStillAllowed: the exceptions of awayAllows checked at delivery,
// against the event alone: the person's own reminder, or a new message of
// the owner or an administrator in a direct chat.
const awayStillAllowed = `(e.type='reminder.fired' OR (e.type='message.created' AND EXISTS (
	SELECT 1 FROM chats dc WHERE dc.org_id=e.org_id AND dc.id=e.chat_id AND dc.kind='direct') AND EXISTS (
	SELECT 1 FROM actors boss WHERE boss.org_id=e.org_id AND boss.id=e.actor_id AND boss.type='user' AND boss.org_role IN ('owner','admin'))))`

// awayWebSuppressed and awayMobileSuppressed close pending deliveries of
// people who are away with mute_push now, but the exceptions: a push queued
// just before the status started, or one waiting for a retry, is not sent
// during the absence.
var awayWebSuppressed = `UPDATE notification_deliveries d SET sent_at=now(),last_error='suppressed_away',lease_token=NULL,lease_until=NULL
	FROM web_push_subscriptions s, events e
	WHERE s.id=d.subscription_id AND e.org_id=d.org_id AND e.seq=d.event_seq
	  AND d.sent_at IS NULL AND (d.lease_until IS NULL OR d.lease_until<now())
	  AND ` + awayMutedAt("s.org_id", "s.actor_id", "now()") + ` AND NOT ` + awayStillAllowed

var awayMobileSuppressed = `UPDATE mobile_push_deliveries p SET sent_at=now(),last_error='suppressed_away',lease_token=NULL,lease_until=NULL
	FROM mobile_push_devices d, events e
	WHERE d.id=p.device_id AND e.org_id=p.org_id AND e.seq=p.event_seq
	  AND p.sent_at IS NULL AND (p.lease_until IS NULL OR p.lease_until<now())
	  AND ` + awayMutedAt("d.org_id", "d.actor_id", "now()") + ` AND NOT ` + awayStillAllowed

// awayRecipients: away.substitute.assigned goes to the substitute only,
// while the status still names them.
const awayRecipients = `
	UNION ALL
	SELECT e.audience_actor_id,'default',NULL,NULL,'{}'::uuid[],NULL::uuid,'away'
	FROM event e
	WHERE e.type='away.substitute.assigned' AND e.audience_actor_id IS NOT NULL AND EXISTS (
	  SELECT 1 FROM actor_away sa WHERE sa.org_id=e.org_id AND sa.actor_id=e.subject_id AND sa.substitute_id=e.audience_actor_id)`

// awayCategories decide the away category in eligible.
const awayCategories = `
	WHEN 'away' THEN COALESCE((u.preferences->>'notify_system')::boolean,true)`

type awayAssignedData struct {
	ActorID  string    `json:"actor_id"`
	StartsAt time.Time `json:"starts_at"`
	EndsAt   time.Time `json:"ends_at"`
}

// awayNotification is the push of away.substitute.assigned: «Вы замещаете
// Анну» / «с 20 по 30 ноября», in the substitute's time zone. author is the
// display name of the person who is away (the event's actor).
func (w *Worker) awayNotification(ctx context.Context, orgID, actorID string, eventData []byte, author, locale string) (notificationContent, error) {
	var data awayAssignedData
	if err := json.Unmarshal(eventData, &data); err != nil || data.ActorID == "" {
		return notificationContent{}, fmt.Errorf("decode away event: %w", err)
	}
	var timezone string
	if err := w.pool.QueryRow(ctx, `
		SELECT COALESCE(NULLIF(NULLIF(a.timezone,''),'UTC'),o.settings->>'default_timezone','UTC')
		FROM actors a JOIN organizations o ON o.id=a.org_id WHERE a.org_id=$1 AND a.id=$2`, orgID, actorID).Scan(&timezone); err != nil {
		return notificationContent{}, fmt.Errorf("read substitute time zone: %w", err)
	}
	return awayAssignedContent(data, author, locale, timezone), nil
}

func awayAssignedContent(data awayAssignedData, author, locale, timezone string) notificationContent {
	location, err := time.LoadLocation(timezone)
	if err != nil {
		location = time.UTC
	}
	content := notificationContent{
		Tag: "away-substitute:" + data.ActorID,
		URL: "/people/" + data.ActorID,
	}
	if locale == "en" {
		content.Title = "You substitute for " + author
	} else {
		content.Title = "Вы замещаете: " + author
	}
	content.Body = awayPeriod(data.StartsAt.In(location), data.EndsAt.In(location), locale)
	return content
}

var awayMonthsRU = [...]string{"января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря"}

// awayPeriod is «с 20 по 30 ноября», «с 28 ноября по 5 декабря» or, within
// one day, «20 ноября до 14:00». A period that ends at midnight ends with
// the day before.
func awayPeriod(start, end time.Time, locale string) string {
	last := end
	midnight := end.Hour() == 0 && end.Minute() == 0 && end.Second() == 0
	if midnight {
		last = end.AddDate(0, 0, -1)
	}
	sameDay := start.Year() == last.Year() && start.YearDay() == last.YearDay()
	if locale == "en" {
		switch {
		case sameDay && !midnight:
			return fmt.Sprintf("%s until %s", start.Format("Jan 2"), end.Format("15:04"))
		case sameDay:
			return start.Format("Jan 2")
		default:
			return fmt.Sprintf("from %s to %s", start.Format("Jan 2"), last.Format("Jan 2"))
		}
	}
	day := func(t time.Time) string { return fmt.Sprintf("%d %s", t.Day(), awayMonthsRU[t.Month()-1]) }
	switch {
	case sameDay && !midnight:
		return fmt.Sprintf("%s до %s", day(start), end.Format("15:04"))
	case sameDay:
		return day(start)
	case start.Month() == last.Month() && start.Year() == last.Year():
		return fmt.Sprintf("с %d по %s", start.Day(), day(last))
	default:
		return fmt.Sprintf("с %s по %s", day(start), day(last))
	}
}
