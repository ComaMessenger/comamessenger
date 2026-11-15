import {
  reduceRequest,
  type RequestEvent,
  type RequestViewers,
} from "./requests";
import {
  isPollWaiting,
  mergePollViewer,
  newerPoll,
  reducePoll,
  type PollCacheEntry,
  type PollEvent,
} from "./polls";
import { hasServerFeature, serverFeature } from "./realtime";
import {
  chatTaskBadge,
  isTaskOnMe,
  reduceTask,
  type ChatTaskBadge,
  type TaskEvent,
} from "./tasks";
import type {
  ChatUnread,
  Message,
  MessageRequest,
  MessagePoll,
  MessageTask,
  MyTaskItem,
  PollViewer,
  RequestInboxItem,
  UnreadSnapshot,
  WaitingInboxItem,
} from "./types";

/**
 * «Важные» as the reader's own inbox: what waits for them («Ждут вас»:
 * requests to answer and, with message_tasks, tasks on them; with
 * message_polls also polls with a due date to vote in), saved
 * messages («Сохранённые») and reminders («Напоминания», fired ones
 * first). Nobody else sees any of it. Tabs the server cannot serve yet are
 * hidden.
 */

export type ImportantTab = "waiting" | "saved" | "reminders";

export const importantTabOrder: readonly ImportantTab[] = [
  "waiting",
  "saved",
  "reminders",
];

/** Translation keys of the tab chips. */
export const importantTabLabelKeys: Record<ImportantTab, string> = {
  waiting: "importantWaiting",
  saved: "importantSaved",
  reminders: "importantReminders",
};

/** Tabs in order: «Ждут вас» and «Напоминания» only when the server has them. */
export function importantTabs(
  features: Iterable<string> | null | undefined,
): ImportantTab[] {
  const list = features ? [...features] : [];
  return importantTabOrder.filter(
    (tab) =>
      tab === "saved" ||
      (tab === "waiting" &&
        (hasServerFeature(list, serverFeature.requests) ||
          hasServerFeature(list, serverFeature.tasks) ||
          hasServerFeature(list, serverFeature.polls))) ||
      (tab === "reminders" && hasServerFeature(list, serverFeature.reminders)),
  );
}

export type ImportantCounts = {
  /**
   * «Ждут вас · n»: requests to answer, open tasks on the reader and polls
   * with a due date not voted in.
   */
  waiting: number;
  /** «Напоминания · n»: fired and not closed. */
  reminders: number;
  /**
   * The «Важные» tab of the phone's bottom bar: requests, burning tasks
   * only (a task without a due date must not light it forever), polls due
   * within 24 hours and fired reminders.
   */
  badge: number;
};

/** Counters of the chips and of the bottom tab, from GET /unread. */
export function importantCounts(
  unread: Pick<
    UnreadSnapshot,
    | "requests_waiting_total"
    | "reminders_fired_total"
    | "tasks_mine_open_total"
    | "tasks_mine_hot_total"
    | "polls_waiting_total"
    | "polls_hot_total"
  >,
  features: Iterable<string> | null | undefined,
): ImportantCounts {
  const list = features ? [...features] : [];
  const requests = hasServerFeature(list, serverFeature.requests)
    ? Math.max(0, unread.requests_waiting_total ?? 0)
    : 0;
  const tasks = hasServerFeature(list, serverFeature.tasks);
  const tasksOpen = tasks ? Math.max(0, unread.tasks_mine_open_total ?? 0) : 0;
  const tasksHot = tasks ? Math.max(0, unread.tasks_mine_hot_total ?? 0) : 0;
  const polls = hasServerFeature(list, serverFeature.polls);
  const pollsWaiting = polls ? Math.max(0, unread.polls_waiting_total ?? 0) : 0;
  const pollsHot = polls ? Math.max(0, unread.polls_hot_total ?? 0) : 0;
  const reminders = hasServerFeature(list, serverFeature.reminders)
    ? Math.max(0, unread.reminders_fired_total ?? 0)
    : 0;
  return {
    waiting: requests + tasksOpen + pollsWaiting,
    reminders,
    badge: requests + tasksHot + pollsHot + reminders,
  };
}

/**
 * The tab «Важные» opens with: an explicit one from the address, else «Ждут
 * вас» when something waits, else the one chosen last time, else «Сохранённые».
 */
