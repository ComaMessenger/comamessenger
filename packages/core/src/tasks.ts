import { APIError } from "./api";
import { atLocal, localDayDistance, type CalendarLocale } from "./calendar";
import { parseMarkdown, type MarkdownNode } from "./markdown";
import { canAddressGroups, expandDepartment, expandPosition } from "./org";
import { formatRequestDue } from "./requests";
import { hasServerFeature, serverFeature } from "./realtime";
import type {
  ChatMember,
  ChatUnread,
  CreateTaskRequest,
  DurableEvent,
  Message,
  MessageTask,
  MessageTaskItem,
  MyTaskItem,
  OrgStructure,
  TaskNotifiedEvent,
  TaskRole,
  TaskStatus,
  UpdateTaskRequest,
  User,
} from "./types";

/**
 * Tasks («Задача»), phase 6.6 wave 3: a message of type `task` whose card
 * lives in the chat feed. Shared by the phone and the web: the form and its
 * checks, the due dates offered, who may do what (the server's table),
 * «горит», keeping the task current from realtime events by version, and
 * optimistic actions with a rollback.
 *
 * `Message.task` is the same for every reader and comes in feed pages,
 * getTask and `message.*` frames; `task.updated` carries the whole task.
 * The author is the message's `actor_id`.
 */

/** The server limits, mirrored for the form. */
export const taskLimits = {
  titleMaxLength: 200,
  descriptionMaxLength: 4000,
  maxItems: 30,
  itemMaxLength: 200,
  maxCandidates: 100,
  /** A due date at least 5 minutes ahead… */
  dueMinLeadMs: 5 * 60_000,
  /** …and at most 365 days ahead. */
  dueHorizonMs: 365 * 24 * 60 * 60_000,
  /** «Напомнить ответственному за час до срока». */
  remindLeadMs: 60 * 60_000,
  /** «Напомнить»: once in 2 hours… */
  nudgeCooldownMs: 2 * 60 * 60_000,
  /** …and at most 5 times per task. */
  maxNudges: 5,
  /** Characters of a source message put into the title. */
  titleFromMessageLength: 200,
} as const;

/** «Горит»: overdue or due within this window. The server uses the same. */
export const taskHotWindowMs = 24 * 60 * 60_000;

/** True when the server announced tasks (`message_tasks`). */
export function tasksAvailable(
  features: Iterable<string> | null | undefined,
): boolean {
  return hasServerFeature(features, serverFeature.tasks);
}

// ---------------------------------------------------------------------------
// State

/** «Открыта» or «В работе»: the task still waits for someone. */
export function isTaskActive(
  task: Pick<MessageTask, "status"> | null | undefined,
): boolean {
  return task?.status === "open" || task?.status === "in_progress";
}

const dueTime = (task: Pick<MessageTask, "due_at">) =>
  task.due_at ? Date.parse(task.due_at) : NaN;

/** «Просрочена»: active and the due date passed. Not a status. */
export function isTaskOverdue(
  task: Pick<MessageTask, "status" | "due_at">,
  now: Date,
): boolean {
  const due = dueTime(task);
  return isTaskActive(task) && Number.isFinite(due) && due <= now.getTime();
}

/** «Горит»: active and overdue or due within 24 hours (decision 9). */
export function isTaskHot(
  task: Pick<MessageTask, "status" | "due_at">,
  now: Date,
): boolean {
  return isDueHot(task.due_at, now) && isTaskActive(task);
}

/** The «горит» rule for any due date: requests use it in the slot too. */
export function isDueHot(dueAt: string | null | undefined, now: Date): boolean {
  if (!dueAt) return false;
  const due = Date.parse(dueAt);
  return Number.isFinite(due) && due - now.getTime() < taskHotWindowMs;
}

/** The queue of a department or position nobody has taken yet. */
export function isTaskQueue(task: Pick<MessageTask, "assignee">): boolean {
  return task.assignee.kind !== "person" && task.assignee.actor_id === null;
}

/** «2 из 3» of the card; done items over all of them. */
export function taskProgress(task: Pick<MessageTask, "items" | "items_done">): {
  done: number;
  total: number;
} {
  return { done: task.items_done, total: task.items.length };
}

/** Decision 21: all items done, the task is still active — «закрыть задачу?». */
export function taskAllItemsDone(task: MessageTask): boolean {
  return (
    isTaskActive(task) &&
    task.items.length > 0 &&
    task.items.every((item) => item.done_at !== null)
  );
}

/**
 * The reader's part in a task, the strongest first: responsible, assignee
 * of an open item, candidate of an untaken queue, author. Null when the
 * task is not theirs. A closed task keeps the roles of its people.
 */
export function taskRole(
  task: MessageTask,
  authorID: string,
  me: string,
): TaskRole | null {
  if (task.assignee.actor_id === me) return "responsible";
  if (task.items.some((item) => item.assignee_id === me && !item.done_at))
    return "item";
  if (isTaskQueue(task) && task.assignee.candidate_ids.includes(me))
    return "candidate";
  if (authorID === me) return "author";
  return null;
}

/**
 * The task waits for the reader: active, and they are responsible, assignee
 * of an open item or a candidate of the queue. What «Ждут вас», the slot
 * and the counters count.
 */
export function isTaskOnMe(task: MessageTask, me: string): boolean {
  if (!isTaskActive(task)) return false;
  const role = taskRole(task, "", me);
  return role === "responsible" || role === "item" || role === "candidate";
}

// ---------------------------------------------------------------------------
// Who may do what

/** The reader as the task rights see them. */
export type TaskViewer = {
  actorID: string;
  /** chat_members.role of the reader; null or absent for non-members. */
  chatRole?: string | null;
  /** Workspace moderator (`chats.moderate`); counts as a chat admin in the chat. */
  moderator?: boolean;
  /** Still a member of the chat; absent means yes. */
  member?: boolean;
};

export type TaskPermissions = {
  /** Title, description, due date, the reminder before it. */
  edit: boolean;
  /** Change the responsible person (or the queue). */
  reassign: boolean;
  /** «Взять в работу»: open → in_progress. */
  start: boolean;
  /** Back to «Открыта»: in_progress → open. */
  stop: boolean;
  /** «Готово»: open | in_progress → done. */
  complete: boolean;
  /** «Вернуть в работу»: done → open. */
  reopen: boolean;
  /** «Отменить задачу». */
  cancel: boolean;
  /** «Вернуть» a canceled task: canceled → open. */
  restore: boolean;
  /** Add, change, delete, reorder and assign items. */
  manageItems: boolean;
  /** Items the reader may tick or untick. */
  checkItems: string[];
  /** «Напомнить» (time limits apart: see taskNudgeState). */
  nudge: boolean;
  /** «Взять себе» from the queue. */
  take: boolean;
};

