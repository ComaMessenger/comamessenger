import { APIError } from "./api";
import type {
  ScheduledMessage,
  ScheduledMessageEvent,
  ScheduledMessageFailureReason,
} from "./types";

/**
 * Scheduled messages shared by the web and phone clients: the ready-made
 * send times, grouping by day, the human reasons of failures and keeping a
 * list current from realtime events. Times use the device clock and time
 * zone; the server only ever sees UTC instants.
 */

/** A scheduled time must be at least this far ahead to be offered or sent. */
export const scheduleMinimumLeadMs = 60_000;
/** The server refuses times further than 365 days ahead. */
export const scheduleHorizonMs = 365 * 24 * 60 * 60 * 1000;

export type SchedulePresetID =
  | "inHour"
  | "thisEvening"
  | "tomorrowMorning"
  | "nextMonday";

export type SchedulePreset = { id: SchedulePresetID; at: Date };

export const scheduleEveningHour = 18;
export const scheduleMorningHour = 9;

function atLocal(base: Date, dayOffset: number, hour: number): Date {
  // Calendar arithmetic in local time: a day across a daylight saving change
  // is 23 or 25 hours long, and 9:00 stays 9:00.
  const result = new Date(base);
  result.setDate(result.getDate() + dayOffset);
  result.setHours(hour, 0, 0, 0);
  return result;
}

/**
 * Ready-made send times as of now: in an hour, this evening at 18:00,
 * tomorrow at 9:00 and on Monday at 9:00. A time already past or less than a
 * minute away is left out, and so is Monday when it is tomorrow. On a
 * Monday, "Monday" means the next one.
 */
export function schedulePresets(now: Date): SchedulePreset[] {
  const inHour = new Date(now.getTime() + 60 * 60 * 1000);
  inHour.setSeconds(0, 0);
  const daysToMonday = (8 - now.getDay()) % 7 || 7;
  const candidates: SchedulePreset[] = [
    { id: "inHour", at: inHour },
    { id: "thisEvening", at: atLocal(now, 0, scheduleEveningHour) },
    { id: "tomorrowMorning", at: atLocal(now, 1, scheduleMorningHour) },
  ];
  if (daysToMonday > 1)
    candidates.push({
      id: "nextMonday",
      at: atLocal(now, daysToMonday, scheduleMorningHour),
    });
  return candidates.filter((preset) => isSchedulable(preset.at, now));
}

/** True when the time may be sent to the server as send_at. */
export function isSchedulable(at: Date, now: Date): boolean {
  const lead = at.getTime() - now.getTime();
  return (
    Number.isFinite(lead) &&
    lead >= scheduleMinimumLeadMs &&
    lead <= scheduleHorizonMs
  );
}