export function defaultImportantTab(input: {
  tabs: readonly ImportantTab[];
  counts: Pick<ImportantCounts, "waiting">;
  last?: ImportantTab | null;
  requested?: ImportantTab | null;
}): ImportantTab {
  const { tabs } = input;
  if (input.requested && tabs.includes(input.requested)) return input.requested;
  if (input.counts.waiting > 0 && tabs.includes("waiting")) return "waiting";
  if (input.last && tabs.includes(input.last)) return input.last;
  return "saved";
}

/** The tab named in `/important?tab=…`, or null. */
export function parseImportantTab(value: unknown): ImportantTab | null {
  return importantTabOrder.includes(value as ImportantTab)
    ? (value as ImportantTab)
    : null;
}

export function importantHref(tab: ImportantTab): string {
  return `/important?tab=${tab}`;
}

// ---------------------------------------------------------------------------
// «Ждут вас»

export type WaitingSections = {
  /** Mine to answer: with a due date first, earliest on top, then newest. */
  waiting: RequestInboxItem[];
  /** «Отвечено»: open requests I answered, latest answer first. */
  answered: RequestInboxItem[];
};

const dueTime = (item: RequestInboxItem) =>
  item.request.due_at ? Date.parse(item.request.due_at) : Infinity;
const answerVersion = (answer: { version: number } | null | undefined) =>
  answer ? answer.version : 0;
const answeredTime = (item: RequestInboxItem) =>
  item.viewer.answer ? Date.parse(item.viewer.answer.answered_at) : 0;

/**
 * Merges pages of both inbox lists into the two sections. An item may sit in
 * both after an answer from another device; the fresher state wins, an
 * answered item moves to «Отвечено» and a closed one leaves. Viewers from the
 * store override the ones in the pages.
 */
export function waitingSections(
  waiting: readonly RequestInboxItem[],
  answered: readonly RequestInboxItem[],
  viewers: RequestViewers = {},
): WaitingSections {
  const byID = new Map<string, RequestInboxItem>();
  for (const item of [...waiting, ...answered]) {
    const known = byID.get(item.message.id);
    if (
      !known ||
      item.request.version > known.request.version ||
      (item.request.version === known.request.version &&
        answerVersion(item.viewer.answer) > answerVersion(known.viewer.answer))
    )
      byID.set(item.message.id, item);
  }
  const result: WaitingSections = { waiting: [], answered: [] };
  for (const item of byID.values()) {
    const entry = viewers[item.message.id];
    let viewer = item.viewer;
    if (entry && !entry.provisional && entry.version >= item.request.version)
      viewer = entry.viewer;
    const answer =
      answerVersion(entry?.viewer.answer) > answerVersion(viewer.answer)
        ? entry!.viewer.answer
        : viewer.answer;
    const current = { ...item, viewer: { ...viewer, answer } };
    if (current.request.status !== "open") continue;
    if (current.viewer.answer) result.answered.push(current);
    else result.waiting.push(current);
  }
  result.waiting.sort(
    (left, right) =>
      dueTime(left) - dueTime(right) ||
      right.message.created_seq - left.message.created_seq,
  );
  result.answered.sort(
    (left, right) => answeredTime(right) - answeredTime(left),
  );
  return result;
}

export type InboxReduction = {
  items: RequestInboxItem[];
  changed: boolean;
  /** A request the list does not have yet: read the inbox again. */
  stale: boolean;
};

/**
 * Applies a request event to one inbox list. request.assigned means a new
 * item to load; the others update the item in place (an answer moves it to
 * «Отвечено» through waitingSections, a closed request leaves).
 */
export function reduceRequestInbox(
  items: readonly RequestInboxItem[],
  event: RequestEvent,
  now: Date,
): InboxReduction {
  const index = items.findIndex(
    (item) => item.message.id === event.data.message_id,
  );
  if (index < 0)
    return {
      items: [...items],
      changed: false,
      stale: event.type === "request.assigned",
    };
  const item = items[index]!;
  const reduced = reduceRequest(
    {
      request: item.request,
      viewer: {
        viewer: item.viewer,
        version: item.request.version,
        provisional: false,
      },
    },
    event,
    now,
  );
  if (!reduced.changed)
    return { items: [...items], changed: false, stale: reduced.refetch };
  const request = reduced.request ?? item.request;
  const next = [...items];
  if (request.status !== "open") {
    next.splice(index, 1);
    return { items: next, changed: true, stale: false };
  }
  next[index] = {
    ...item,
    request,
    message: { ...item.message, request },
    viewer: reduced.viewer?.viewer ?? item.viewer,
  };
  return { items: next, changed: true, stale: reduced.refetch };
}

