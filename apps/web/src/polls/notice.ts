import type {
  Chat,
  PollNotifiedEvent,
  UserPreferences,
} from "@comamessenger/core";
import i18n from "../i18n";

/**
 * poll.notified shows as an in-app notification: a reminder like a mention
 * (not when notifications are off, snoozed or the chat is silenced), the
 * author's «closed by due date» always but during a pause.
 */
export function pollNoticeAllowed(
  kind: PollNotifiedEvent["kind"],
  preferences: UserPreferences | null,
  chat: Chat | undefined,
  occurredAt: Date,
): boolean {
  if (!preferences?.in_app_enabled) return false;
  if (
    preferences.snoozed_until &&
    occurredAt < new Date(preferences.snoozed_until)
  )
    return false;
  if (kind === "closed_expired" || !chat) return true;
  if (chat.muted_until && occurredAt < new Date(chat.muted_until)) return false;
  return chat.notify_level !== "none";
}

/** The words of the notification; the question when the poll is loaded. */
export function pollNotice(
  kind: PollNotifiedEvent["kind"],
  question: string | null,
  chatName: string,
): { title: string; body: string } {
  const values = {
    chat: chatName,
    question: question ?? i18n.t("pollNoticeNoQuestion"),
  };
  return kind === "closed_expired"
    ? {
        title: i18n.t("pollNoticeClosedTitle"),
        body: i18n.t("pollNoticeClosedBody", values),
      }
    : {
        title: i18n.t("pollNoticeRemindedTitle"),
        body: i18n.t("pollNoticeRemindedBody", values),
      };
}
