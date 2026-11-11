package push

import (
	"encoding/json"
)

// scheduledStillFailed is false for a scheduled-message failure push whose
// record is gone (the author deleted it, retention removed it) or no longer
// this failure (the author sent or rescheduled it again): such a push is
// skipped. Every other event is current.
const scheduledStillFailed = `(e.type<>'scheduled_message.failed' OR EXISTS (
	SELECT 1 FROM scheduled_messages sm
	WHERE sm.org_id=e.org_id AND sm.id=e.subject_id AND sm.author_id=e.audience_actor_id
	  AND sm.status='failed' AND sm.version=(e.data->>'version')::int))`

// scheduledFailedTag groups failure pushes on the device.
const scheduledFailedTag = "scheduled-failed"

// scheduledFailureNotification tells the author that a scheduled message
// was not sent and why. It never carries the text or the chat name, even
// with push_preview on: the author may have left the chat, and the reason is
// all the push needs. The wording is the one the web list shows.
func scheduledFailureNotification(eventData []byte, locale string) notificationContent {
	var data struct {
		FailureReason *string `json:"failure_reason"`
	}
	_ = json.Unmarshal(eventData, &data)
	reason := ""
	if data.FailureReason != nil {
		reason = *data.FailureReason
	}
	title := "Сообщение не отправлено"
	if locale == "en" {
		title = "Message not sent"
	}
	return notificationContent{Tag: scheduledFailedTag, Title: title, Body: ScheduledFailureText(reason, locale), URL: "/scheduled"}
}

// ScheduledFailureText is the reason a scheduled message failed, in words.
// Keep it equal to the failure reasons of the web catalog
// (apps/web/src/modules/scheduled/i18n.ts).
func ScheduledFailureText(reason, locale string) string {
	texts, ok := scheduledFailureTexts[reason]
	if !ok {
		texts = scheduledFailureTexts[""]
	}
	if locale == "en" {
		return texts[1]
	}
	return texts[0]
}

var scheduledFailureTexts = map[string][2]string{
	"author_inactive":        {"Ваша учётная запись отключена", "Your account was deactivated"},
	"security_reset":         {"Изменились пароль или почта либо выполнен выход на других устройствах", "Your password or email changed, or other devices were signed out"},
	"session_revoked":        {"Устройство, с которого запланировано сообщение, отключено", "The device that scheduled it was signed out"},
	"missed_send_time":       {"Не удалось отправить вовремя", "Couldn’t be sent on time"},
	"chat_unavailable":       {"Чат удалён или в архиве", "The chat was archived or deleted"},
	"not_member":             {"Вы больше не участник чата", "You’re no longer a member of the chat"},
	"forbidden":              {"Вам больше нельзя писать в этот чат", "You can no longer post in this chat"},
	"reference_unavailable":  {"Исходное сообщение, тред или упомянутый человек недоступны", "The original message, thread or a mentioned person is unavailable"},
	"attachment_unavailable": {"Вложение удалено", "An attachment was deleted"},
	"invalid_content":        {"Сообщение не прошло проверку", "The message didn’t pass validation"},
	"delivery_error":         {"Ошибка на сервере", "Server error"},
	"":                       {"Причина неизвестна", "Unknown reason"},
}