const noPermissions = (): TaskPermissions => ({
  edit: false,
  reassign: false,
  start: false,
  stop: false,
  complete: false,
  reopen: false,
  cancel: false,
  restore: false,
  manageItems: false,
  checkItems: [],
  nudge: false,
  take: false,
});

/** Owner or admin of the chat, or a workspace moderator in it. */
export function isTaskChatAdmin(viewer: TaskViewer): boolean {
  if (viewer.member === false) return false;
  return (
    viewer.chatRole === "owner" ||
    viewer.chatRole === "admin" ||
    Boolean(viewer.moderator && viewer.chatRole)
  );
}

/**
 * What the reader may do with the task: decision 5's table, the same the
 * server checks (the shared cases are fixtures/taskPermissions.json).
 * Fields, the responsible person and items change only while the task is
 * active; a done or canceled task is reopened first.
 */
export function taskPermissions(
  task: MessageTask,
  authorID: string,
  viewer: TaskViewer,
): TaskPermissions {
  const result = noPermissions();
  if (viewer.member === false || !viewer.chatRole) return result;
  const me = viewer.actorID;
  const admin = isTaskChatAdmin(viewer);
  const author = authorID === me;
  const responsible = task.assignee.actor_id === me;
  const manager = author || admin;
  const worker = manager || responsible;
  const active = isTaskActive(task);
  result.edit = manager && active;
  result.reassign = manager && active;
  result.start = worker && task.status === "open";
  result.stop = worker && task.status === "in_progress";
  result.complete = worker && active;
  result.reopen = worker && task.status === "done";
  result.cancel = manager && active;
  result.restore = manager && task.status === "canceled";
  result.manageItems = worker && active;
  result.checkItems = active
    ? task.items
        .filter((item) => worker || item.assignee_id === me)
        .map((item) => item.id)
    : [];
  const someone = isTaskQueue(task)
    ? task.assignee.candidate_ids.some((id) => id !== me)
    : task.assignee.actor_id !== null && task.assignee.actor_id !== me;
  result.nudge =
    manager && active && someone && task.nudge_count < taskLimits.maxNudges;
  result.take =
    active && isTaskQueue(task) && task.assignee.candidate_ids.includes(me);
  return result;
}

/** The status a button leads to; null when the transition is not allowed. */
export function taskTransitionAllowed(from: TaskStatus, to: TaskStatus) {
  if (from === to) return false;
  switch (from) {
    case "open":
      return true;
    case "in_progress":
      return to === "open" || to === "done" || to === "canceled";
    case "done":
    case "canceled":
      return to === "open";
  }
}

/** Whether the permissions allow moving the task to `to`. */
export function canSetTaskStatus(
  task: MessageTask,
  permissions: TaskPermissions,
  to: TaskStatus,
): boolean {
  if (!taskTransitionAllowed(task.status, to)) return false;
  switch (to) {
    case "in_progress":
      return permissions.start;
    case "done":
      return permissions.complete;
    case "canceled":
      return permissions.cancel;
    case "open":
      if (task.status === "in_progress") return permissions.stop;
      if (task.status === "done") return permissions.reopen;
      return permissions.restore;
  }
}

export type TaskNudgeState =
  | { kind: "hidden" }
  /** «Напомнить {кому}». */
  | { kind: "ready"; left: number }
  /** «Напомнили · повторно через …». */
  | { kind: "cooldown"; until: Date; left: number };

/** The «Напомнить» button: allowed, waiting out the 2 hours, or hidden. */
export function taskNudgeState(
  task: MessageTask,
  permissions: Pick<TaskPermissions, "nudge">,
  now: Date,
): TaskNudgeState {
  if (!permissions.nudge) return { kind: "hidden" };
  const left = taskLimits.maxNudges - task.nudge_count;
  const last = task.last_nudge_at ? Date.parse(task.last_nudge_at) : NaN;
  if (Number.isFinite(last)) {
    const until = last + taskLimits.nudgeCooldownMs;
    if (until > now.getTime())
      return { kind: "cooldown", until: new Date(until), left };
  }
  return { kind: "ready", left };
}

// ---------------------------------------------------------------------------
// The card

export type TaskPill =
  | { kind: "status"; status: TaskStatus }
  /** Red «Просрочена» instead of the status. */
  | { kind: "overdue" };

export type TaskCardView = {
  role: TaskRole | null;
  permissions: TaskPermissions;
  pill: TaskPill;
  hot: boolean;
  overdue: boolean;
  dueAt: Date | null;
  progress: { done: number; total: number };
  queue: boolean;
  /** «Очередь пуста — назначьте ответственного»: nobody of the queue is in the chat. */
  queueEmpty: boolean;
  /** «не в чате»: the responsible person left or was deactivated. */
  assigneeAway: boolean;
  /** «Все пункты готовы — закрыть задачу?», to those who may close it. */
  suggestComplete: boolean;
  nudge: TaskNudgeState;
};

/**
 * Everything the card needs to choose its pill, buttons and hints. Pass
 * the candidates still in the chat (from the member list) to tell an empty
 * queue; without them the queue is taken as not empty.
 */
export function taskCardView(
  message: Pick<Message, "actor_id"> & { task: MessageTask },
  viewer: TaskViewer,
  now: Date,
  memberIDs?: ReadonlySet<string>,
): TaskCardView {
  const task = message.task;
  const permissions = taskPermissions(task, message.actor_id, viewer);
  const overdue = isTaskOverdue(task, now);
  const queue = isTaskQueue(task);
  const due = dueTime(task);
  return {
    role: taskRole(task, message.actor_id, viewer.actorID),
    permissions,
    pill: overdue
      ? { kind: "overdue" }
      : { kind: "status", status: task.status },
    hot: isTaskHot(task, now),
    overdue,
    dueAt: Number.isFinite(due) ? new Date(due) : null,
    progress: taskProgress(task),
    queue,
    queueEmpty:
      queue &&
      isTaskActive(task) &&
      memberIDs !== undefined &&
      !task.assignee.candidate_ids.some((id) => memberIDs.has(id)),
    assigneeAway: task.assignee.actor_id !== null && !task.assignee.in_chat,
    suggestComplete: permissions.complete && taskAllItemsDone(task),
    nudge: taskNudgeState(task, permissions, now),
  };
}