// ---------------------------------------------------------------------------
// In the chat list and the chat

export type ChatRequestBadge =
  /** «ответить до пт». */
  | { kind: "due"; at: Date; count: number }
  /** «ждут ответа». */
  | { kind: "waiting"; count: number };

/** The yellow mark on a chat row; null when nothing waits for the reader. */
export function chatRequestBadge(
  chat:
    | Pick<ChatUnread, "requests_waiting" | "requests_next_due_at">
    | undefined,
): ChatRequestBadge | null {
  const count = chat?.requests_waiting ?? 0;
  if (count <= 0) return null;
  const due = chat?.requests_next_due_at
    ? Date.parse(chat.requests_next_due_at)
    : NaN;
  return Number.isFinite(due)
    ? { kind: "due", at: new Date(due), count }
    : { kind: "waiting", count };
}

export type WaitingStrip = {
  count: number;
  /** The earliest due date: «Ждут вашего ответа · до пт, 18:00». */
  dueAt: Date | null;
  /**
   * The loaded message to scroll to: the waiting request with the earliest
   * due date, else the oldest. Null when none of them is loaded yet.
   */
  messageID: string | null;
};

/**
 * The strip under the chat header. Counts come from GET /unread, the target
 * from the loaded feed and the viewer map. It wins over «Отложено».
 */
export function waitingStrip(
  chat:
    | Pick<ChatUnread, "requests_waiting" | "requests_next_due_at">
    | undefined,
  messages: readonly Pick<Message, "id" | "request" | "created_seq">[],
  viewers: RequestViewers,
): WaitingStrip | null {
  const count = chat?.requests_waiting ?? 0;
  if (count <= 0) return null;
  const candidates = messages.filter((message) => {
    const viewer = viewers[message.id]?.viewer;
    return (
      message.request?.status === "open" &&
      viewer?.role === "recipient" &&
      !viewer.answer &&
      viewer.can_answer
    );
  });
  const due = (request: MessageRequest | null | undefined) =>
    request?.due_at ? Date.parse(request.due_at) : Infinity;
  candidates.sort(
    (left, right) =>
      due(left.request) - due(right.request) ||
      left.created_seq - right.created_seq,
  );
  return {
    count,
    dueAt: chat?.requests_next_due_at
      ? new Date(chat.requests_next_due_at)
      : null,
    messageID: candidates[0]?.id ?? null,
  };
}

// ---------------------------------------------------------------------------
// «Ждут вас» with tasks (phase 6.6 wave 3)

/** Chips over «Ждут вас»: «Всё · Запросы · Задачи · Опросы». */
export type WaitingFilter = "all" | "requests" | "tasks" | "polls";

export const waitingFilterLabelKeys: Record<WaitingFilter, string> = {
  all: "importantFilterAll",
  requests: "importantFilterRequests",
  tasks: "importantFilterTasks",
  polls: "importantFilterPolls",
};

/**
 * The chips the server can serve. None before message_tasks: «Ждут вас»
 * is then a list of requests as in wave 1 (listWaitingInbox, which polls
 * need too, came with tasks). «Опросы» joins with message_polls (wave 4).
 */
export function waitingFilters(
  features: Iterable<string> | null | undefined,
): WaitingFilter[] {
  const list = features ? [...features] : [];
  if (!hasServerFeature(list, serverFeature.tasks)) return [];
  const filters: WaitingFilter[] = ["all"];
  if (hasServerFeature(list, serverFeature.requests)) filters.push("requests");
  filters.push("tasks");
  if (hasServerFeature(list, serverFeature.polls)) filters.push("polls");
  return filters;
}

/** «На мне / Поставил(а) я» inside «Задачи». */
export type TaskInboxMode = "assigned" | "authored";

export const taskInboxModeLabelKeys: Record<TaskInboxMode, string> = {
  assigned: "importantTasksMine",
  authored: "importantTasksAuthored",
};

/** One list the «Ждут вас» screen reads; see waitingSources. */
export type WaitingSource =
  /** Servers without message_tasks: listRequestInbox as in wave 1. */
  | { source: "requestInbox"; state: "waiting" | "answered" }
  /** listWaitingInbox: requests, tasks and polls in one order. */
  | { source: "waitingInbox"; kind: "all" | "requests" | "tasks" | "polls" }
  /** listMyTasks: «Поставил(а) я» and «Готово за 7 дней». */
  | {
      source: "myTasks";
      role: "assigned" | "authored";
      state: "open" | "done";
    };

