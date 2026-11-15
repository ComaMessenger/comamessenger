package push

import (
	"encoding/json"
	"strings"
	"time"
)

// Tasks («Задача», phase 6.6). task.notified tells one person about a task;
// its event data carries ids and the due date only. The words of the push —
// the title, the item, the names — are read when the push is built
// (pushEventData), and only while the recipient may still read the task;
// the title and the item appear only with push_preview on.
//
// assigned, item_assigned, offered, nudged, due_soon, due_changed and
// reopened reach the person like a message that mentions them: in a chat
// set to «mentions only», not in one set to «none» or muted. taken,
// completed and overdue for the author reach them always, except during a
// notification pause. unassigned is never pushed (no job is queued).
// message.created of a task skips the people it concerns: they already got
// task.notified.

const taskKind = "task"

// taskAddressee: the message `m` is a task that concerns the member `cm`
// (responsible, assignee of an item or candidate of the queue).
const taskAddressee = `(m.type='task' AND EXISTS (
	SELECT 1 FROM message_tasks ta WHERE ta.org_id=m.org_id AND ta.message_id=m.id AND (
	  ta.assignee_id=cm.actor_id
	  OR EXISTS (SELECT 1 FROM message_task_items ti WHERE ti.message_id=ta.message_id AND ti.assignee_id=cm.actor_id)
	  OR EXISTS (SELECT 1 FROM message_task_candidates tc WHERE tc.message_id=ta.message_id AND tc.actor_id=cm.actor_id))))`

// taskSummary: the notice reaches its recipient always (pause aside):
// someone took or completed the author's task, or the author's task is
// overdue.
const taskSummary = `((e.data->>'kind') IN ('taken','completed') OR ((e.data->>'kind')='overdue'
	AND t.author_id=e.audience_actor_id AND t.assignee_id IS DISTINCT FROM e.audience_actor_id))`

// taskRecipients is the recipients branch of task.notified: the person
// while an active member of the live chat and the task message not deleted;
// a notice that asks for work only while the task is still open.
const taskRecipients = `
	UNION ALL
	SELECT cm.actor_id,
	  CASE WHEN ` + taskSummary + ` THEN 'all' ELSE cm.notify_level END,
	  CASE WHEN ` + taskSummary + ` THEN NULL ELSE cm.muted_until END,
	  c.kind,ARRAY[cm.actor_id],NULL::uuid,
	  CASE WHEN ` + taskSummary + ` THEN 'task_summary' ELSE 'task' END
	FROM event e JOIN chats c ON c.org_id=e.org_id AND c.id=e.chat_id AND c.archived_at IS NULL
	JOIN chat_members cm ON cm.org_id=e.org_id AND cm.chat_id=e.chat_id AND cm.actor_id=e.audience_actor_id
	JOIN message_tasks t ON t.org_id=e.org_id AND t.message_id=e.subject_id
	JOIN messages tm ON tm.org_id=t.org_id AND tm.id=t.message_id AND tm.deleted_at IS NULL
	WHERE e.type='task.notified' AND (e.data->>'kind')<>'unassigned'
	  AND ((e.data->>'kind') IN ('taken','completed') OR t.status IN ('open','in_progress'))`

// taskCategories decide the task categories in eligible.
const taskCategories = `
	WHEN 'task' THEN r.notify_level IN ('all','mentions') OR (r.notify_level NOT IN ('all','mentions','none')
	  AND COALESCE(u.preferences->>'notify_messages','all') IN ('all','direct_and_mentions'))
	WHEN 'task_summary' THEN true`