/** The due date as the card and lists say it: «сегодня, 18:00». */
export function formatTaskDue(
  due: Date,
  now: Date,
  locale: CalendarLocale,
): string {
  return formatRequestDue(due, now, locale);
}

// ---------------------------------------------------------------------------
// Due dates

export type TaskDuePresetID = "today" | "tomorrow" | "nextWorkday";
export type TaskDuePreset = { id: TaskDuePresetID; at: Date };

export const taskDueTodayHour = 18;
export const taskDueTomorrowHour = 12;
export const taskDueWorkdayHour = 9;

/** Translation keys of the chips. */
export const taskDuePresetLabelKeys: Record<TaskDuePresetID, string> = {
  today: "taskDueToday",
  tomorrow: "taskDueTomorrow",
  nextWorkday: "taskDueNextWorkday",
};

export type TaskDueProblem = "past" | "tooFar";

/** Why the server would refuse this due date; null when it is fine. */
export function taskDueProblem(at: Date, now: Date): TaskDueProblem | null {
  const lead = at.getTime() - now.getTime();
  if (!Number.isFinite(lead) || lead < taskLimits.dueMinLeadMs) return "past";
  if (lead > taskLimits.dueHorizonMs) return "tooFar";
  return null;
}

/**
 * Due dates offered as chips (decision 8, the rules of requestDuePresets):
 * «сегодня, 18:00» while at least an hour is left before it, «завтра,
 * 12:00», and «ближайший рабочий день, 9:00» — the next Monday to Friday
 * after today. «Без срока» and «Другая дата» are the form's own.
 */
export function taskDuePresets(now: Date): TaskDuePreset[] {
  const presets: TaskDuePreset[] = [];
  const today = atLocal(now, 0, taskDueTodayHour);
  if (today.getTime() - now.getTime() >= taskLimits.remindLeadMs)
    presets.push({ id: "today", at: today });
  presets.push({ id: "tomorrow", at: atLocal(now, 1, taskDueTomorrowHour) });
  let offset = 1;
  for (; offset <= 7; offset += 1) {
    const day = atLocal(now, offset, taskDueWorkdayHour);
    if (day.getDay() !== 0 && day.getDay() !== 6) break;
  }
  presets.push({
    id: "nextWorkday",
    at: atLocal(now, offset, taskDueWorkdayHour),
  });
  return presets.filter((preset) => !taskDueProblem(preset.at, now));
}

/** The reminder switch is available: the due date is an hour ahead or more. */
export function remindBeforeDueAvailable(
  dueAt: Date | null,
  now: Date,
): boolean {
  return (
    dueAt !== null && dueAt.getTime() - now.getTime() >= taskLimits.remindLeadMs
  );
}

// ---------------------------------------------------------------------------
// The form

export type TaskDraftAssignee =
  /** A person; null until one is chosen. */
  | { kind: "person"; actorID: string | null }
  /** A queue of the department and its subdepartments. */
  | { kind: "department"; departmentID: string | null }
  /** A queue of everyone with the position. */
  | { kind: "position"; positionID: string | null };

export type TaskAssigneeSegment = TaskDraftAssignee["kind"];

export type TaskDraftItem = {
  /** Local key for lists; never sent. */
  key: string;
  text: string;
  assigneeID: string | null;
};

export type TaskDraft = {
  title: string;
  description: string;
  assignee: TaskDraftAssignee;
  dueAt: Date | null;
  /** The switch; it only takes effect with a due date an hour ahead. */
  remindBeforeDue: boolean;
  /** Rows as typed, blank ones included; see taskDraftItems. */
  items: TaskDraftItem[];
  /** «из сообщения»: a message of the same chat. */
  sourceMessageID: string | null;
};

/** A fresh form, as the prototype opens it: the reminder on, no due date. */
export function emptyTaskDraft(): TaskDraft {
  return {
    title: "",
    description: "",
    assignee: { kind: "person", actorID: null },
    dueAt: null,
    remindBeforeDue: true,
    items: [],
    sourceMessageID: null,
  };
}

/**
 * «Сделать задачей»: the title from the message's text, the due date and
 * the responsible person empty, the link to the source.
 */
export function taskDraftFromMessage(
  message: Pick<Message, "id" | "body">,
): TaskDraft {
  return {
    ...emptyTaskDraft(),
    title: taskTitleFromMessage(message.body),
    sourceMessageID: message.id,
  };
}

function plainText(nodes: readonly MarkdownNode[]): string {
  const parts: string[] = [];
  for (const node of nodes) {
    switch (node.type) {
      case "text":
      case "codeblock":
        parts.push(node.value);
        break;
      case "mention":
        parts.push(node.label.startsWith("@") ? node.label : `@${node.label}`);
        break;
      case "contextMention":
        parts.push(`@${node.value}`);
        break;
      case "break":
        parts.push(" ");
        break;
      case "list":
        for (const item of node.items) parts.push(` ${plainText(item)} `);
        break;
      default:
        parts.push(plainText(node.children));
    }
  }
  return parts.join("");
}

/**
 * A title from a message's text (decision 12): Markdown left out, spaces
 * folded, at most 200 characters cut at a word boundary when there is one
 * in the second half.
 */
export function taskTitleFromMessage(text: string): string {
  const plain = plainText(parseMarkdown(text)).replace(/\s+/g, " ").trim();
  const chars = [...plain];
  const max = taskLimits.titleFromMessageLength;
  if (chars.length <= max) return plain;
  const head = chars.slice(0, max).join("");
  const space = head.lastIndexOf(" ");
  const cut = space >= max / 2 ? head.slice(0, space) : head;
  return cut.replace(/[\s,;:–—-]+$/u, "");
}

/**
 * Segments of «Ответственный»: «Человек» for everyone; «Отдел» and
 * «Должность» only with tasks and the org structure on the server and the
 * right `requests.address_groups`. A segment with nothing to choose (no
 * departments, no positions in a loaded structure) is left out.
 */
