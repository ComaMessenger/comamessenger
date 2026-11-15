import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { useStore } from "zustand";
import {
  formatTaskDue,
  grantsPermission,
  localDayDistance,
  taskErrorKind,
  type ChatMember,
  type MessageTask,
  type TaskErrorKind,
  type TaskStatus,
  type TaskViewer,
} from "@comamessenger/core";
import { useMessenger } from "@/messenger/MessengerProvider";
import { useSignedIn } from "@/session/SessionProvider";
import { calendarLocale } from "@/requests/locale";
import { formatTime, type Clock } from "@/scheduled/format";

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

/** The translation key for a refused task call. */
export function taskFailKey(error: unknown): string {
  return taskFailKeys[taskErrorKind(error)];
}

/** Words for a refused task call, for a notice or the form. */
export function useTaskErrorText() {
  const { t } = useTranslation();
  return useCallback((error: unknown) => t(taskFailKey(error)), [t]);
}

/** «Открыта», «В работе», «Готово», «Отменена». */
export const taskStatusKeys: Record<TaskStatus, string> = {
  open: "taskStatusOpen",
  in_progress: "taskStatusInProgress",
  done: "taskStatusDone",
  canceled: "taskStatusCanceled",
};

/**
 * The reader as the task rights see them: their role in the chat (from the
 * chat list, or the member list when the chat is not loaded) and the
 * workspace moderator right.
 */
export function useTaskViewer(
  chatID: string,
  members?: readonly Pick<ChatMember, "actor_id" | "role">[],
): TaskViewer {
  const { user } = useSignedIn();
  const { store } = useMessenger();
  const chatRole = useStore(store, (state) => state.chats[chatID]?.role);
  const member = members?.find((item) => item.actor_id === user.id);
  return {
    actorID: user.id,
    chatRole: chatRole ?? member?.role ?? null,
    moderator: grantsPermission(
      user.role,
      user.permissions ?? [],
      "chats.moderate",
    ),
  };
}

/** Who answers for the task: «Вы», a name, or the queue of a group. */
export function taskAssigneeText(
  task: MessageTask,
  nameOf: (actorID: string) => string,
  t: (key: string, values?: Record<string, unknown>) => string,
  selfID: string,
): string {
  const assignee = task.assignee;
  if (assignee.actor_id)
    return assignee.actor_id === selfID
      ? t("taskYou")
      : nameOf(assignee.actor_id);
  return t(
    assignee.kind === "department"
      ? "taskQueueDepartment"
      : "taskQueuePosition",
    { label: assignee.label },
  );
}

/** «12:00» today, «завтра, 12:00» otherwise: the chat list mark. */
export function formatTaskBadgeDue(
  at: Date,
  now: Date,
  clock: Clock,
  language: string,
): string {
  return localDayDistance(at, now) === 0
    ? formatTime(at, clock)
    : formatTaskDue(at, now, calendarLocale(language));
}