// pushEventData replaces e.data where a push is built: requests add their
// due date (requestPushEventData); task.notified adds the words of the push
// while the recipient (u) may still read the task.
const pushEventData = `CASE WHEN e.type='task.notified' THEN e.data||COALESCE((
	SELECT jsonb_build_object('task',true,'task_title',t.title,'task_assignee_kind',t.assignee_kind,'task_label',t.audience_label,
	  'task_responsible',resp.display_name,'task_due_at',t.due_at,'task_recipient_author',t.author_id=u.actor_id,
	  'task_item',(SELECT ti.text FROM message_task_items ti WHERE ti.message_id=t.message_id AND ti.assignee_id=u.actor_id
	    ORDER BY ti.assigned_at DESC NULLS LAST, ti.position LIMIT 1),
	  'timezone',COALESCE(NULLIF(NULLIF(ua.timezone,''),'UTC'),o.settings->>'default_timezone','UTC'))
	FROM message_tasks t
	JOIN messages tm ON tm.org_id=t.org_id AND tm.id=t.message_id AND tm.deleted_at IS NULL
	JOIN chats tc ON tc.org_id=t.org_id AND tc.id=t.chat_id AND tc.archived_at IS NULL
	JOIN chat_members tcm ON tcm.org_id=t.org_id AND tcm.chat_id=t.chat_id AND tcm.actor_id=u.actor_id
	JOIN actors ua ON ua.org_id=t.org_id AND ua.id=u.actor_id AND ua.status='active' AND ua.deleted_at IS NULL
	JOIN organizations o ON o.id=t.org_id
	LEFT JOIN actors resp ON resp.org_id=t.org_id AND resp.id=t.assignee_id
	WHERE t.org_id=e.org_id AND t.message_id=e.subject_id),'{}'::jsonb) ELSE ` + requestPushEventData + ` END`

type taskPushData struct {
	MessageID       string     `json:"message_id"`
	Kind            string     `json:"kind"`
	Task            bool       `json:"task"`
	Title           string     `json:"task_title"`
	AssigneeKind    string     `json:"task_assignee_kind"`
	Label           string     `json:"task_label"`
	Responsible     *string    `json:"task_responsible"`
	DueAt           *time.Time `json:"task_due_at"`
	RecipientAuthor bool       `json:"task_recipient_author"`
	Item            *string    `json:"task_item"`
	Timezone        string     `json:"timezone"`
}

// taskNotification builds the push of task.notified; ok is false for other
// events. actor is the name of who acted (the task's author for the
// server's own notices). Keep the words in line with the apps' catalogs.
func taskNotification(eventType string, eventData []byte, actor, locale string, preview bool, chatID, chatName *string) (notificationContent, bool) {
	if eventType != "task.notified" {
		return notificationContent{}, false
	}
	var data taskPushData
	_ = json.Unmarshal(eventData, &data)
	en := locale == "en"
	chat := ""
	if chatName != nil {
		chat = *chatName
	}
	content := notificationContent{Kind: taskKind}
	if chatID != nil {
		content.ChatID = *chatID
		content.URL = "/chat/" + *chatID
		if data.MessageID != "" {
			content.URL += "?message=" + data.MessageID
			content.Tag = "task-" + data.MessageID
		}
	}
	// Without preview, or once the task can no longer be read, the title is
	// replaced by «Задача в чате {чат}».
	shown := preview && data.Task && data.Title != ""
	title := truncate(data.Title, 120)
	if !shown {
		title = TaskText("in_chat", locale)
		if chat != "" {
			title += " " + chat
		}
		title = strings.TrimSpace(title)
	}
	due := ""
	if data.DueAt != nil {
		due = formatTaskDue(*data.DueAt, data.Timezone, locale)
	}
	withDue := func(text string) string {
		if due == "" {
			return text
		}
		return text + " · " + due
	}
	responsible := data.Label
	if data.Responsible != nil {
		responsible = *data.Responsible
	}
	switch data.Kind {
	case "assigned":
		content.Title = TaskText("assigned_title", locale) + " · " + actor
		content.Body = TaskText("assigned_hidden", locale)
		if shown {
			content.Body = withDue(joinNonEmpty(": ", chat, title))
		}
	case "item_assigned":
		content.Title = TaskText("item_title", locale) + " · " + actor
		content.Body = TaskText("item_hidden", locale)
		if shown && data.Item != nil {
			content.Body = truncate(*data.Item, 120) + " — " + TaskText("item_in", locale) + " «" + title + "»"
			if en {
				content.Body = truncate(*data.Item, 120) + " — in the task “" + title + "”"
			}
		}
	case "offered":
		label := data.Label
		if data.AssigneeKind == "position" {
			content.Title = TaskText("offered_position_title", locale) + " «" + label + "»"
			content.Body = TaskText("offered_position_hidden", locale)
		} else {
			content.Title = TaskText("offered_title", locale) + " «" + label + "»"
			content.Body = TaskText("offered_hidden", locale)
		}
		if en {
			content.Title = strings.ReplaceAll(strings.ReplaceAll(content.Title, "«", "“"), "»", "”")
		}
		if shown {
			content.Body = title + " — " + TaskText("offered_body", locale)
		}
	case "taken":
		content.Title = actor + " " + TaskText("taken_title", locale)
		content.Body = title
	case "nudged":
		content.Title = TaskText("nudged_title", locale) + " · " + actor
		content.Body = withDue(title)
	case "due_soon":
		content.Title = TaskText("due_soon_title", locale)
		content.Body = title
		if shown {
			content.Body = joinNonEmpty(" · ", title, chat)
		}
	case "overdue":
		content.Title = TaskText("overdue_title", locale)
		switch {
		case data.RecipientAuthor && data.Responsible != nil && *data.Responsible != "":
			content.Body = title + " · " + TaskText("answers", locale) + " " + responsible
		case shown:
			content.Body = joinNonEmpty(" · ", title, chat)
		default:
			content.Body = title
		}
	case "due_changed":
		content.Title = TaskText("due_changed_title", locale)
		if due == "" {
			content.Body = title + " · " + TaskText("no_due", locale)
		} else {
			content.Body = withDue(title)
		}
	case "completed":
		content.Title = TaskText("completed_title", locale) + " · " + actor
		content.Body = title
	case "reopened":
		content.Title = TaskText("reopened_title", locale)
		content.Body = title + " · " + actor
	default:
		content.Title = TaskText("assigned_title", locale)
		content.Body = title
	}
	return content, true
}