export function taskAssigneeSegments(
  user: User,
  features: Iterable<string> | null | undefined,
  structure?: OrgStructure | null,
): TaskAssigneeSegment[] {
  const segments: TaskAssigneeSegment[] = ["person"];
  const list = features ? [...features] : [];
  if (
    !hasServerFeature(list, serverFeature.tasks) ||
    !hasServerFeature(list, serverFeature.orgStructure) ||
    !canAddressGroups(user)
  )
    return segments;
  if (!structure || structure.departments.length) segments.push("department");
  if (!structure || structure.positions.length) segments.push("position");
  return segments;
}

/**
 * The candidates a queue would get: people of the department (with
 * subdepartments, primary or additional) or of the position who are in the
 * chat. Agents are never members of a department. The author is a candidate
 * too: a task may be put on oneself. Empty without the structure.
 */
export function taskCandidateIDs(
  assignee: TaskDraftAssignee,
  members: readonly Pick<ChatMember, "actor_id" | "type">[],
  structure?: OrgStructure | null,
): string[] {
  if (assignee.kind === "person" || !structure) return [];
  const chatMemberIDs = members
    .filter((member) => member.type === "user")
    .map((member) => member.actor_id);
  if (assignee.kind === "department") {
    if (!assignee.departmentID) return [];
    return expandDepartment(structure, assignee.departmentID, {
      chatMemberIDs,
    }).inChat.map((person) => person.actorID);
  }
  if (!assignee.positionID) return [];
  return expandPosition(structure, assignee.positionID, {
    chatMemberIDs,
  }).inChat.map((person) => person.actorID);
}

/** Items that will be sent: trimmed, blank rows left out. */
export function taskDraftItems(
  draft: Pick<TaskDraft, "items">,
): { text: string; assigneeID: string | null }[] {
  return draft.items
    .map((item) => ({ text: item.text.trim(), assigneeID: item.assigneeID }))
    .filter((item) => item.text.length > 0);
}

export type TaskDraftProblem =
  | { field: "title"; reason: "empty" | "tooLong" }
  | { field: "description"; reason: "tooLong" }
  | {
      field: "assignee";
      /** No person or group chosen; a queue nobody of the chat is in; over 100. */
      reason: "empty" | "audienceEmpty" | "tooMany";
    }
  | { field: "dueAt"; reason: TaskDueProblem }
  | {
      field: "items";
      reason: "tooMany" | "tooLong";
      /** The offending item among taskDraftItems. */
      index?: number;
    };

const length = (value: string) => [...value].length;

/**
 * The first reason the form cannot be sent, in the order of its fields;
 * null when it can. For a queue pass `candidates` (taskCandidateIDs(...)
 * .length); without it the queue size is left to the server.
 */
export function taskDraftProblem(
  draft: TaskDraft,
  now: Date,
  candidates?: number,
): TaskDraftProblem | null {
  const title = draft.title.trim();
  if (!title) return { field: "title", reason: "empty" };
  if (length(title) > taskLimits.titleMaxLength)
    return { field: "title", reason: "tooLong" };
  if (length(draft.description.trim()) > taskLimits.descriptionMaxLength)
    return { field: "description", reason: "tooLong" };
  const assignee = draft.assignee;
  const chosen =
    assignee.kind === "person"
      ? assignee.actorID
      : assignee.kind === "department"
        ? assignee.departmentID
        : assignee.positionID;
  if (!chosen) return { field: "assignee", reason: "empty" };
  if (assignee.kind !== "person" && candidates !== undefined) {
    if (candidates < 1) return { field: "assignee", reason: "audienceEmpty" };
    if (candidates > taskLimits.maxCandidates)
      return { field: "assignee", reason: "tooMany" };
  }
  if (draft.dueAt) {
    const reason = taskDueProblem(draft.dueAt, now);
    if (reason) return { field: "dueAt", reason };
  }
  const items = taskDraftItems(draft);
  if (items.length > taskLimits.maxItems)
    return { field: "items", reason: "tooMany" };
  for (const [index, item] of items.entries())
    if (length(item.text) > taskLimits.itemMaxLength)
      return { field: "items", reason: "tooLong", index };
  return null;
}

/** The body of createTask. The reminder is sent only when the due date allows it. */
export function toCreateTaskInput(
  draft: TaskDraft,
  clientMsgID: string,
  now: Date,
): CreateTaskRequest {
  const assignee = draft.assignee;
  const input: CreateTaskRequest = {
    client_msg_id: clientMsgID,
    title: draft.title.trim(),
    description: draft.description.trim(),
    assignee:
      assignee.kind === "person"
        ? { kind: "person", actor_id: assignee.actorID ?? "" }
        : assignee.kind === "department"
          ? { kind: "department", department_id: assignee.departmentID ?? "" }
          : { kind: "position", position_id: assignee.positionID ?? "" },
    remind_before_due:
      draft.remindBeforeDue && remindBeforeDueAvailable(draft.dueAt, now),
  };
  if (draft.dueAt) input.due_at = draft.dueAt.toISOString();
  const items = taskDraftItems(draft);
  if (items.length)
    input.items = items.map((item) =>
      item.assigneeID
        ? { text: item.text, assignee_id: item.assigneeID }
        : { text: item.text },
    );
  if (draft.sourceMessageID) input.source_message_id = draft.sourceMessageID;
  return input;
}

/**
 * Everything a createTask depends on but its client_msg_id. A retry with the
 * same signature reuses the id, so the server returns the task it already
 * made instead of a second one.
 */
export function taskSignature(input: CreateTaskRequest): string {
  return JSON.stringify([
    input.title,
    input.description,
    input.assignee.kind,
    input.assignee.actor_id ?? null,
    input.assignee.department_id ?? null,
    input.assignee.position_id ?? null,
    input.due_at ?? null,
    input.remind_before_due,
    (input.items ?? []).map((item) => [item.text, item.assignee_id ?? null]),
    input.source_message_id ?? null,
  ]);
}

/**
 * The PATCH body for the edit screen: only what changed, with the version
 * the screen was opened at. Null when nothing changed.
 */
