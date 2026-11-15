import type { CalendarLocale } from "./calendar";
import { hasServerFeature, serverFeature } from "./realtime";
import { formatRequestDue, type RequestViewers } from "./requests";
import {
  compareTasks,
  isDueHot,
  isTaskActive,
  isTaskHot,
  isTaskOnMe,
  isTaskOverdue,
  taskPermissions,
  taskTitleFromMessage,
  type TaskViewer,
} from "./tasks";
import type {
  ChatTaskCounts,
  ChatUnread,
  Message,
  MessageTask,
  ScheduledMessage,
} from "./types";

/**
 * The one slot under the chat header (decision 17 of phase 6.6): a single
 * line built on the device from what the client already loads — open tasks
 * of the chat, pinned messages, requests waiting for the reader, the
 * reader's scheduled messages. No server call of its own. Counters of the
 * other non-empty kinds sit on the right; a tap on one switches the line
 * until the chat is left.
 *
 * Order: burning on you → «Отсутствует» (wave 4) → pinned → requests →
 * tasks of the chat → scheduled. The first non-empty kind is shown first.
 */

export type SlotKind =
  | "hot"
  | "away"
  | "pinned"
  | "requests"
  | "tasks"
  | "scheduled";

export const slotKindOrder: readonly SlotKind[] = [
  "hot",
  "away",
  "pinned",
  "requests",
  "tasks",
  "scheduled",
];

export type SlotTone =
  /** Something burns on the reader: the slot is red. */
  | "danger"
  /** A request waits for the reader's answer: yellow, as in wave 1. */
  | "warning"
  /** The reader is responsible for open tasks of the chat. */
  | "accent"
  | "neutral";

export type SlotItem = {
  kind: SlotKind;
  /** The number on the kind's icon. */
  count: number;
  /** The main line: a task title, a pinned text, a request, a scheduled text. */
  title: string;
  /** The small line above it: «На вас · сегодня, 12:00», «Закреплённое 1 из 3». */
  caption: string;
  tone: SlotTone;
  /** The message a tap leads to, when there is one. */
  targetMessageId?: string;
  /** What the target is: a task opens the list, a request scrolls to it. */
  targetType?: "task" | "request" | "pinned";
  /** «tasks»: open tasks of the chat on the reader («N на вас»). */
  mine?: number;
  /** «tasks»: the accent dot on the icon — the reader is on open tasks. */
  dot?: boolean;
  /** The due date the caption speaks about. */
  dueAt?: Date | null;
  /** «hot»: the round «Готово» right in the line, for a task the reader may close. */
  canComplete?: boolean;
  /** «pinned»: which one of how many, for the bars on the left. */
  position?: { index: number; total: number };
};

/** A task row as the slot needs it: listChatTasks(state=open) items. */
export type SlotTaskMessage = Pick<
  Message,
  "id" | "actor_id" | "created_seq"
> & {
  task: MessageTask;
};

/** A pinned message with its text, in the order the client shows them. */
export type SlotPin = { messageID: string; text: string };

/** «Отсутствует», wave 4: the other person of a direct chat is away. */
export type SlotAway = { title: string; caption: string };

export type ChatSlotInput = {
  /** The reader and their role in the chat (for «Готово» in the line). */
  viewer: TaskViewer;
  /** HelloFrame.features: without message_tasks there are no task kinds. */
  features: Iterable<string> | null | undefined;
  locale: CalendarLocale;
  /** Open tasks of the chat; undefined while loading. */
  tasks?: readonly SlotTaskMessage[];
  /** ChatTaskPage.counts: the totals when the page holds only some of them. */
  taskCounts?: ChatTaskCounts | null;
  /** Pinned messages; undefined while loading. */
  pins?: readonly SlotPin[];
  /** Which pinned message the line shows; it moves on every tap. */
  pinIndex?: number;
  /** The chat's line of GET /unread: requests waiting for the reader. */
  unread?: Pick<ChatUnread, "requests_waiting" | "requests_next_due_at">;
  /** Loaded feed messages: where the waiting requests are. */
  messages?: readonly Pick<
    Message,
    "id" | "request" | "created_seq" | "body"
  >[];
  /** The store's request viewers: which requests wait for the reader. */
  requestViewers?: RequestViewers;
  /** pendingSummary(scheduled, chatID); undefined while loading. */
  scheduled?: { count: number; next: ScheduledMessage | null };
  /** Wave 4. */
  away?: SlotAway | null;
};

export type ChatSlot = {
  /** Non-empty kinds in the order of decision 17. */
  items: SlotItem[];
  /** The kind shown first; null when the slot is empty and hidden. */
  initial: SlotKind | null;
  /**
   * Every source the slot depends on is loaded. Until then keep the last
   * known slot of the chat on screen instead of an empty or jumping one.
   */
  complete: boolean;
};