/** "YYYY-MM-DDTHH:MM" in local time, the value of <input type=datetime-local>. */
export function toLocalInputValue(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** Parses a datetime-local value as local time; null when it is not one. */
export function fromLocalInputValue(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
  if (!match) return null;
  const [, year, month, day, hour, minute] = match.map(Number) as number[];
  const date = new Date(year!, month! - 1, day!, hour!, minute!, 0, 0);
  // new Date() rolls 31.02 over into March and moves a time inside a
  // daylight saving gap; neither is what the person typed.
  if (
    date.getFullYear() !== year ||
    date.getMonth() !== month! - 1 ||
    date.getDate() !== day ||
    date.getHours() !== hour ||
    date.getMinutes() !== minute
  )
    return null;
  return date;
}

export type ScheduledDayKind = "today" | "tomorrow" | "later";

export type ScheduledDayGroup = {
  /** Local calendar day, YYYY-MM-DD. */
  key: string;
  kind: ScheduledDayKind;
  /** Local midnight of that day. */
  day: Date;
  items: ScheduledMessage[];
};

export type ScheduledGroups = {
  /** Not sent, newest failure first. They need the author's attention. */
  failed: ScheduledMessage[];
  /** Waiting, by local day of send_at, soonest first. */
  days: ScheduledDayGroup[];
};

function localDayKey(date: Date): string {
  return toLocalInputValue(date).slice(0, 10);
}

export function scheduledDayKind(at: Date, now: Date): ScheduledDayKind {
  const key = localDayKey(at);
  if (key <= localDayKey(now)) return "today";
  if (key === localDayKey(atLocal(now, 1, 0))) return "tomorrow";
  return "later";
}

/** Splits the author's records into failed ones and days of pending ones. */
export function groupScheduled(
  items: readonly ScheduledMessage[],
  now: Date,
): ScheduledGroups {
  const failed = items
    .filter((item) => item.status === "failed")
    .sort((left, right) =>
      (right.failed_at ?? right.updated_at).localeCompare(
        left.failed_at ?? left.updated_at,
      ),
    );
  const pending = items
    .filter((item) => item.status === "pending")
    .sort(
      (left, right) =>
        Date.parse(left.send_at) - Date.parse(right.send_at) ||
        left.id.localeCompare(right.id),
    );
  const days: ScheduledDayGroup[] = [];
  for (const item of pending) {
    const at = new Date(item.send_at);
    const key = localDayKey(at);
    const last = days.at(-1);
    if (last?.key === key) last.items.push(item);
    else
      days.push({
        key,
        kind: scheduledDayKind(at, now),
        day: atLocal(at, 0, 0),
        items: [item],
      });
  }
  return { failed, days };
}

/** Pending records of one chat, for the strip under the chat header. */
export function pendingSummary(
  items: readonly ScheduledMessage[],
  chatID: string,
): { count: number; next: ScheduledMessage | null } {
  let next: ScheduledMessage | null = null;
  let count = 0;
  for (const item of items) {
    if (item.status !== "pending" || item.chat_id !== chatID) continue;
    count += 1;
    if (!next || Date.parse(item.send_at) < Date.parse(next.send_at))
      next = item;
  }
  return { count, next };
}

/** How many messages a security event would stop: every pending one. */
export function pendingCount(items: readonly ScheduledMessage[]): number {
  return items.filter((item) => item.status === "pending").length;
}

const failureReasons: Record<ScheduledMessageFailureReason, string> = {
  author_inactive: "scheduledReasonAuthorInactive",
  security_reset: "scheduledReasonSecurityReset",
  session_revoked: "scheduledReasonSessionRevoked",
  missed_send_time: "scheduledReasonMissedSendTime",
  chat_unavailable: "scheduledReasonChatUnavailable",
  not_member: "scheduledReasonNotMember",
  forbidden: "scheduledReasonForbidden",
  reference_unavailable: "scheduledReasonReferenceUnavailable",
  attachment_unavailable: "scheduledReasonAttachmentUnavailable",
  invalid_content: "scheduledReasonInvalidContent",
  delivery_error: "scheduledReasonDeliveryError",
};

export const scheduledUnknownReasonKey = "scheduledReasonUnknown";

/**
 * The translation key of a failure reason. Each client keeps the words in
 * its own catalog; the server's push uses the same wording.
 */
export function failureReasonKey(reason: string | null | undefined): string {
  return (
    (reason && failureReasons[reason as ScheduledMessageFailureReason]) ||
    scheduledUnknownReasonKey
  );
}

export const scheduledFailureReasons = Object.keys(
  failureReasons,
) as ScheduledMessageFailureReason[];

export type ScheduledEventType =
  | "scheduled_message.created"
  | "scheduled_message.updated"
  | "scheduled_message.deleted"
  | "scheduled_message.sent"
  | "scheduled_message.failed";

export function isScheduledEvent(type: string): type is ScheduledEventType {
  return type.startsWith("scheduled_message.");
}

export type ScheduledReduction = {
  items: ScheduledMessage[];
  /** Record to read again: the event carries no text. */
  refetch: string | null;
  changed: boolean;
};

/**
 * Applies a realtime event to the list. Sent and deleted records leave the
 * list; other events older than what the list already has are ignored; for
 * the rest the status, time and reason are applied at once and the record
 * must be read again for its content.
 */
export function reduceScheduled(
  items: readonly ScheduledMessage[],
  type: string,
  event: ScheduledMessageEvent,
): ScheduledReduction {
  const index = items.findIndex((item) => item.id === event.id);
  const current = index >= 0 ? items[index]! : null;
  // Sent and deleted are final, whatever the version: a deletion keeps the
  // version of the record it removed.
  if (
    type === "scheduled_message.deleted" ||
    type === "scheduled_message.sent" ||
    event.status === "deleted" ||
    event.status === "sent"
  ) {
    if (!current) return { items: [...items], refetch: null, changed: false };
    return {
      items: items.filter((item) => item.id !== event.id),
      refetch: null,
      changed: true,
    };
  }
  if (current && current.version >= event.version)
    return { items: [...items], refetch: null, changed: false };
  if (!current) return { items: [...items], refetch: event.id, changed: false };
  const next = [...items];
  next[index] = {
    ...current,
    status: event.status,
    send_at: event.send_at,
    failure_reason: event.failure_reason,
  };
  return { items: next, refetch: event.id, changed: true };
}

/** Puts a fresh record in its place, keeping the newer of the two. */
export function upsertScheduled(
  items: readonly ScheduledMessage[],
  record: ScheduledMessage,
): ScheduledMessage[] {
  if (record.status === "sent")
    return items.filter((item) => item.id !== record.id);
  const index = items.findIndex((item) => item.id === record.id);
  if (index < 0) return [...items, record];
  if (items[index]!.version > record.version) return [...items];
  const next = [...items];
  next[index] = record;
  return next;
}

export function removeScheduled(
  items: readonly ScheduledMessage[],
  id: string,
): ScheduledMessage[] {
  return items.filter((item) => item.id !== id);
}

/**
 * The reason a failed message cannot be sent again yet, from the server's
 * 409 scheduled_message_not_retryable; null for any other error.
 */
export function notRetryableReason(cause: unknown): string | null {
  if (
    !(cause instanceof APIError) ||
    cause.code !== "scheduled_message_not_retryable"
  )
    return null;
  const reason = cause.details.reason;
  return typeof reason === "string" ? reason : "";
}