export function taskUpdateInput(
  task: MessageTask,
  draft: Pick<
    TaskDraft,
    "title" | "description" | "dueAt" | "remindBeforeDue" | "assignee"
  >,
  now: Date,
): UpdateTaskRequest | null {
  const input: UpdateTaskRequest = { expected_version: task.version };
  const title = draft.title.trim();
  const description = draft.description.trim();
  if (title !== task.title) input.title = title;
  if (description !== task.description) input.description = description;
  const due = draft.dueAt ? draft.dueAt.toISOString() : null;
  const dueChanged =
    (due === null) !== (task.due_at === null) ||
    (due !== null &&
      task.due_at !== null &&
      Date.parse(due) !== Date.parse(task.due_at));
  if (dueChanged) input.due_at = due;
  // The switch is disabled less than an hour before the due date: then the
  // stored value stays, unless the due date itself changed or went away.
  const remind = remindBeforeDueAvailable(draft.dueAt, now)
    ? draft.remindBeforeDue
    : dueChanged
      ? false
      : task.remind_before_due;
  if (remind !== task.remind_before_due) input.remind_before_due = remind;
  const assignee = draft.assignee;
  if (assignee.kind === "person") {
    if (assignee.actorID && assignee.actorID !== task.assignee.actor_id)
      input.assignee = { kind: "person", actor_id: assignee.actorID };
  } else if (assignee.kind === "department") {
    if (
      assignee.departmentID &&
      (task.assignee.kind !== "department" ||
        task.assignee.department_id !== assignee.departmentID)
    )
      input.assignee = {
        kind: "department",
        department_id: assignee.departmentID,
      };
  } else if (
    assignee.positionID &&
    (task.assignee.kind !== "position" ||
      task.assignee.position_id !== assignee.positionID)
  )
    input.assignee = { kind: "position", position_id: assignee.positionID };
  return Object.keys(input).length > 1 ? input : null;
}

/** The edit screen's form, filled from the task. */
export function taskDraftFromTask(task: MessageTask): TaskDraft {
  // A taken queue has a responsible person: the form shows the person.
  const assignee: TaskDraftAssignee =
    task.assignee.actor_id || task.assignee.kind === "person"
      ? { kind: "person", actorID: task.assignee.actor_id }
      : task.assignee.kind === "department"
        ? {
            kind: "department",
            departmentID: task.assignee.department_id ?? null,
          }
        : { kind: "position", positionID: task.assignee.position_id ?? null };
  return {
    title: task.title,
    description: task.description,
    assignee,
    dueAt: task.due_at ? new Date(task.due_at) : null,
    remindBeforeDue: task.remind_before_due,
    items: task.items.map((item) => ({
      key: item.id,
      text: item.text,
      assigneeID: item.assignee_id,
    })),
    sourceMessageID: task.source?.message_id ?? null,
  };
}

// ---------------------------------------------------------------------------
// Realtime

export type TaskEventType = "task.updated" | "task.notified";

export function isTaskEvent(type: string): type is TaskEventType {
  return type === "task.updated" || type === "task.notified";
}

export type TaskUpdate = {
  message_id: string;
  chat_id: string;
  task: MessageTask;
};

export type TaskEvent =
  | { type: "task.updated"; data: TaskUpdate; occurredAt: string }
  | { type: "task.notified"; data: TaskNotifiedEvent; occurredAt: string };

const notifiedKinds: ReadonlySet<string> = new Set<TaskNotifiedEvent["kind"]>([
  "assigned",
  "unassigned",
  "item_assigned",
  "offered",
  "taken",
  "nudged",
  "due_soon",
  "overdue",
  "due_changed",
  "completed",
  "reopened",
]);

const taskStatuses: ReadonlySet<string> = new Set<TaskStatus>([
  "open",
  "in_progress",
  "done",
  "canceled",
]);

const isString = (value: unknown): value is string => typeof value === "string";
const isNullableString = (value: unknown): value is string | null =>
  value === null || typeof value === "string";
const isCount = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;

/** A MessageTask as the client needs it; anything else is null. */
export function parseMessageTask(value: unknown): MessageTask | null {
  if (!value || typeof value !== "object") return null;
  const task = value as Record<string, unknown>;
  const assignee = task.assignee as Record<string, unknown> | null;
  if (
    !isString(task.title) ||
    !isString(task.description) ||
    !isString(task.status) ||
    !taskStatuses.has(task.status) ||
    !isNullableString(task.due_at) ||
    !Array.isArray(task.items) ||
    !isCount(task.items_done) ||
    !isCount(task.version) ||
    !assignee ||
    typeof assignee !== "object" ||
    !isString(assignee.kind) ||
    !isNullableString(assignee.actor_id) ||
    !Array.isArray(assignee.candidate_ids)
  )
    return null;
  for (const item of task.items as unknown[]) {
    const row = item as Record<string, unknown> | null;
    if (
      !row ||
      !isString(row.id) ||
      !isString(row.text) ||
      !isNullableString(row.assignee_id) ||
      !isNullableString(row.done_at)
    )
      return null;
  }
  return value as MessageTask;
}

/**
 * A task.* event when its data has the expected shape, null otherwise: the
 * log is replayed to new devices and may come from a newer server, so it is
 * checked rather than trusted.
 */
export function parseTaskEvent(event: DurableEvent): TaskEvent | null {
  const value = event.data as Record<string, unknown> | null;
  if (!value || typeof value !== "object") return null;
  if (!isString(value.message_id) || !isString(value.chat_id)) return null;
  const ids = { message_id: value.message_id, chat_id: value.chat_id };
  const occurredAt = event.occurred_at;
  if (event.type === "task.updated") {
    const task = parseMessageTask(value.task);
    if (!task) return null;
    return { type: event.type, occurredAt, data: { ...ids, task } };
  }
  if (event.type === "task.notified") {
    if (!isString(value.kind) || !notifiedKinds.has(value.kind)) return null;
    return {
      type: event.type,
      occurredAt,
      data: {
        ...ids,
        kind: value.kind as TaskNotifiedEvent["kind"],
        by_actor_id: isString(value.by_actor_id) ? value.by_actor_id : null,
        due_at: isString(value.due_at) ? value.due_at : null,
      },
    };
  }
  return null;
}

/** The fresher of two tasks by version; the first on a tie. */
export function newerTask(
  current: MessageTask | null | undefined,
  incoming: MessageTask | null | undefined,
): MessageTask | null {
  if (!current) return incoming ?? null;
  if (!incoming) return current;
  return incoming.version > current.version ? incoming : current;
}

/**
 * A message with the task of a task.updated or a REST reply put in when it
 * is newer. The same object comes back when nothing changed, so callers can
 * tell by identity.
 */
export function reduceTask<T extends Pick<Message, "id" | "task">>(
  message: T,
  update: Pick<TaskUpdate, "message_id" | "task">,
): T {
  if (message.id !== update.message_id) return message;
  if (message.task && message.task.version >= update.task.version)
    return message;
  return { ...message, task: update.task };
}

