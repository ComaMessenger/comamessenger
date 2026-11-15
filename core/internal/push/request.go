package push

import (
	"encoding/json"
	"fmt"
	"time"
)

// Requests («Запрос», phase 6.4). A recipient is treated like a mentioned
// person: the request message and reminders about it reach them in a chat
// set to «mentions only», not in one set to «none» or muted. The outcome of
// the automatic reminder reaches the author unless notifications are paused.

// requestMentions replaces m.mentioned_actor_ids in the message branch: the
// recipients of a request count as mentioned.
const requestMentions = `CASE WHEN m.type='request' AND EXISTS (
	SELECT 1 FROM message_request_recipients rr WHERE rr.message_id=m.id AND rr.actor_id=cm.actor_id)
	THEN m.mentioned_actor_ids||cm.actor_id ELSE m.mentioned_actor_ids END`

// requestRecipients are the recipient branches of request events. A
// reminder goes only while the request is open, the chat live and the
// recipient still a member without an answer.
const requestRecipients = `
	UNION ALL
	SELECT cm.actor_id,cm.notify_level,cm.muted_until,c.kind,ARRAY[cm.actor_id],NULL::uuid,'request'
	FROM event e JOIN chats c ON c.org_id=e.org_id AND c.id=e.chat_id AND c.archived_at IS NULL
	JOIN chat_members cm ON cm.org_id=e.org_id AND cm.chat_id=e.chat_id AND cm.actor_id=e.audience_actor_id
	JOIN message_requests r ON r.org_id=e.org_id AND r.message_id=e.subject_id AND r.status='open'
	JOIN message_request_recipients rr ON rr.message_id=r.message_id AND rr.actor_id=cm.actor_id AND rr.answered_at IS NULL
	WHERE e.type='request.reminded'
	UNION ALL
	SELECT cm.actor_id,'all',NULL,c.kind,'{}'::uuid[],NULL::uuid,'request_summary'
	FROM event e JOIN chats c ON c.org_id=e.org_id AND c.id=e.chat_id AND c.archived_at IS NULL
	JOIN chat_members cm ON cm.org_id=e.org_id AND cm.chat_id=e.chat_id AND cm.actor_id=e.audience_actor_id
	WHERE e.type='request.auto_reminded'`

// requestCategories decide the request categories in eligible: a reminder
// like a message that mentions the recipient, the summary always.
const requestCategories = `
	WHEN 'request' THEN r.notify_level IN ('all','mentions') OR (r.notify_level NOT IN ('all','mentions','none')
	  AND COALESCE(u.preferences->>'notify_messages','all') IN ('all','direct_and_mentions'))
	WHEN 'request_summary' THEN true`

// requestPushEventData replaces e.data where a push is built: for a request
// message or a reminder it adds whether the recipient (u) is asked, the due
// date and the time zone to show it in (the person's, or the workspace's
// when theirs is the UTC default).
const requestPushEventData = `CASE WHEN e.type IN ('message.created','request.reminded') THEN e.data||COALESCE((
	SELECT jsonb_build_object('request',true,'message_id',r.message_id,'request_due_at',r.due_at,
	  'request_recipient',EXISTS (SELECT 1 FROM message_request_recipients rr WHERE rr.message_id=r.message_id AND rr.actor_id=u.actor_id),
	  'timezone',COALESCE(NULLIF(NULLIF(ua.timezone,''),'UTC'),o.settings->>'default_timezone','UTC'))
	FROM message_requests r JOIN actors ua ON ua.org_id=r.org_id AND ua.id=u.actor_id JOIN organizations o ON o.id=r.org_id
	WHERE r.org_id=e.org_id AND r.message_id=e.subject_id),'{}'::jsonb) ELSE e.data END`

