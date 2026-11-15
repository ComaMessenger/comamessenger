package push

import (
	"encoding/json"
	"fmt"
	"strings"
	"time"
)

// Polls («Опрос», phase 6.7). A new poll reaches the chat through the
// ordinary message branch («Опрос · {автор}»). poll.notified tells one
// person about a poll; its event data carries ids and the kind only. The
// words of the push — the question, the due date, the result — are read
// when the push is built (pollPushEventData), and only while the recipient
// may still read the poll; the question and the result appear only with
// push_preview on. Nothing here ever reads who chose what.
//
// reminded («Напомнить не ответившим») reaches a person who has not voted
// like a message that mentions them: in a chat set to «mentions only», not
// in one set to «none» or muted, and only while the poll is open and they
// still have not voted. closed_expired reaches the author always, except
// during a notification pause. Closing by hand sends nothing.

const pollKind = "poll"

// pollRecipients is the recipients branch of poll.notified: the person
// while an active member of the live chat, the poll message not deleted; a
// reminder only while the poll is open and the person has not voted.
const pollRecipients = `
	UNION ALL
	SELECT cm.actor_id,
	  CASE WHEN (e.data->>'kind')='closed_expired' THEN 'all' ELSE cm.notify_level END,
	  CASE WHEN (e.data->>'kind')='closed_expired' THEN NULL ELSE cm.muted_until END,
	  c.kind,ARRAY[cm.actor_id],NULL::uuid,
	  CASE WHEN (e.data->>'kind')='closed_expired' THEN 'poll_summary' ELSE 'poll' END
	FROM event e JOIN chats c ON c.org_id=e.org_id AND c.id=e.chat_id AND c.archived_at IS NULL
	JOIN chat_members cm ON cm.org_id=e.org_id AND cm.chat_id=e.chat_id AND cm.actor_id=e.audience_actor_id
	JOIN actors pa ON pa.org_id=cm.org_id AND pa.id=cm.actor_id AND pa.status='active' AND pa.deleted_at IS NULL
	JOIN message_polls p ON p.org_id=e.org_id AND p.message_id=e.subject_id
	JOIN messages pm ON pm.org_id=p.org_id AND pm.id=p.message_id AND pm.deleted_at IS NULL
	WHERE e.type='poll.notified' AND (
	  ((e.data->>'kind')='reminded' AND p.status='open'
	    AND NOT EXISTS (SELECT 1 FROM message_poll_voters pv WHERE pv.message_id=p.message_id AND pv.actor_id=cm.actor_id))
	  OR ((e.data->>'kind')='closed_expired' AND p.author_id=cm.actor_id))`

// pollCategories decide the poll categories in eligible: a reminder like a
// message that mentions the recipient, the closing for the author always.
const pollCategories = `
	WHEN 'poll' THEN r.notify_level IN ('all','mentions') OR (r.notify_level NOT IN ('all','mentions','none')
	  AND COALESCE(u.preferences->>'notify_messages','all') IN ('all','direct_and_mentions'))
	WHEN 'poll_summary' THEN true`

// pollPushEventData replaces e.data where a push is built: for a poll
// message or poll.notified it adds the words of the push while the
// recipient (u) may still read the poll; other events fall through to the
// requests' data.
const pollPushEventData = `CASE WHEN e.type IN ('message.created','poll.notified') AND EXISTS (
	SELECT 1 FROM message_polls px WHERE px.org_id=e.org_id AND px.message_id=e.subject_id) THEN e.data||jsonb_build_object('poll',true,'message_id',e.subject_id)||COALESCE((
	SELECT jsonb_build_object('poll_readable',true,'poll_question',p.question,'poll_options',to_jsonb(p.options),'poll_due_at',p.due_at,
	  'poll_final_counts',CASE WHEN p.status='closed' THEN to_jsonb(p.option_counts) END,'poll_voter_count',p.voter_count,
	  'timezone',COALESCE(NULLIF(NULLIF(ua.timezone,''),'UTC'),o.settings->>'default_timezone','UTC'))
	FROM message_polls p
	JOIN messages pm ON pm.org_id=p.org_id AND pm.id=p.message_id AND pm.deleted_at IS NULL
	JOIN chats pc ON pc.org_id=p.org_id AND pc.id=p.chat_id AND pc.archived_at IS NULL
	JOIN chat_members pcm ON pcm.org_id=p.org_id AND pcm.chat_id=p.chat_id AND pcm.actor_id=u.actor_id
	JOIN actors ua ON ua.org_id=p.org_id AND ua.id=u.actor_id AND ua.status='active' AND ua.deleted_at IS NULL
	JOIN organizations o ON o.id=p.org_id
	WHERE p.org_id=e.org_id AND p.message_id=e.subject_id),'{}'::jsonb) ELSE ` + requestPushEventData + ` END`