const words = {
  ru: {
    onYou: "На вас",
    overdue: "просрочено",
    reply: "Ждут вашего ответа",
    replyLate: "срок прошёл",
    pinned: "Закреплённое",
    of: "из",
    tasks: "Задачи",
    mineSuffix: "на вас",
    scheduled: "Отложено",
    noTitle: "",
  },
  en: {
    onYou: "On you",
    overdue: "overdue",
    reply: "Waiting for your answer",
    replyLate: "past due",
    pinned: "Pinned",
    of: "of",
    tasks: "Tasks",
    mineSuffix: "on you",
    scheduled: "Scheduled",
    noTitle: "",
  },
} as const;

type WaitingRequest = {
  id: string;
  dueAt: number;
  createdSeq: number;
  body: string;
};

function waitingRequests(input: ChatSlotInput): WaitingRequest[] {
  const viewers = input.requestViewers ?? {};
  const result: WaitingRequest[] = [];
  for (const message of input.messages ?? []) {
    if (message.request?.status !== "open") continue;
    const viewer = viewers[message.id]?.viewer;
    if (viewer?.role !== "recipient" || viewer.answer || !viewer.can_answer)
      continue;
    result.push({
      id: message.id,
      dueAt: message.request.due_at
        ? Date.parse(message.request.due_at)
        : Infinity,
      createdSeq: message.created_seq,
      body: message.body,
    });
  }
  return result.sort(
    (left, right) =>
      left.dueAt - right.dueAt || left.createdSeq - right.createdSeq,
  );
}

/**
 * Builds the slot. Pure: every rule of order, counting and highlighting is
 * here and in its tests.
 */
export function buildChatSlot(input: ChatSlotInput, now: Date): ChatSlot {
  const t = words[input.locale];
  const me = input.viewer.actorID;
  const tasksOn = hasServerFeature(input.features, serverFeature.tasks);
  const due = (at: number) => formatRequestDue(new Date(at), now, input.locale);
  const items: SlotItem[] = [];

  // Burning on the reader: tasks and requests, the earliest due first.
  const tasks = tasksOn
    ? (input.tasks ?? []).filter((message) => isTaskActive(message.task))
    : [];
  const hotTasks = tasks
    .filter(
      (message) => isTaskOnMe(message.task, me) && isTaskHot(message.task, now),
    )
    .sort(compareTasks);
  const requests = waitingRequests(input);
  const hotRequests = requests.filter(
    (request) => request.dueAt - now.getTime() < 24 * 60 * 60_000,
  );
  const waitingTotal = Math.max(0, input.unread?.requests_waiting ?? 0);
  // A burning request outside the loaded feed: GET /unread knows its due date.
  const unseenHotRequest =
    hotRequests.length === 0 &&
    waitingTotal > 0 &&
    isDueHot(input.unread?.requests_next_due_at, now);
  const hotCount =
    hotTasks.length +
    Math.min(hotRequests.length, waitingTotal || hotRequests.length) +
    (unseenHotRequest ? 1 : 0);
  if (hotCount > 0) {
    const task = hotTasks[0];
    const taskDue = task?.task.due_at ? Date.parse(task.task.due_at) : Infinity;
    const request = hotRequests[0];
    if (task && (!request || taskDue <= request.dueAt)) {
      const permissions = taskPermissions(
        task.task,
        task.actor_id,
        input.viewer,
      );
      items.push({
        kind: "hot",
        count: hotCount,
        title: task.task.title,
        caption: `${t.onYou} · ${isTaskOverdue(task.task, now) ? t.overdue : due(taskDue)}`,
        tone: "danger",
        targetMessageId: task.id,
        targetType: "task",
        dueAt: new Date(taskDue),
        canComplete: permissions.complete,
      });
    } else {
      const at = request
        ? request.dueAt
        : Date.parse(input.unread?.requests_next_due_at ?? "");
      items.push({
        kind: "hot",
        count: hotCount,
        title: request ? taskTitleFromMessage(request.body) : t.noTitle,
        caption: `${t.reply} · ${at <= now.getTime() ? t.replyLate : due(at)}`,
        tone: "danger",
        ...(request
          ? { targetMessageId: request.id, targetType: "request" as const }
          : {}),
        dueAt: new Date(at),
        canComplete: false,
      });
    }
  }

  if (input.away)
    items.push({
      kind: "away",
      count: 1,
      title: input.away.title,
      caption: input.away.caption,
      tone: "neutral",
    });

  const pins = input.pins ?? [];
  if (pins.length) {
    const index =
      (((input.pinIndex ?? 0) % pins.length) + pins.length) % pins.length;
    const pin = pins[index]!;
    items.push({
      kind: "pinned",
      count: pins.length,
      title: pin.text,
      caption:
        pins.length > 1
          ? `${t.pinned} ${index + 1} ${t.of} ${pins.length}`
          : t.pinned,
      tone: "neutral",
      targetMessageId: pin.messageID,
      targetType: "pinned",
      position: { index, total: pins.length },
    });
  }

  // Waiting requests without a burning due date.
  const calmTotal = Math.max(
    0,
    waitingTotal - hotRequests.length - (unseenHotRequest ? 1 : 0),
  );
  if (calmTotal > 0) {
    const request = requests.find((entry) => !hotRequests.includes(entry));
    const nextDue = request
      ? request.dueAt
      : input.unread?.requests_next_due_at &&
          !isDueHot(input.unread.requests_next_due_at, now)
        ? Date.parse(input.unread.requests_next_due_at)
        : Infinity;
    items.push({
      kind: "requests",
      count: calmTotal,
      title: request ? taskTitleFromMessage(request.body) : t.noTitle,
      caption: Number.isFinite(nextDue)
        ? `${t.reply} · ${due(nextDue)}`
        : `${t.reply} · ${calmTotal}`,
      tone: "warning",
      ...(request
        ? { targetMessageId: request.id, targetType: "request" as const }
        : {}),
      dueAt: Number.isFinite(nextDue) ? new Date(nextDue) : null,
    });
  }

  if (tasksOn) {
    const open = Math.max(input.taskCounts?.open ?? 0, tasks.length);
    if (open > 0) {
      const mineList = tasks.filter((message) => isTaskOnMe(message.task, me));
      const mine = Math.max(input.taskCounts?.mine ?? 0, mineList.length);
      const first = [...(mineList.length ? mineList : tasks)].sort(
        compareTasks,
      )[0];
      items.push({
        kind: "tasks",
        count: open,
        title: first?.task.title ?? t.noTitle,
        caption: mine
          ? `${t.tasks} · ${open} · ${t.mineSuffix} ${mine}`
          : `${t.tasks} · ${open}`,
        tone: mine ? "accent" : "neutral",
        ...(first
          ? { targetMessageId: first.id, targetType: "task" as const }
          : {}),
        mine,
        dot: mine > 0,
      });
    }
  }

  const scheduled = input.scheduled;
  if (scheduled && scheduled.count > 0) {
    const at = scheduled.next ? Date.parse(scheduled.next.send_at) : NaN;
    items.push({
      kind: "scheduled",
      count: scheduled.count,
      title: scheduled.next ? taskTitleFromMessage(scheduled.next.body) : "",
      caption: Number.isFinite(at)
        ? `${t.scheduled} · ${due(at)}`
        : t.scheduled,
      tone: "neutral",
      dueAt: Number.isFinite(at) ? new Date(at) : null,
    });
  }

  return {
    items,
    initial: items[0]?.kind ?? null,
    complete:
      input.pins !== undefined &&
      input.scheduled !== undefined &&
      (!tasksOn || input.tasks !== undefined),
  };
}