/**
 * What to read for the chosen chip and mode, in the order the rows go.
 * With message_tasks «Ждут вас» reads waitingInbox, otherwise
 * requestInbox(state=waiting) as before; «Отвечено» is always
 * requestInbox(state=answered) (the second entry for «Всё» and «Запросы»).
 * «Задачи» adds the done ones of the last 7 days; «Поставил(а) я» reads
 * the author's tasks.
 */
export function waitingSources(
  features: Iterable<string> | null | undefined,
  filter: WaitingFilter = "all",
  mode: TaskInboxMode = "assigned",
): WaitingSource[] {
  const list = features ? [...features] : [];
  const requests = hasServerFeature(list, serverFeature.requests);
  const answered: WaitingSource[] = requests
    ? [{ source: "requestInbox", state: "answered" }]
    : [];
  if (!hasServerFeature(list, serverFeature.tasks))
    return requests
      ? [{ source: "requestInbox", state: "waiting" }, ...answered]
      : [];
  switch (filter) {
    case "all":
      return [{ source: "waitingInbox", kind: "all" }, ...answered];
    case "requests":
      return [{ source: "waitingInbox", kind: "requests" }, ...answered];
    case "tasks":
      return mode === "assigned"
        ? [
            { source: "waitingInbox", kind: "tasks" },
            { source: "myTasks", role: "assigned", state: "done" },
          ]
        : [
            { source: "myTasks", role: "authored", state: "open" },
            { source: "myTasks", role: "authored", state: "done" },
          ];
    case "polls":
      return hasServerFeature(list, serverFeature.polls)
        ? [{ source: "waitingInbox", kind: "polls" }]
        : [];
  }
}

/** A task row of «Ждут вас» and «Мои задачи», the shape of listMyTasks. */
export type WaitingTaskRow = { kind: "task"; item: MyTaskItem };
export type WaitingRequestRow = { kind: "request"; item: RequestInboxItem };
/** A poll of «Ждут вас»: vote right in the list. */
export type WaitingPollItem = Pick<WaitingInboxItem, "author" | "chat"> & {
  message: Message & { poll: MessagePoll };
  viewer: PollViewer;
};
export type WaitingPollRow = { kind: "poll"; item: WaitingPollItem };
export type WaitingRow = WaitingRequestRow | WaitingTaskRow | WaitingPollRow;

/**
 * A waitingInbox item in the shape the wave 1 rows and the task rows draw:
 * a request as RequestInboxItem, a task as MyTaskItem, a poll with its
 * viewer (from message.poll_viewer). Null for kinds this client does not
 * know or broken items.
 */
export function waitingRow(item: WaitingInboxItem): WaitingRow | null {
  if (item.kind === "request") {
    if (!item.request || !item.viewer) return null;
    return {
      kind: "request",
      item: {
        message: item.message,
        chat_id: item.chat_id,
        author: item.author,
        chat: item.chat,
        request: item.request,
        viewer: item.viewer,
      },
    };
  }
  if (item.kind === "task") {
    if (!item.message.task || !item.my_role) return null;
    return {
      kind: "task",
      item: {
        message: item.message,
        author: item.author,
        chat: item.chat,
        my_role: item.my_role,
      },
    };
  }
  if (item.kind === "poll") {
    const poll = item.message.poll;
    const viewer = item.message.poll_viewer;
    if (!poll || !viewer) return null;
    return {
      kind: "poll",
      item: {
        message: { ...item.message, poll },
        author: item.author,
        chat: item.chat,
        viewer,
      },
    };
  }
  return null;
}

export type WaitingList = {
  /** In the server's order: with a due date first, earliest on top, then newest. */
  waiting: WaitingRow[];
  /** «Отвечено», as waitingSections gives it. */
  answered: RequestInboxItem[];
};

const rowID = (row: WaitingRow) => row.item.message.id;
const rowDue = (row: WaitingRow) => {
  const due =
    row.kind === "request"
      ? row.item.request.due_at
      : row.kind === "poll"
        ? row.item.message.poll.due_at
        : row.item.message.task?.due_at;
  return due ? Date.parse(due) : Infinity;
};