type pollPushData struct {
	MessageID   string     `json:"message_id"`
	Kind        string     `json:"kind"`
	Poll        bool       `json:"poll"`
	Readable    bool       `json:"poll_readable"`
	Question    string     `json:"poll_question"`
	Options     []string   `json:"poll_options"`
	DueAt       *time.Time `json:"poll_due_at"`
	FinalCounts []int      `json:"poll_final_counts"`
	VoterCount  int        `json:"poll_voter_count"`
	Timezone    string     `json:"timezone"`
}

// pollNotification builds the push of a poll message and of poll.notified;
// ok is false for other events. actor is the name of who acted (empty for
// the server's own closing). Keep the words in line with the apps'
// catalogs.
func pollNotification(eventType string, eventData []byte, actor, locale string, preview bool, chatID, chatName *string) (notificationContent, bool) {
	if eventType != "message.created" && eventType != "poll.notified" {
		return notificationContent{}, false
	}
	var data pollPushData
	_ = json.Unmarshal(eventData, &data)
	if !data.Poll {
		return notificationContent{}, false
	}
	chat := ""
	if chatName != nil {
		chat = *chatName
	}
	content := notificationContent{Kind: pollKind}
	if chatID != nil {
		content.ChatID = *chatID
		content.URL = "/chat/" + *chatID
		if data.MessageID != "" {
			content.URL += "?message=" + data.MessageID
			content.Tag = "poll-" + data.MessageID
		}
	}
	shown := preview && data.Readable && data.Question != ""
	switch {
	case eventType == "message.created":
		content.Title = joinNonEmpty(" · ", PollText("title", locale), actor)
		content.Body = PollText("new", locale)
		if shown {
			content.Body = joinNonEmpty(": ", chat, truncate(data.Question, 160))
		}
	case data.Kind == "closed_expired":
		content.Title = PollText("closed_title", locale)
		content.Body = PollText("closed_hidden", locale)
		if winner, votes, ok := pollWinner(data); shown && ok {
			if locale == "en" {
				content.Body = fmt.Sprintf("Result: “%s” — %d of %d", truncate(winner, 100), votes, data.VoterCount)
			} else {
				content.Body = fmt.Sprintf("Итог: «%s» — %d из %d", truncate(winner, 100), votes, data.VoterCount)
			}
		}
	default:
		content.Title = PollText("reminded_title", locale)
		due := ""
		if data.DueAt != nil && data.Readable {
			due = formatTaskDue(*data.DueAt, data.Timezone, locale)
		}
		content.Body = joinNonEmpty(" · ", actor, chat, due)
		if content.Body == "" {
			content.Body = PollText("reminded_hidden", locale)
		}
	}
	return content, true
}

// pollWinner is the option with the most votes of a closed poll; the first
// one on a tie. ok is false without votes.
func pollWinner(data pollPushData) (string, int, bool) {
	best, votes := -1, 0
	for index, count := range data.FinalCounts {
		if count > votes && index < len(data.Options) {
			best, votes = index, count
		}
	}
	if best < 0 || strings.TrimSpace(data.Options[best]) == "" {
		return "", 0, false
	}
	return data.Options[best], votes, true
}

// PollText is a fixed string of the poll push. Keep it equal to the apps'
// catalogs.
func PollText(key, locale string) string {
	texts, ok := pollTexts[key]
	if !ok {
		return ""
	}
	if locale == "en" {
		return texts[1]
	}
	return texts[0]
}

var pollTexts = map[string][2]string{
	"title":           {"Опрос", "Poll"},
	"new":             {"Новый опрос", "New poll"},
	"reminded_title":  {"Напоминание: опрос", "Reminder: poll"},
	"reminded_hidden": {"Ответьте на опрос", "Please answer the poll"},
	"closed_title":    {"Опрос закрыт", "Poll closed"},
	"closed_hidden":   {"Опрос закрыт по сроку", "The poll closed at its due date"},
}
