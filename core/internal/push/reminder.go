package push

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"strings"

	"github.com/jackc/pgx/v5"
)

// Personal reminders («Напомнить мне»): reminder.fired notifies only the
// owner, as an alarm the owner set. It rings even in a muted chat, in quiet
// hours and during a notification pause (phase 6.4, decision 9); only
// push_enabled=false silences it. It is never sent for a reminder that was
// moved, closed or removed since (its version changed or the row is gone),
// nor for one that fired more than six hours late: an old alarm at night is
// worse than none.

const reminderFiredEvent = "reminder.fired"

// reminderKind tells the apps to show the reminder actions (category
// coma.reminder on iOS) after decrypting the payload.
const reminderKind = "reminder"

// reminderFiredCurrent: the reminder is still this very firing — fired at
// the moment the event says (moving it clears fired_at, firing again sets a
// new one; losing its message to a deletion keeps it, so the alarm still
// rings with the note) — and its time is at most six hours ago, as of now:
// a push held up by a stopped worker or long retries is not sent at night.
const reminderFiredCurrent = `EXISTS (
	SELECT 1 FROM message_reminders mr
	WHERE mr.org_id=e.org_id AND mr.id=e.subject_id AND mr.actor_id=e.audience_actor_id
	  AND mr.state='fired' AND mr.fired_at=(e.data->>'fired_at')::timestamptz
	  AND now()-mr.remind_at <= interval '6 hours')`

// reminderStillFired is false for a reminder push that is no longer
// current; every other event is current.
const reminderStillFired = `(e.type<>'reminder.fired' OR ` + reminderFiredCurrent + `)`

// reminderRecipients is the recipients branch of reminder.fired: only the
// owner. The chat's notification settings do not apply (muted_until NULL).
const reminderRecipients = `UNION ALL
			  SELECT e.audience_actor_id,'default',NULL,NULL,'{}'::uuid[],NULL::uuid,'reminder'
			  FROM event e
			  WHERE e.type='reminder.fired' AND e.audience_actor_id IS NOT NULL AND ` + reminderFiredCurrent

// reminderBypassesQuiet: a reminder ignores the notification pause and quiet hours.
const reminderBypassesQuiet = `r.category='reminder'`

// reminderData is what the push reads of a fired reminder as of delivery.
type reminderData struct {
	id, chatID         string
	messageID          *string
	note               string
	available          bool
	author, chat, body *string
	voiceMs            *int32
}

