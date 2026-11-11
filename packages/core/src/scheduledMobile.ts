import { APIError } from "./api";
import type {
  ScheduledMessage,
  ScheduledMessageEvent,
  ScheduledMessageFailureReason,
} from "./types";

/*
 * Scheduled messages as the phone shows them (phase 6.1, package E): the
 * ready-made times of the «Send later» sheet, grouping by day, failure
 * reasons and keeping a list fresh from realtime events. Pure functions over
 * the device clock and time zone, exported as the `scheduledMobile` namespace
 * so they can later be merged with the web helpers without name clashes.
 */

const minuteMs = 60_000;
const dayMs = 24 * 60 * minuteMs;

/** The server refuses a time in the past or further than 365 days ahead. */
export const maxAheadMs = 365 * dayMs;
/** A time closer than this is treated as already gone: the request takes time too. */
export const minLeadMs = minuteMs;

export type ChoiceKey = "inHour" | "tonight" | "tomorrow" | "monday";
export type Choice = { key: ChoiceKey; at: Date };

/** Hours of the ready-made times, on the device clock. */
export const eveningHour = 18;
export const morningHour = 9;

function atLocal(base: Date, dayOffset: number, hour: number): Date {
  // The Date constructor normalizes the day overflow and keeps wall-clock
  // time across daylight saving changes.
  return new Date(
    base.getFullYear(),
    base.getMonth(),
    base.getDate() + dayOffset,
    hour,
    0,
    0,
    0,
  );
}

/**
 * Ready-made times in the order of the sheet. A time that has passed (or is
 * about to) is left out, and «Monday» is dropped on Sunday, when it is the
 * same moment as «tomorrow».
 */
export function choices(now: Date): Choice[] {
  const inHour = new Date(
    Math.ceil((now.getTime() + 60 * minuteMs) / minuteMs) * minuteMs,
  );
  const tonight = atLocal(now, 0, eveningHour);
  const tomorrow = atLocal(now, 1, morningHour);
  const toMonday = (8 - now.getDay()) % 7 || 7;
  const monday = atLocal(now, toMonday, morningHour);
  const all: Choice[] = [
    { key: "inHour", at: inHour },
    { key: "tonight", at: tonight },
    { key: "tomorrow", at: tomorrow },
    { key: "monday", at: monday },
  ];
  return all.filter(
    (choice) =>
      choice.at.getTime() - now.getTime() >= minLeadMs &&
      !(choice.key === "monday" && toMonday === 1),
  );
}

export type SendAtProblem = "past" | "tooFar" | null;

/** Why the server would refuse this time, or null when it is fine. */
export function sendAtProblem(at: Date, now: Date): SendAtProblem {
  const ahead = at.getTime() - now.getTime();
  if (!Number.isFinite(ahead) || ahead < minLeadMs) return "past";
  if (ahead > maxAheadMs) return "tooFar";
  return null;
}

/** Midnight of the local calendar day. */
export function startOfDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

/**
 * Calendar days from today to `at` on the device: 0 today, 1 tomorrow, -1
 * yesterday. Rounded, because a day with a daylight saving change is 23 or
 * 25 hours long.
 */
export function dayDistance(at: Date, now: Date): number {
  return Math.round(
    (startOfDay(at).getTime() - startOfDay(now).getTime()) / dayMs,
  );
}

/** Joins a calendar day and a time of day into one moment on the device. */
export function combine(day: Date, time: Date): Date {
  return new Date(
    day.getFullYear(),
    day.getMonth(),
    day.getDate(),
    time.getHours(),
    time.getMinutes(),
    0,
    0,
  );
}

export const failureReasons: readonly ScheduledMessageFailureReason[] = [
  "author_inactive",
  "security_reset",
  "session_revoked",
  "missed_send_time",
  "chat_unavailable",
  "not_member",
  "forbidden",
  "reference_unavailable",
  "attachment_unavailable",
  "invalid_content",
  "delivery_error",
];

/** A reason from the contract, or "unknown" for anything a newer server adds. */
export function failureReason(
  reason: unknown,
): ScheduledMessageFailureReason | "unknown" {
  return failureReasons.includes(reason as ScheduledMessageFailureReason)
    ? (reason as ScheduledMessageFailureReason)
    : "unknown";
}

export type Section =
  | { kind: "failed"; key: string; items: ScheduledMessage[] }
  | {
      kind: "day";
      key: string;
      day: Date;
      /** Calendar days from today, see dayDistance. */
      distance: number;
      items: ScheduledMessage[];
    };

function sendTime(item: ScheduledMessage): number {
  const time = Date.parse(item.send_at);
  return Number.isFinite(time) ? time : Number.MAX_SAFE_INTEGER;
}

/** By send time, soonest first; ties keep a stable order by id. */
export function sorted(items: readonly ScheduledMessage[]): ScheduledMessage[] {
  return [...items].sort(
    (left, right) =>
      sendTime(left) - sendTime(right) || left.id.localeCompare(right.id),
  );
}

/**
 * The list screen: what failed first (it needs attention), then waiting
 * messages by local calendar day, soonest first. Sent records are left out.
 */
export function sections(
  items: readonly ScheduledMessage[],
  now: Date,
): Section[] {
  const result: Section[] = [];
  const failed = sorted(items.filter((item) => item.status === "failed"));
  if (failed.length)
    result.push({ kind: "failed", key: "failed", items: failed });
  let current = null as Extract<Section, { kind: "day" }> | null;
  for (const item of sorted(
    items.filter((item) => item.status === "pending"),
  )) {
    const at = new Date(sendTime(item));
    const day = startOfDay(Number.isNaN(at.getTime()) ? now : at);
    const key = `day:${day.getFullYear()}-${day.getMonth() + 1}-${day.getDate()}`;
    if (current?.key !== key) {
      current = {
        kind: "day",
        key,
        day,
        distance: dayDistance(day, now),
        items: [],
      };
      result.push(current);
    }
    current.items.push(item);
  }
  return result;
}