/**
 * The item on screen: the kind the reader tapped while it is still there,
 * else the default one.
 */
export function selectSlotItem(
  slot: ChatSlot,
  chosen: SlotKind | null | undefined,
): SlotItem | null {
  return (
    slot.items.find((item) => item.kind === chosen) ??
    slot.items.find((item) => item.kind === slot.initial) ??
    null
  );
}

/** The icons on the right: at most four, the rest behind «⋯». */
export function slotChips(
  slot: ChatSlot,
  max = 4,
): { chips: SlotItem[]; overflow: SlotItem[] } {
  if (slot.items.length <= 1) return { chips: [], overflow: [] };
  return {
    chips: slot.items.slice(0, max),
    overflow: slot.items.slice(max),
  };
}

/** The next pinned message after a tap on the pinned line. */
export function nextPinIndex(index: number, total: number): number {
  return total > 0 ? (index + 1) % total : 0;
}

// ---------------------------------------------------------------------------
// The task list under the slot (decision 18)

export type ChatTaskRow<T extends SlotTaskMessage = SlotTaskMessage> = {
  message: T;
  hot: boolean;
  overdue: boolean;
  /** The round «Готово» is tappable for this reader. */
  canComplete: boolean;
};

/**
 * «На вас» (red line on the left) above «Остальные», each in the server's
 * order: earliest due first, without a due date newest first. Closed tasks
 * are left out.
 */
export function chatTaskSections<T extends SlotTaskMessage>(
  tasks: readonly T[],
  viewer: TaskViewer,
  now: Date,
): { mine: ChatTaskRow<T>[]; others: ChatTaskRow<T>[] } {
  const mine: ChatTaskRow<T>[] = [];
  const others: ChatTaskRow<T>[] = [];
  for (const message of [...tasks].sort(compareTasks)) {
    if (!isTaskActive(message.task)) continue;
    const row: ChatTaskRow<T> = {
      message,
      hot: isTaskHot(message.task, now),
      overdue: isTaskOverdue(message.task, now),
      canComplete: taskPermissions(message.task, message.actor_id, viewer)
        .complete,
    };
    (isTaskOnMe(message.task, viewer.actorID) ? mine : others).push(row);
  }
  return { mine, others };
}