// formatTaskDue is «до пт 20.11, 18:00» in the recipient's time zone.
func formatTaskDue(due time.Time, timezone, locale string) string {
	location, err := time.LoadLocation(timezone)
	if err != nil || timezone == "" {
		location = time.UTC
	}
	local := due.In(location)
	if locale == "en" {
		return "due " + local.Format("Mon 2 Jan, 15:04")
	}
	return "до " + russianWeekdays[local.Weekday()] + " " + local.Format("02.01, 15:04")
}

// TaskText is a fixed string of the task push. Keep it equal to the apps'
// catalogs.
func TaskText(key, locale string) string {
	texts, ok := taskTexts[key]
	if !ok {
		return ""
	}
	if locale == "en" {
		return texts[1]
	}
	return texts[0]
}

var taskTexts = map[string][2]string{
	"in_chat":                 {"Задача в чате", "Task in"},
	"assigned_title":          {"Задача", "Task"},
	"assigned_hidden":         {"Вам поставили задачу", "You have a new task"},
	"item_title":              {"Пункт задачи", "Task item"},
	"item_hidden":             {"Вам назначили пункт задачи", "You have a new task item"},
	"item_in":                 {"в задаче", "in the task"},
	"offered_title":           {"Задача отделу", "Task for the department"},
	"offered_hidden":          {"Новая задача для вашего отдела", "A new task for your department"},
	"offered_position_title":  {"Задача для должности", "Task for the position"},
	"offered_position_hidden": {"Новая задача для вашей должности", "A new task for your position"},
	"offered_body":            {"возьмите, если можете", "take it if you can"},
	"taken_title":             {"взял(а) задачу", "took the task"},
	"nudged_title":            {"Напоминание о задаче", "Task reminder"},
	"due_soon_title":          {"Через час срок задачи", "A task is due in an hour"},
	"overdue_title":           {"Срок задачи прошёл", "A task is overdue"},
	"answers":                 {"отвечает", "assigned to"},
	"due_changed_title":       {"Новый срок задачи", "New task due date"},
	"no_due":                  {"без срока", "no due date"},
	"completed_title":         {"Готово", "Done"},
	"reopened_title":          {"Задачу вернули в работу", "A task was reopened"},
}
