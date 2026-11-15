import type {
  Chat,
  TaskNotifiedEvent,
  UserPreferences,
} from "@comamessenger/core";
import i18n from "../i18n";

/** Kinds that always reach the author (decision on push filters). */
const alwaysKinds = new Set<TaskNotifiedEvent["kind"]>(["taken", "completed"]);

/**
 * A task.notified event shows as an in-app notification like a mention:
 * not when notifications are off, snoozed or the chat is silenced; «taken»
 * and «completed» reach the author anyway, «unassigned» never shows.
 */
export function taskNoticeAllowed(
  kind: TaskNotifiedEvent["kind"],
  preferences: UserPreferences | null,
  chat: Chat | undefined,
  occurredAt: Date,
): boolean {
  if (kind === "unassigned" || !preferences?.in_app_enabled) return false;
  if (
    preferences.snoozed_until &&
    occurredAt < new Date(preferences.snoozed_until)
  )
    return false;
  if (alwaysKinds.has(kind)) return true;
  if (!chat) return true;
  if (chat.muted_until && occurredAt < new Date(chat.muted_until)) return false;
  return chat.notify_level !== "none";
}

const bodyKeys: Record<TaskNotifiedEvent["kind"], string> = {
  assigned: "taskNoticeAssigned",
  unassigned: "taskNoticeAssigned",
  item_assigned: "taskNoticeItemAssigned",
  offered: "taskNoticeOffered",
  taken: "taskNoticeTaken",
  nudged: "taskNoticeNudged",
  due_soon: "taskNoticeDueSoon",
  overdue: "taskNoticeOverdue",
  due_changed: "taskNoticeDueChanged",
  completed: "taskNoticeCompleted",
  reopened: "taskNoticeReopened",
};

/** The words of the notification; the title of the task when it is known. */
export function taskNotice(
  kind: TaskNotifiedEvent["kind"],
  title: string | null,
  chatName: string,
): { title: string; body: string } {
  return {
    title: i18n.t("taskNoticeTitle", { chat: chatName }),
    body: i18n.t(bodyKeys[kind], {
      title: title ?? i18n.t("taskNoticeNoTitle"),
    }),
  };
}
