import { useStore } from "zustand";
import {
  formatTaskDue,
  localDayDistance,
  taskErrorKind,
  type ChatMember,
  type Chat,
  type TaskErrorKind,
  type TaskViewer,
} from "@comamessenger/core";
import i18n from "../i18n";
import { calendarLocale } from "../requests/format";
import { hasPermission } from "../settings";
import { useMessenger } from "../shell/MessengerContext";

const taskFailKeys: Record<TaskErrorKind, string> = {
  invalid: "taskFailInvalid",
  assigneeInvalid: "taskFailAssigneeInvalid",
  tooManyCandidates: "taskFailTooManyCandidates",
  audienceEmpty: "taskFailAudienceEmpty",
  audienceForbidden: "taskFailAudienceForbidden",
  audienceGone: "taskFailAudienceGone",
  notMember: "taskFailNotMember",
  forbidden: "taskFailForbidden",
  gone: "taskFailGone",
  conflict: "taskFailConflict",
  alreadyTaken: "taskFailAlreadyTaken",
  statusInvalid: "taskFailStatusInvalid",
  limit: "taskFailLimit",
  archived: "taskFailArchived",
  nudgeTooSoon: "taskFailNudgeTooSoon",
  rateLimited: "taskFailRateLimited",
  unavailable: "taskFailUnavailable",
  network: "taskFailNetwork",
  other: "taskFailOther",
};

/** Words for a refused task call, for a toast or the form. */
export function taskErrorText(error: unknown): string {
  return i18n.t(taskFailKeys[taskErrorKind(error)]);
}

/**
 * The reader as the task rights see them: their role in the chat (from the
 * chat list, or the member list when the chat is not loaded) and the
 * workspace moderator right.
 */
export function useTaskViewer(
  chatID: string,
  members?: readonly Pick<ChatMember, "actor_id" | "role">[],
): TaskViewer {
  const { store, user } = useMessenger();
  const chat = useStore(store, (state) => state.chats[chatID]) as
    | Chat
    | undefined;
  const member = members?.find((item) => item.actor_id === user.id);
  return {
    actorID: user.id,
    chatRole: chat?.role ?? member?.role ?? null,
    moderator: hasPermission(user, "chats.moderate"),
  };
}

/** A person's first name for Remind Oleg and short lines. */
export function firstName(name: string | undefined): string {
  return (name ?? "").trim().split(/\s+/)[0] ?? "";
}

/** 12:00 today, tomorrow, 9:00 otherwise: the chat list mark. */
export function formatTaskBadgeDue(at: Date, now: Date): string {
  return localDayDistance(at, now) === 0
    ? at.toLocaleTimeString(i18n.language === "ru" ? "ru-RU" : "en-GB", {
        hour: "2-digit",
        minute: "2-digit",
      })
    : formatTaskDue(at, now, calendarLocale());
}