// reminderNotification replaces the content of a reminder.fired push. Other
// events keep theirs. The message text, author and chat are shown only while
// the owner can still read the message (the rule of «Important») and has
// push_preview on; the note only with push_preview on.
func (w *Worker) reminderNotification(ctx context.Context, orgID, actorID, eventType string, eventData []byte, locale string, preview bool, content notificationContent) (notificationContent, error) {
	if eventType == awayAssignedEvent {
		// Without a chat the default title is the author's name alone.
		return w.awayNotification(ctx, orgID, actorID, eventData, content.Title, locale)
	}
	if eventType != reminderFiredEvent {
		return content, nil
	}
	var event struct {
		ID string `json:"id"`
	}
	if err := json.Unmarshal(eventData, &event); err != nil || event.ID == "" {
		return notificationContent{}, fmt.Errorf("decode reminder event: %w", errors.Join(err, errors.New("no reminder id")))
	}
	var data reminderData
	err := w.pool.QueryRow(ctx, `
		SELECT r.id, r.chat_id, r.message_id, r.note, m.id IS NOT NULL, author.display_name, c.name, m.body,
			(SELECT f.voice_duration_ms FROM message_files mf JOIN files f ON f.org_id=mf.org_id AND f.id=mf.file_id
			 WHERE mf.message_id=m.id AND f.voice_duration_ms IS NOT NULL LIMIT 1)
		FROM message_reminders r
		LEFT JOIN LATERAL (
			SELECT msg.* FROM messages msg
			JOIN chats chat ON chat.org_id=msg.org_id AND chat.id=msg.chat_id AND chat.archived_at IS NULL
			JOIN chat_members cm ON cm.org_id=msg.org_id AND cm.chat_id=msg.chat_id AND cm.actor_id=r.actor_id
			JOIN actors owner ON owner.org_id=cm.org_id AND owner.id=cm.actor_id AND owner.status='active' AND owner.deleted_at IS NULL
			WHERE msg.org_id=r.org_id AND msg.id=r.message_id AND msg.chat_id=r.chat_id AND msg.deleted_at IS NULL
			  AND NOT EXISTS (SELECT 1 FROM agents agent WHERE agent.org_id=msg.org_id AND agent.actor_id=r.actor_id
				AND msg.chat_id=ANY(agent.write_only_chat_ids))
		) m ON true
		LEFT JOIN actors author ON author.org_id=m.org_id AND author.id=m.actor_id
		LEFT JOIN chats c ON c.org_id=m.org_id AND c.id=m.chat_id
		WHERE r.org_id=$1 AND r.actor_id=$2 AND r.id=$3`, orgID, actorID, event.ID).Scan(
		&data.id, &data.chatID, &data.messageID, &data.note, &data.available, &data.author, &data.chat, &data.body, &data.voiceMs)
	if errors.Is(err, pgx.ErrNoRows) {
		// Gone since the current check: show nothing but the neutral title.
		return reminderContent(reminderData{id: event.ID}, locale, false), nil
	}
	if err != nil {
		return notificationContent{}, fmt.Errorf("load reminder for push: %w", err)
	}
	data.body = messageText(data.body, data.voiceMs, locale)
	return reminderContent(data, locale, preview), nil
}

// reminderContent builds the words. Keep them in line with the apps'
// catalogs (reminders in apps/mobile/src/i18n and apps/web reminders/i18n).
func reminderContent(data reminderData, locale string, preview bool) notificationContent {
	content := notificationContent{Tag: "reminder-" + data.id, Kind: reminderKind, Title: ReminderText("title", locale)}
	if data.available && data.messageID != nil {
		content.ChatID = data.chatID
		content.URL = "/chat/" + url.PathEscape(data.chatID) + "?message=" + url.QueryEscape(*data.messageID) + "&reminder=" + url.QueryEscape(data.id)
	} else {
		content.URL = "/important?tab=reminders"
	}
	if !preview {
		content.Body = ReminderText("hidden", locale)
		return content
	}
	var lines []string
	if data.available {
		source := ""
		if data.author != nil {
			source = *data.author
		}
		if data.chat != nil && *data.chat != "" {
			source += " · " + *data.chat
		}
		text := ""
		if data.body != nil {
			text = truncate(*data.body, 180)
		}
		switch {
		case source != "" && text != "":
			lines = append(lines, source+": "+text)
		case source != "":
			lines = append(lines, source)
		case text != "":
			lines = append(lines, text)
		}
	}
	if data.note != "" {
		lines = append(lines, "📝 "+truncate(data.note, 200))
	}
	if len(lines) == 0 {
		switch {
		case data.available:
			content.Body = ReminderText("hidden", locale)
		case data.messageID == nil && data.id != "":
			content.Body = ReminderText("deleted", locale)
		default:
			content.Body = ReminderText("no_access", locale)
		}
		return content
	}
	content.Body = strings.Join(lines, "\n")
	return content
}

// ReminderText is a fixed string of the reminder push. Keep it equal to the
// apps' catalogs.
func ReminderText(key, locale string) string {
	texts, ok := reminderTexts[key]
	if !ok {
		return ""
	}
	if locale == "en" {
		return texts[1]
	}
	return texts[0]
}

var reminderTexts = map[string][2]string{
	"title":     {"Напоминание", "Reminder"},
	"hidden":    {"Напоминание о сообщении", "Reminder about a message"},
	"no_access": {"Нет доступа к сообщению", "No access to the message"},
	"deleted":   {"Сообщение удалено", "Message deleted"},
}
