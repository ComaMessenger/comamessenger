import {
  reduceRequest,
  type RequestEvent,
  type RequestViewers,
} from "./requests";
import { hasServerFeature, serverFeature } from "./realtime";
import type {
  ChatUnread,
  Message,
  MessageRequest,
  RequestInboxItem,
  UnreadSnapshot,
} from "./types";

/**
 * «Важные» as the reader's own inbox: requests waiting for their answer
 * («Ждут вас»), saved messages («Сохранённые») and reminders
 * («Напоминания», fired ones first). Nobody else sees any of it. Tabs the
 * server cannot serve yet are hidden.
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
  return importantTabOrder.filter(
    (tab) =>
      tab === "saved" ||
      (tab === "waiting" &&
        hasServerFeature(features, serverFeature.requests)) ||
      (tab === "reminders" &&
        hasServerFeature(features, serverFeature.reminders)),
  );
}

export type ImportantCounts = {
  /** «Ждут вас · n». */
  waiting: number;
  /** «Напоминания · n»: fired and not closed. */
  reminders: number;
  /** The «Важные» tab of the phone's bottom bar. */
  badge: number;
};

/** Counters of the chips and of the bottom tab, from GET /unread. */
export function importantCounts(
  unread: Pick<
    UnreadSnapshot,
    "requests_waiting_total" | "reminders_fired_total"
  >,
  features: Iterable<string> | null | undefined,
): ImportantCounts {
  const waiting = hasServerFeature(features, serverFeature.requests)
    ? Math.max(0, unread.requests_waiting_total ?? 0)
    : 0;
  const reminders = hasServerFeature(features, serverFeature.reminders)
    ? Math.max(0, unread.reminders_fired_total ?? 0)
    : 0;
  return { waiting, reminders, badge: waiting + reminders };
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