/**
 * «Ждут вас» from waitingInbox pages (and «Отвечено» pages): requests go
 * through waitingSections (answered ones move to «Отвечено», the store's
 * viewers win), tasks are kept while they are on the reader, polls while
 * the reader may vote and has not. `tasks` and `polls` are fresher copies
 * from the store by message id: the newer version wins.
 */
export function waitingList(
  pages: readonly WaitingInboxItem[],
  answered: readonly RequestInboxItem[],
  me: string,
  options: {
    viewers?: RequestViewers;
    tasks?: Readonly<Record<string, MessageTask | null | undefined>>;
    polls?: Readonly<Record<string, PollCacheEntry | null | undefined>>;
  } = {},
): WaitingList {
  const rows = pages
    .map(waitingRow)
    .filter((row): row is WaitingRow => row !== null);
  const requests = waitingSections(
    rows
      .filter((row): row is WaitingRequestRow => row.kind === "request")
      .map((row) => row.item),
    answered,
    options.viewers,
  );
  const tasks = new Map<string, WaitingTaskRow>();
  for (const row of rows) {
    if (row.kind !== "task") continue;
    const known = options.tasks?.[row.item.message.id];
    const message = known
      ? reduceTask(row.item.message, {
          message_id: row.item.message.id,
          task: known,
        })
      : row.item.message;
    const current = { kind: "task" as const, item: { ...row.item, message } };
    const seen = tasks.get(rowID(current));
    if (
      seen &&
      (seen.item.message.task?.version ?? 0) >= (message.task?.version ?? 0)
    )
      continue;
    tasks.set(rowID(current), current);
  }
  const polls = new Map<string, WaitingPollRow>();
  for (const row of rows) {
    if (row.kind !== "poll") continue;
    const current = freshPollRow(row, options.polls?.[rowID(row)]);
    const seen = polls.get(rowID(current));
    if (
      seen &&
      seen.item.message.poll.version >= current.item.message.poll.version
    )
      continue;
    polls.set(rowID(current), current);
  }
  const waiting: WaitingRow[] = [
    ...requests.waiting.map((item) => ({ kind: "request" as const, item })),
    ...[...tasks.values()].filter((row) =>
      row.item.message.task ? isTaskOnMe(row.item.message.task, me) : false,
    ),
    ...[...polls.values()].filter((row) =>
      isPollWaiting(row.item.message.poll, row.item.viewer),
    ),
  ];
  waiting.sort(
    (left, right) =>
      rowDue(left) - rowDue(right) ||
      right.item.message.created_seq - left.item.message.created_seq,
  );
  return { waiting, answered: requests.answered };
}

/** A poll row with the store's fresher poll and viewer put in. */
function freshPollRow(
  row: WaitingPollRow,
  known: PollCacheEntry | null | undefined,
): WaitingPollRow {
  if (!known) return row;
  const poll =
    newerPoll(row.item.message.poll, known.poll) ?? row.item.message.poll;
  const viewer = known.viewer
    ? mergePollViewer(
        { viewer: row.item.viewer, version: row.item.message.poll.version },
        known.viewer.viewer,
        known.viewer.version,
      ).viewer
    : row.item.viewer;
  if (poll === row.item.message.poll && viewer === row.item.viewer) return row;
  return {
    kind: "poll",
    item: { ...row.item, message: { ...row.item.message, poll }, viewer },
  };
}

/** Rows of one chip: «Запросы» keeps requests, «Задачи» tasks, «Опросы» polls. */
export function filterWaitingRows(
  rows: readonly WaitingRow[],
  filter: WaitingFilter,
): WaitingRow[] {
  if (filter === "all") return [...rows];
  if (filter === "requests")
    return rows.filter((row) => row.kind === "request");
  if (filter === "tasks") return rows.filter((row) => row.kind === "task");
  return rows.filter((row) => row.kind === "poll");
}

/** Counters on the chips from the rows loaded. */
export function waitingFilterCounts(
  rows: readonly WaitingRow[],
): Record<WaitingFilter, number> {
  const count = (kind: WaitingRow["kind"]) =>
    rows.filter((row) => row.kind === kind).length;
  return {
    all: rows.length,
    requests: count("request"),
    tasks: count("task"),
    polls: count("poll"),
  };
}