export type Summary = {
  /** Waiting and failed records: everything the strip counts. */
  count: number;
  failed: number;
  /** The soonest waiting record. */
  nearest: Date | null;
};

/** What the strip under the chat header says; `chatID` null is every chat. */
export function summary(
  items: readonly ScheduledMessage[],
  chatID: string | null = null,
): Summary {
  const mine = items.filter(
    (item) =>
      (chatID === null || item.chat_id === chatID) &&
      (item.status === "pending" || item.status === "failed"),
  );
  const pending = sorted(mine.filter((item) => item.status === "pending"));
  return {
    count: mine.length,
    failed: mine.length - pending.length,
    nearest: pending[0] ? new Date(sendTime(pending[0])) : null,
  };
}

const eventStatuses = ["pending", "sent", "failed", "deleted"] as const;

/**
 * `data` of a scheduled_message.* event when it has the expected shape.
 * Anything else is ignored rather than trusted: the event log is replayed to
 * new devices and may come from a newer server.
 */
export function parseEvent(data: unknown): ScheduledMessageEvent | null {
  if (!data || typeof data !== "object") return null;
  const value = data as Record<string, unknown>;
  if (
    typeof value.id !== "string" ||
    typeof value.chat_id !== "string" ||
    typeof value.version !== "number" ||
    typeof value.send_at !== "string" ||
    !eventStatuses.includes(value.status as (typeof eventStatuses)[number])
  )
    return null;
  return {
    id: value.id,
    chat_id: value.chat_id,
    status: value.status as ScheduledMessageEvent["status"],
    version: value.version,
    send_at: value.send_at,
    failure_reason:
      value.failure_reason == null
        ? null
        : (failureReason(
            value.failure_reason,
          ) as ScheduledMessageFailureReason),
  };
}

export type ListChange = {
  items: ScheduledMessage[];
  /** Records to read again: an event never carries the text. */
  fetch: string[];
  changed: boolean;
};

/**
 * Applies one realtime event to a loaded list. Events older than what the
 * list holds are dropped by version; a sent or deleted record leaves the
 * list; a new or edited one is fetched, since only the record has the text.
 */
export function applyEvent(
  items: readonly ScheduledMessage[],
  event: ScheduledMessageEvent,
): ListChange {
  const index = items.findIndex((item) => item.id === event.id);
  const existing = index >= 0 ? items[index]! : null;
  if (existing && existing.version >= event.version)
    return { items: [...items], fetch: [], changed: false };
  if (event.status === "sent" || event.status === "deleted")
    return existing
      ? {
          items: items.filter((item) => item.id !== event.id),
          fetch: [],
          changed: true,
        }
      : { items: [...items], fetch: [], changed: false };
  if (!existing)
    return { items: [...items], fetch: [event.id], changed: false };
  const patched: ScheduledMessage = {
    ...existing,
    status: event.status,
    send_at: event.send_at,
    failure_reason: event.failure_reason,
    version: event.version,
  };
  return {
    items: sorted(items.map((item, at) => (at === index ? patched : item))),
    // A failure keeps the text; an edit may have changed it.
    fetch: event.status === "pending" ? [event.id] : [],
    changed: true,
  };
}

/**
 * Puts a record read from the server (or returned by a change) into the
 * list, unless the list already holds a newer version of it.
 */
export function merge(
  items: readonly ScheduledMessage[],
  record: ScheduledMessage,
): ScheduledMessage[] {
  const existing = items.find((item) => item.id === record.id);
  if (existing && existing.version > record.version) return [...items];
  const rest = items.filter((item) => item.id !== record.id);
  return record.status === "sent" ? rest : sorted([...rest, record]);
}

export function remove(
  items: readonly ScheduledMessage[],
  id: string,
): ScheduledMessage[] {
  return items.filter((item) => item.id !== id);
}

export type ErrorKind =
  /** Changed elsewhere meanwhile: reload and look again. */
  | "conflict"
  /** Already sent or failed: it can no longer be changed. */
  | "closed"
  /** Deleted on another device. */
  | "gone"
  | "limit"
  | "tooLarge"
  | "invalid"
  | "forbidden"
  | "rateLimited"
  /** No answer from the server: the request may or may not have arrived. */
  | "network"
  | "other";

export function errorKind(error: unknown): ErrorKind {
  if (!(error instanceof APIError)) return "network";
  switch (error.code) {
    case "version_conflict":
      return "conflict";
    case "scheduled_message_closed":
      return "closed";
    case "scheduled_message_not_found":
      return "gone";
    case "limit_reached":
      return "limit";
    case "payload_too_large":
      return "tooLarge";
    case "validation_failed":
      return "invalid";
    case "rate_limited":
      return "rateLimited";
  }
  if (error.status === 404) return "gone";
  if (error.status === 403) return "forbidden";
  if (error.status === 413) return "tooLarge";
  if (error.status === 422) return "invalid";
  if (error.status === 429) return "rateLimited";
  return "other";
}

/** Everything a request to schedule depends on; equal signatures may reuse one client_msg_id. */
export function requestSignature(request: {
  body: string;
  send_at: string;
  file_ids?: readonly string[];
  reply_to_id?: string;
  thread_root_id?: string;
  silent?: boolean;
}): string {
  return JSON.stringify([
    request.body,
    request.send_at,
    [...(request.file_ids ?? [])].sort(),
    request.reply_to_id ?? null,
    request.thread_root_id ?? null,
    Boolean(request.silent),
  ]);
}