/** reduceTask over a list of messages; the same array when nothing changed. */
export function reduceTaskMessages<T extends Pick<Message, "id" | "task">>(
  messages: readonly T[],
  update: Pick<TaskUpdate, "message_id" | "task">,
): readonly T[] {
  const index = messages.findIndex((item) => item.id === update.message_id);
  if (index < 0) return messages;
  const next = reduceTask(messages[index]!, update);
  if (next === messages[index]) return messages;
  const copy = [...messages];
  copy[index] = next;
  return copy;
}

/**
 * Updates that ran ahead of their message: task.updated for a message the
 * cache does not have yet (a page still loading, `message.created` behind).
 * Keep the newest per message and put it in when the message arrives.
 */
export type EarlyTaskUpdates = Record<string, MessageTask>;

/** Remembers an update whose message is not cached; the newer one stays. */
export function rememberTaskUpdate(
  early: EarlyTaskUpdates,
  update: Pick<TaskUpdate, "message_id" | "task">,
): EarlyTaskUpdates {
  const known = early[update.message_id];
  if (known && known.version >= update.task.version) return early;
  return { ...early, [update.message_id]: update.task };
}

/**
 * Puts remembered updates into arriving messages and forgets them. Returns
 * the same objects when nothing applied.
 */
export function absorbEarlyTasks<T extends Pick<Message, "id" | "task">>(
  early: EarlyTaskUpdates,
  messages: readonly T[],
): { early: EarlyTaskUpdates; messages: readonly T[] } {
  let nextEarly = early;
  let nextMessages = messages;
  messages.forEach((message, index) => {
    const task = early[message.id];
    if (!task) return;
    if (nextEarly === early) nextEarly = { ...early };
    delete nextEarly[message.id];
    if (!message.task) return;
    const reduced = reduceTask(message, { message_id: message.id, task });
    if (reduced === message) return;
    if (nextMessages === messages) nextMessages = [...messages];
    (nextMessages as T[])[index] = reduced;
  });
  return { early: nextEarly, messages: nextMessages };
}

/**
 * GET /unread should be read again after this task.updated: the reader was
 * on the task before or is after (an assignment, a take, a closing). With
 * no previous task known, only the new state is looked at.
 */
export function taskUpdateRefreshesUnread(
  previous: MessageTask | null | undefined,
  next: MessageTask,
  me: string,
): boolean {
  if (isTaskOnMe(next, me)) return true;
  return previous ? isTaskOnMe(previous, me) : false;
}

// ---------------------------------------------------------------------------
// Lists

/** A task in «Ждут вас» and «Мои задачи»: the shape of listMyTasks. */
export type TaskListItem = MyTaskItem;

/** Messages with a task, as list rows carry them. */
export type TaskMessage = Message & { task: MessageTask };

export function hasTask(
  message: Pick<Message, "task"> | null | undefined,
): message is TaskMessage {
  return Boolean(message?.task);
}

export type TaskListKind =
  /** listChatTasks(state=open): active tasks of a chat. */
  | { list: "chatOpen" }
  /** listChatTasks(state=done|canceled). */
  | { list: "chatClosed"; status: "done" | "canceled" }
  /** «На мне»: active and on the reader. */
  | { list: "assigned"; me: string }
  /** «Поставил(а) я»: active, authored by the reader. */
  | { list: "authored" }
  /** «Готово за 7 дней» of either. */
  | { list: "done" };

function belongs(task: MessageTask, kind: TaskListKind): boolean {
  switch (kind.list) {
    case "chatOpen":
    case "authored":
      return isTaskActive(task);
    case "chatClosed":
      return task.status === kind.status;
    case "assigned":
      return isTaskOnMe(task, kind.me);
    case "done":
      return task.status === "done";
  }
}

export type TaskListReduction<T> = {
  items: T[];
  changed: boolean;
  /** The task may belong to the list now but is not in it: read it again. */
  stale: boolean;
};

/**
 * Applies a task.updated to a list page: the newer task replaces the old
 * one, a task that no longer belongs (closed, taken by another candidate,
 * reassigned) leaves. A task that may now belong but is missing marks the
 * list stale. Works for Message[] (chat tasks) and for MyTaskItem[].
 */
export function reduceTaskList<
  T extends
    | Pick<Message, "id" | "task">
    | { message: Pick<Message, "id" | "task"> },
>(
  items: readonly T[],
  update: Pick<TaskUpdate, "message_id" | "task">,
  kind: TaskListKind,
): TaskListReduction<T> {
  const messageOf = (item: T) =>
    "message" in item ? item.message : (item as Pick<Message, "id" | "task">);
  const index = items.findIndex(
    (item) => messageOf(item).id === update.message_id,
  );
  const fits = belongs(update.task, kind);
  if (index < 0) return { items: [...items], changed: false, stale: fits };
  const item = items[index]!;
  const message = messageOf(item);
  const reduced = reduceTask(message, update);
  if (reduced === message)
    return { items: [...items], changed: false, stale: false };
  const next = [...items];
  if (!fits) {
    next.splice(index, 1);
    return { items: next, changed: true, stale: false };
  }
  next[index] = (
    "message" in item ? { ...item, message: reduced } : reduced
  ) as T;
  return { items: next, changed: true, stale: false };
}

const taskDue = (task: MessageTask) =>
  task.due_at ? Date.parse(task.due_at) : Infinity;

/**
 * The server's order of active tasks: with a due date first (earliest, the
 * overdue ones on top), then without one, newest first.
 */
export function compareTasks(
  left: Pick<Message, "created_seq"> & { task: MessageTask },
  right: Pick<Message, "created_seq"> & { task: MessageTask },
): number {
  return (
    taskDue(left.task) - taskDue(right.task) ||
    right.created_seq - left.created_seq
  );
}

export type MyTaskGroupKind = "overdue" | "today" | "later" | "noDue" | "done";

export const myTaskGroupOrder: readonly MyTaskGroupKind[] = [
  "overdue",
  "today",
  "later",
  "noDue",
  "done",
];

/** Translation keys of the group captions (prototype E). */
export const myTaskGroupLabelKeys: Record<MyTaskGroupKind, string> = {
  overdue: "taskGroupOverdue",
  today: "taskGroupToday",
  later: "taskGroupLater",
  noDue: "taskGroupNoDue",
  done: "taskGroupDone",
};