type requestPushData struct {
	MessageID        string     `json:"message_id"`
	ChatID           string     `json:"chat_id"`
	Request          bool       `json:"request"`
	RequestRecipient bool       `json:"request_recipient"`
	RequestDueAt     *time.Time `json:"request_due_at"`
	Timezone         string     `json:"timezone"`
	Reminded         int        `json:"reminded"`
	AnsweredCount    int        `json:"answered_count"`
	WaitingCount     int        `json:"waiting_count"`
}

// requestNotification builds the push of a request message to one of its
// recipients and of request reminders. ok is false for everything else.
func requestNotification(eventType string, eventData []byte, author, locale string, preview bool, chatID, body, chatName *string) (notificationContent, bool) {
	var data requestPushData
	_ = json.Unmarshal(eventData, &data)
	english := locale == "en"
	chat := ""
	if chatName != nil {
		chat = *chatName
	}
	content := notificationContent{}
	if chatID != nil {
		content.ChatID = *chatID
		content.URL = "/chat/" + *chatID
		if data.MessageID != "" {
			content.URL += "?message=" + data.MessageID
		}
	}
	switch eventType {
	case "message.created":
		if !data.Request || !data.RequestRecipient {
			return notificationContent{}, false
		}
		content.Title = "Запрос · " + author
		content.Body = "Ждут вашего ответа"
		if english {
			content.Title, content.Body = "Request · "+author, "Your answer is awaited"
		}
		if preview && body != nil {
			content.Body = truncate(joinNonEmpty(": ", chat, *body), 180)
		}
		return content, true
	case "request.reminded":
		content.Title = "Напоминание: ждут вашего ответа"
		if english {
			content.Title = "Reminder: your answer is awaited"
		}
		content.Body = requestReminderBody(data, author, chat, locale)
		return content, true
	case "request.auto_reminded":
		total := data.AnsweredCount + data.WaitingCount
		content.Tag = "request-summary"
		if data.MessageID != "" {
			content.Tag += "-" + data.MessageID
		}
		if english {
			content.Title = fmt.Sprintf("Request: %d of %d answered", data.AnsweredCount, total)
			content.Body = fmt.Sprintf("Reminded %d", data.Reminded)
			if data.WaitingCount == 0 {
				content.Body = "Everyone answered"
			}
		} else {
			content.Title = fmt.Sprintf("Запрос: ответили %d из %d", data.AnsweredCount, total)
			content.Body = fmt.Sprintf("Напомнили %d", data.Reminded)
			if data.WaitingCount == 0 {
				content.Body = "Ответили все"
			}
		}
		return content, true
	}
	return notificationContent{}, false
}

// requestCategoryBody is the line of an e-mail digest for request events.
func requestCategoryBody(eventType string, eventData []byte, author, locale string) (string, bool) {
	content, ok := requestNotification(eventType, eventData, author, locale, false, nil, nil, nil)
	if !ok || eventType == "message.created" {
		return "", false
	}
	return content.Title + " · " + content.Body, true
}

// requestReminderBody is «{author} · {chat} · до {due}», the due date in the
// recipient's time zone.
func requestReminderBody(data requestPushData, author, chat, locale string) string {
	due := ""
	if data.RequestDueAt != nil {
		location, err := time.LoadLocation(data.Timezone)
		if err != nil || data.Timezone == "" {
			location = time.UTC
		}
		local := data.RequestDueAt.In(location)
		if locale == "en" {
			due = "due " + local.Format("Mon 2 Jan, 15:04")
		} else {
			due = "до " + russianWeekdays[local.Weekday()] + " " + local.Format("02.01, 15:04")
		}
	}
	return joinNonEmpty(" · ", author, chat, due)
}

var russianWeekdays = [...]string{"вс", "пн", "вт", "ср", "чт", "пт", "сб"}

func joinNonEmpty(separator string, parts ...string) string {
	result := ""
	for _, part := range parts {
		if part == "" {
			continue
		}
		if result != "" {
			result += separator
		}
		result += part
	}
	return result
}