/**
 * Applies a request, task or poll event to waitingInbox items. A task that
 * is no longer on the reader (closed, taken by another candidate,
 * reassigned) leaves; request events go through reduceRequestInbox; a poll
 * leaves once the reader voted (poll.vote.updated from any device) or it
 * closed. `stale` asks to read the list again: something new may be
 * waiting (a reminder about a poll not in the list).
 */
export function reduceWaitingInbox(
  items: readonly WaitingInboxItem[],
  event: RequestEvent | TaskEvent | PollEvent,
  me: string,
  now: Date,
): { items: WaitingInboxItem[]; changed: boolean; stale: boolean } {
  if (
    event.type === "poll.updated" ||
    event.type === "poll.vote.updated" ||
    event.type === "poll.notified"
  )
    return reducePollWaiting(items, event);
  if (event.type === "task.notified")
    return {
      items: [...items],
      changed: false,
      stale:
        event.data.kind === "assigned" ||
        event.data.kind === "offered" ||
        event.data.kind === "item_assigned" ||
        event.data.kind === "reopened",
    };
  if (event.type === "task.updated") {
    const index = items.findIndex(
      (item) => item.message.id === event.data.message_id,
    );
    const onMe = isTaskOnMe(event.data.task, me);
    if (index < 0) return { items: [...items], changed: false, stale: onMe };
    const item = items[index]!;
    const message = reduceTask(item.message, event.data);
    if (message === item.message)
      return { items: [...items], changed: false, stale: false };
    const next = [...items];
    if (!onMe) next.splice(index, 1);
    else
      next[index] = { ...item, message, due_at: message.task?.due_at ?? null };
    return { items: next, changed: true, stale: false };
  }
  const index = items.findIndex(
    (item) => item.message.id === event.data.message_id,
  );
  if (index < 0)
    return {
      items: [...items],
      changed: false,
      stale: event.type === "request.assigned",
    };
  const row = waitingRow(items[index]!);
  if (!row || row.kind !== "request")
    return { items: [...items], changed: false, stale: false };
  const reduced = reduceRequestInbox([row.item], event, now);
  if (!reduced.changed)
    return { items: [...items], changed: false, stale: reduced.stale };
  const next = [...items];
  const updated = reduced.items[0];
  if (!updated) next.splice(index, 1);
  else
    next[index] = {
      ...items[index]!,
      message: updated.message,
      request: updated.request,
      viewer: updated.viewer,
    };
  return { items: next, changed: true, stale: reduced.stale };
}

/** The red task mark wins over the yellow request mark (decision 19). */
export type ChatWorkBadge =
  | { kind: "task"; badge: ChatTaskBadge }
  | { kind: "request"; badge: ChatRequestBadge };

/** The one mark on a chat row: a burning task on the reader, else a request. */
export function chatWorkBadge(
  chat:
    | Pick<
        ChatUnread,
        | "requests_waiting"
        | "requests_next_due_at"
        | "tasks_mine_open"
        | "tasks_mine_next_due_at"
      >
    | undefined,
  now: Date,
): ChatWorkBadge | null {
  const task = chatTaskBadge(chat, now);
  if (task) return { kind: "task", badge: task };
  const request = chatRequestBadge(chat);
  return request ? { kind: "request", badge: request } : null;
}

function reducePollWaiting(
  items: readonly WaitingInboxItem[],
  event: PollEvent,
): { items: WaitingInboxItem[]; changed: boolean; stale: boolean } {
  const index = items.findIndex(
    (item) => item.message.id === event.data.message_id,
  );
  if (index < 0)
    return {
      items: [...items],
      changed: false,
      stale: event.type === "poll.notified" && event.data.kind === "reminded",
    };
  const item = items[index]!;
  const poll = item.message.poll;
  const viewer = item.message.poll_viewer;
  if (!poll || event.type === "poll.notified")
    return { items: [...items], changed: false, stale: false };
  const reduced = reducePoll(
    {
      poll,
      viewer: viewer ? { viewer, version: poll.version } : null,
    },
    event,
  );
  if (!reduced.changed)
    return { items: [...items], changed: false, stale: false };
  const next = [...items];
  if (!isPollWaiting(reduced.poll, reduced.viewer?.viewer)) {
    next.splice(index, 1);
    return { items: next, changed: true, stale: false };
  }
  next[index] = {
    ...item,
    message: {
      ...item.message,
      poll: reduced.poll,
      ...(reduced.viewer ? { poll_viewer: reduced.viewer.viewer } : {}),
    },
  };
  return { items: next, changed: true, stale: false };
}