export type MyTaskGroup<T> = { kind: MyTaskGroupKind; items: T[] };

/**
 * «Просрочено · Сегодня · Позже · Без срока · Готово за 7 дней» of «Мои
 * задачи». Active tasks by due date, done ones (pass the state=done page)
 * by the time they were closed, latest first. Canceled ones are left out;
 * empty groups too.
 */
export function groupMyTasks<
  T extends {
    message: Pick<Message, "created_seq"> & { task?: MessageTask | null };
  },
>(items: readonly T[], now: Date): MyTaskGroup<T>[] {
  const groups = new Map<MyTaskGroupKind, T[]>(
    myTaskGroupOrder.map((kind) => [kind, []]),
  );
  const seen = new Set<T["message"]>();
  for (const item of items) {
    const task = item.message.task;
    if (!task || seen.has(item.message)) continue;
    seen.add(item.message);
    let kind: MyTaskGroupKind;
    if (task.status === "done") kind = "done";
    else if (!isTaskActive(task)) continue;
    else if (!task.due_at) kind = "noDue";
    else if (isTaskOverdue(task, now)) kind = "overdue";
    else if (localDayDistance(new Date(task.due_at), now) <= 0) kind = "today";
    else kind = "later";
    groups.get(kind)!.push(item);
  }
  const closedAt = (item: T) =>
    item.message.task?.status_changed_at
      ? Date.parse(item.message.task.status_changed_at)
      : 0;
  const result: MyTaskGroup<T>[] = [];
  for (const kind of myTaskGroupOrder) {
    const list = groups.get(kind)!;
    if (!list.length) continue;
    if (kind === "done")
      list.sort((left, right) => closedAt(right) - closedAt(left));
    else
      list.sort((left, right) =>
        compareTasks(left.message as TaskMessage, right.message as TaskMessage),
      );
    result.push({ kind, items: list });
  }
  return result;
}

/**
 * Rows of «Задачи · на мне»: the server's items of several pages (open and
 * done) with the same task once, the freshest copy kept.
 */
export function mergeTaskItems<
  T extends { message: Pick<Message, "id" | "task"> },
>(...pages: readonly (readonly T[])[]): T[] {
  const byID = new Map<string, T>();
  for (const page of pages)
    for (const item of page) {
      const known = byID.get(item.message.id);
      if (
        !known ||
        (item.message.task?.version ?? 0) > (known.message.task?.version ?? 0)
      )
        byID.set(item.message.id, item);
    }
  return [...byID.values()];
}

// ---------------------------------------------------------------------------
// The chat list

export type ChatTaskBadge =
  /** «задача до 12:00». */
  | { kind: "due"; at: Date }
  /** «задача просрочена». */
  | { kind: "overdue" };

/**
 * The red mark on a chat row (decision 19): only when a task on the reader
 * burns. Open tasks that do not burn give no mark.
 */
export function chatTaskBadge(
  chat:
    | Pick<ChatUnread, "tasks_mine_open" | "tasks_mine_next_due_at">
    | undefined,
  now: Date,
): ChatTaskBadge | null {
  if ((chat?.tasks_mine_open ?? 0) <= 0) return null;
  const due = chat?.tasks_mine_next_due_at;
  if (!due || !isDueHot(due, now)) return null;
  const at = Date.parse(due);
  return at <= now.getTime()
    ? { kind: "overdue" }
    : { kind: "due", at: new Date(at) };
}

// ---------------------------------------------------------------------------
// Optimistic actions

function withStatus(
  task: MessageTask,
  status: TaskStatus,
  me: string,
  authorID: string,
  now: Date,
): MessageTask {
  return {
    ...task,
    status,
    canceled_reason:
      status === "canceled" ? (authorID === me ? "author" : "moderator") : null,
    status_changed_at: now.toISOString(),
    status_changed_by: me,
  };
}

/**
 * The task right after a status button, before the server replies; null
 * when the transition is not allowed. The version stays: the server's
 * reply or task.updated comes with a higher one and replaces it.
 */
export function optimisticTaskStatus(
  task: MessageTask,
  status: TaskStatus,
  me: string,
  authorID: string,
  now: Date,
): MessageTask | null {
  if (!taskTransitionAllowed(task.status, status)) return null;
  return withStatus(task, status, me, authorID, now);
}

/** «Взять себе»: the reader becomes responsible. Null when not a candidate. */
export function optimisticTakeTask(
  task: MessageTask,
  me: string,
): MessageTask | null {
  if (!isTaskQueue(task) || !task.assignee.candidate_ids.includes(me))
    return null;
  return {
    ...task,
    assignee: { ...task.assignee, actor_id: me, in_chat: true },
  };
}

/** An item ticked or unticked; null when there is no such item. */
export function optimisticTaskItemDone(
  task: MessageTask,
  itemID: string,
  done: boolean,
  me: string,
  now: Date,
): MessageTask | null {
  if (!task.items.some((item) => item.id === itemID)) return null;
  const items = task.items.map((item) =>
    item.id !== itemID || Boolean(item.done_at) === done
      ? item
      : {
          ...item,
          done_at: done ? now.toISOString() : null,
          done_by: done ? me : null,
        },
  );
  return {
    ...task,
    items,
    items_done: items.filter((item) => item.done_at).length,
  };
}

/** An item's text or assignee changed; null when there is no such item. */
export function optimisticTaskItemChange(
  task: MessageTask,
  itemID: string,
  change: { text?: string; assigneeID?: string | null },
): MessageTask | null {
  if (!task.items.some((item) => item.id === itemID)) return null;
  return {
    ...task,
    items: task.items.map((item) =>
      item.id !== itemID
        ? item
        : {
            ...item,
            ...(change.text !== undefined ? { text: change.text.trim() } : {}),
            ...(change.assigneeID !== undefined
              ? { assignee_id: change.assigneeID, assignee_in_chat: true }
              : {}),
          },
    ),
  };
}

/** A new item at the end, with a temporary id until the server's reply. */
export function optimisticTaskItemAdd(
  task: MessageTask,
  item: { id: string; text: string; assigneeID?: string | null },
): MessageTask {
  const row: MessageTaskItem = {
    id: item.id,
    text: item.text.trim(),
    assignee_id: item.assigneeID ?? null,
    assignee_in_chat: true,
    done_at: null,
    done_by: null,
  };
  return { ...task, items: [...task.items, row] };
}

/** An item removed. */
export function optimisticTaskItemDelete(
  task: MessageTask,
  itemID: string,
): MessageTask {
  const items = task.items.filter((item) => item.id !== itemID);
  return {
    ...task,
    items,
    items_done: items.filter((entry) => entry.done_at).length,
  };
}

/** The fields of an UpdateTaskRequest put in at once. */
export function optimisticTaskUpdate(
  task: MessageTask,
  input: UpdateTaskRequest,
): MessageTask {
  const next: MessageTask = { ...task };
  if (input.title !== undefined) next.title = input.title;
  if (input.description !== undefined) next.description = input.description;
  if (input.due_at !== undefined) next.due_at = input.due_at;
  if (input.remind_before_due !== undefined)
    next.remind_before_due = input.remind_before_due;
  if (input.assignee?.kind === "person" && input.assignee.actor_id)
    next.assignee = {
      kind: "person",
      actor_id: input.assignee.actor_id,
      label: "",
      candidate_ids: [],
      in_chat: true,
      department_id: null,
      position_id: null,
    };
  return next;
}

/** «Напомнить» sent: the button waits out the cooldown. */
export function optimisticTaskNudge(task: MessageTask, now: Date): MessageTask {
  return {
    ...task,
    last_nudge_at: now.toISOString(),
    nudge_count: Math.min(taskLimits.maxNudges, task.nudge_count + 1),
  };
}

/** Where the task of one message is read and written: the store or a list cache. */
export type TaskCacheAccess = {
  read(): MessageTask | null;
  /** Writes as it is, older or not: an optimistic task or a rollback. */
  write(task: MessageTask): void;
};

/**
 * Runs a task action optimistically: writes `optimistic` at once, sends,
 * then puts the server's task in (when newer than the cache). On an error
 * the previous task comes back unless something newer arrived meanwhile;
 * a conflict or «уже взяли» puts the server's current task (details.task)
 * in. The error is thrown again for the toast (taskErrorKind).
 */
export async function performTaskAction(
  cache: TaskCacheAccess,
  optimistic: MessageTask | null,
  send: () => Promise<MessageTask | Pick<Message, "task"> | void>,
): Promise<MessageTask | null> {
  const previous = cache.read();
  if (optimistic) cache.write(optimistic);
  try {
    const result = await send();
    const task =
      result && "task" in result && !("title" in result)
        ? (result.task ?? null)
        : ((result as MessageTask | undefined) ?? null);
    const current = cache.read();
    if (task && (!current || task.version >= current.version))
      cache.write(task);
    return task;
  } catch (error) {
    const current = cache.read();
    if (current === optimistic && previous) cache.write(previous);
    const server = taskFromError(error);
    if (server) {
      const now = cache.read();
      if (!now || server.version >= now.version) cache.write(server);
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Cache keys and errors

/** TanStack Query keys; they always carry the reader's id. */
export const taskKeys = {
  all: (userID: string) => ["tasks", userID] as const,
  task: (userID: string, messageID: string) =>
    ["tasks", userID, "task", messageID] as const,
  chat: (userID: string, chatID: string, state: "open" | "done" | "canceled") =>
    ["tasks", userID, "chat", chatID, state] as const,
  mine: (
    userID: string,
    role: "assigned" | "authored",
    state: "open" | "done",
  ) => ["tasks", userID, "mine", role, state] as const,
  waiting: (userID: string, kind: "all" | "requests" | "tasks") =>
    ["tasks", userID, "waiting", kind] as const,
};

export type TaskErrorKind =
  | "invalid"
  /** The responsible person or an item's assignee cannot be chosen. */
  | "assigneeInvalid"
  | "tooManyCandidates"
  | "audienceEmpty"
  /** A department or position without requests.address_groups. */
  | "audienceForbidden"
  /** The department or position was deleted meanwhile. */
  | "audienceGone"
  | "notMember"
  | "forbidden"
  | "gone"
  /** Someone changed the task meanwhile: the current one is in the cache now. */
  | "conflict"
  /** Another candidate took it first. */
  | "alreadyTaken"
  | "statusInvalid"
  | "limit"
  | "archived"
  /** «Напомнить» too soon; see APIError.retryAfterSeconds. */
  | "nudgeTooSoon"
  | "rateLimited"
  /** The server has no tasks yet. */
  | "unavailable"
  | "network"
  | "other";

/** What went wrong with a task call, for the toast. */
export function taskErrorKind(error: unknown): TaskErrorKind {
  if (!(error instanceof APIError)) return "network";
  switch (error.code) {
    case "task_invalid":
    case "validation_failed":
      return "invalid";
    case "task_assignee_invalid":
      return "assigneeInvalid";
    case "task_too_many_candidates":
      return "tooManyCandidates";
    case "task_audience_empty":
      return "audienceEmpty";
    case "task_audience_forbidden":
      return "audienceForbidden";
    case "department_not_found":
    case "position_not_found":
      return "audienceGone";
    case "not_member":
      return "notMember";
    case "task_forbidden":
      return "forbidden";
    case "task_not_found":
    case "message_not_found":
      return "gone";
    case "task_version_conflict":
    case "version_conflict":
      return "conflict";
    case "task_already_taken":
      return "alreadyTaken";
    case "task_status_invalid":
      return "statusInvalid";
    case "task_limit_reached":
      return "limit";
    case "chat_archived":
      return "archived";
    case "task_nudge_too_soon":
      return "nudgeTooSoon";
    case "rate_limited":
      return "rateLimited";
    case "not_implemented":
      return "unavailable";
  }
  if (error.status === 404) return "gone";
  if (error.status === 403) return "forbidden";
  if (error.status === 422) return "invalid";
  if (error.status === 429) return "rateLimited";
  if (error.status === 501) return "unavailable";
  return "other";
}

/** The field the server named in 422 task_invalid (`details.field`). */
export function taskInvalidField(error: unknown): string | null {
  if (!(error instanceof APIError) || error.code !== "task_invalid")
    return null;
  return typeof error.details.field === "string" ? error.details.field : null;
}

/**
 * The current task a 409 task_version_conflict or task_already_taken
 * carries in details.task; null otherwise.
 */
export function taskFromError(error: unknown): MessageTask | null {
  if (!(error instanceof APIError)) return null;
  if (
    error.code !== "task_version_conflict" &&
    error.code !== "task_already_taken"
  )
    return null;
  return parseMessageTask(error.details.task);
}
