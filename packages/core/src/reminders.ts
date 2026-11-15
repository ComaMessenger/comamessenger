import { APIError } from "./api";
import {
  atLocal,
  clockTime,
  dayMonth,
  localDayDistance,
  localDayKey,
  weekdayShort,
  type CalendarLocale,
} from "./calendar";
import {
  scheduleEveningHour,
  scheduleMorningHour,
  scheduleProblem,
} from "./scheduled";
import type {
  DurableEvent,
  Reminder,
  ReminderEvent,
  ReminderFiredEvent,
  ReminderIdEntry,
  SetReminderRequest,
} from "./types";

/**
 * Personal reminders («Напомнить мне»): a reminder about a message, with a
 * note, that only its owner sees. Shared by the phone and the web: the times
 * offered, the words for them, the list in «Важные → Напоминания», the bell
 * in the feed and keeping both current from realtime events. Times are the
 * device's local time; the server stores instants.
 */

export const reminderNoteMaxLength = 200;

export type ReminderPresetID =
  | "inHour"
  | "thisEvening"
  | "tomorrowMorning"
  | "nextMonday";

export type ReminderPreset = { id: ReminderPresetID; at: Date };

/** Translation keys of the four ready-made times. */
export const reminderPresetLabelKeys: Record<ReminderPresetID, string> = {
  inHour: "reminderInHour",
  thisEvening: "reminderThisEvening",
  tomorrowMorning: "reminderTomorrowMorning",
  nextMonday: "reminderNextMonday",
};

/** The hour «Своё время» starts with. */
export const reminderDefaultHour = scheduleMorningHour;

export type ReminderProblem = "past" | "tooFar" | "noteTooLong";

/**
 * Why the server would refuse it: a time less than a minute ahead or more
 * than a year ahead, or a note over 200 characters. Null when it is fine.
 */
export function reminderProblem(
  at: Date,
  now: Date,
  note = "",
): ReminderProblem | null {
  if ([...note].length > reminderNoteMaxLength) return "noteTooLong";
  return scheduleProblem(at, now);
}

/**
 * The ready-made times as of now: «Через час», «Сегодня вечером» (18:00,
 * left out when less than an hour is left), «Завтра утром» (9:00) and «В
 * понедельник» (9:00; on a Monday the next one, left out on a Sunday when it
 * is tomorrow morning).
 */
export function reminderPresets(now: Date): ReminderPreset[] {
  const inHour = new Date(now.getTime() + 60 * 60_000);
  inHour.setSeconds(0, 0);
  const evening = atLocal(now, 0, scheduleEveningHour);
  const daysToMonday = (8 - now.getDay()) % 7 || 7;
  const presets: ReminderPreset[] = [{ id: "inHour", at: inHour }];
  if (evening.getTime() - now.getTime() >= 60 * 60_000)
    presets.push({ id: "thisEvening", at: evening });
  presets.push({
    id: "tomorrowMorning",
    at: atLocal(now, 1, scheduleMorningHour),
  });
  if (daysToMonday > 1)
    presets.push({
      id: "nextMonday",
      at: atLocal(now, daysToMonday, scheduleMorningHour),
    });
  return presets.filter((preset) => !reminderProblem(preset.at, now));
}

/**
 * The small line under a ready-made time, as in the prototype: «в 10:41»,
 * «в 18:00», «вс, в 9:00», «16 ноября, 9:00».
 */
export function reminderPresetHint(
  preset: ReminderPreset,
  now: Date,
  locale: CalendarLocale,
): string {
  const time = clockTime(preset.at, locale);
  const at = locale === "ru" ? "в" : "at";
  switch (preset.id) {
    case "inHour":
    case "thisEvening":
      return `${at} ${time}`;
    case "tomorrowMorning":
      return `${weekdayShort(preset.at, locale)}, ${at} ${time}`;
    case "nextMonday":
      return `${dayMonth(preset.at, now, locale)}, ${time}`;
  }
}

/**
 * A reminder time in words: «сегодня в 10:41», «завтра в 9:00», «пн, 16
 * ноября, 9:00». For «Напомнить: …», «Напомню …» and the list; capitalize it
 * at the start of a line.
 */
export function formatReminderWhen(
  at: Date,
  now: Date,
  locale: CalendarLocale,
): string {
  const time = clockTime(at, locale);
  const days = localDayDistance(at, now);
  const ru = locale === "ru";
  if (days === 0) return `${ru ? "сегодня в" : "today at"} ${time}`;
  if (days === 1) return `${ru ? "завтра в" : "tomorrow at"} ${time}`;
  if (days === -1) return `${ru ? "вчера в" : "yesterday at"} ${time}`;
  return `${weekdayShort(at, locale)}, ${dayMonth(at, now, locale)}, ${time}`;
}

/**
 * Days offered under «Своё время» before «Другая дата»: the days after
 * tomorrow, without the Monday a preset already offers.
 */
export function reminderCustomDays(now: Date, count = 3): Date[] {
  const presetDays = new Set(
    reminderPresets(now).map((preset) => localDayKey(preset.at)),
  );
  const days: Date[] = [];
  for (
    let offset = 2;
    days.length < count && offset < 2 + count + 7;
    offset++
  ) {
    const day = atLocal(now, offset, 0);
    if (!presetDays.has(localDayKey(day))) days.push(day);
  }
  return days;
}

/** A day picked under «Своё время» at the chosen local time. */
export function reminderAt(day: Date, hour: number, minute = 0): Date {
  return atLocal(day, 0, hour, minute);
}

/** The body of setMessageReminder / updateReminder. */
export function reminderInput(at: Date, note?: string): SetReminderRequest {
  const input: SetReminderRequest = { remind_at: at.toISOString() };
  if (note !== undefined) input.note = note.trim();
  return input;
}

// ---------------------------------------------------------------------------
// The list in «Важные → Напоминания»

export type ReminderDayKind = "today" | "tomorrow" | "thisWeek" | "later";

export type ReminderDayGroup = {
  /** Local day YYYY-MM-DD, or "later" for everything past a week. */
  key: string;
  kind: ReminderDayKind;
  /** Local midnight of the day (of the first reminder for "later"). */
  day: Date;
  items: Reminder[];
};

export type ReminderGroups = {
  /** «Сработали», latest first. They wait for «Готово» or «Перенести». */
  fired: Reminder[];
  /** «Сегодня», «Завтра», a section per day of this week, then «Позже». */
  days: ReminderDayGroup[];
};

export function reminderDayKind(at: Date, now: Date): ReminderDayKind {
  const days = localDayDistance(at, now);
  if (days <= 0) return "today";
  if (days === 1) return "tomorrow";
  if (days < 7) return "thisWeek";
  return "later";
}

const firedTime = (item: Reminder) =>
  Date.parse(item.fired_at ?? item.remind_at);

/** Splits the reader's reminders into fired ones and days of pending ones. */
export function groupReminders(
  items: readonly Reminder[],
  now: Date,
): ReminderGroups {
  const fired = items
    .filter((item) => item.state === "fired")
    .sort(
      (left, right) =>
        firedTime(right) - firedTime(left) || left.id.localeCompare(right.id),
    );
  const pending = items
    .filter((item) => item.state === "pending")
    .sort(
      (left, right) =>
        Date.parse(left.remind_at) - Date.parse(right.remind_at) ||
        left.id.localeCompare(right.id),
    );
  const days: ReminderDayGroup[] = [];
  for (const item of pending) {
    const at = new Date(item.remind_at);
    const kind = reminderDayKind(at, now);
    const key = kind === "later" ? "later" : localDayKey(at);
    const last = days.at(-1);
    if (last?.key === key) last.items.push(item);
    else days.push({ key, kind, day: atLocal(at, 0, 0), items: [item] });
  }
  return { fired, days };
}

/** «пропущено, должно было в 9:00»: fired more than 15 minutes late. */
export function reminderMissed(item: Pick<Reminder, "state" | "late">) {
  return item.state === "fired" && item.late;
}

/**
 * Where opening a reminder leads: the message, highlighted with the
 * «Напоминание · Готово» strip, or the list when the message is gone. The
 * same addresses as the push.
 */
export function reminderHref(
  item: Pick<Reminder, "id" | "chat_id" | "message_id" | "access">,
): string {
  if (!item.message_id || item.access !== "available")
    return "/important?tab=reminders";
  return `/chat/${item.chat_id}?message=${item.message_id}&reminder=${item.id}`;
}

// ---------------------------------------------------------------------------
// Realtime

export type ReminderEventType =
  | "reminder.created"
  | "reminder.updated"
  | "reminder.deleted"
  | "reminder.fired";

export function isReminderEvent(type: string): type is ReminderEventType {
  return type.startsWith("reminder.");
}

export type ParsedReminderEvent =
  | {
      type: "reminder.created" | "reminder.updated" | "reminder.deleted";
      data: ReminderEvent;
    }
  | { type: "reminder.fired"; data: ReminderFiredEvent };

/**
 * A reminder.* event when its data has the expected shape, null otherwise:
 * the log may come from a newer server, so it is checked, not trusted.
 */
export function parseReminderEvent(
  event: Pick<DurableEvent, "type" | "data">,
): ParsedReminderEvent | null {
  const value = event.data as Record<string, unknown> | null;
  if (!value || typeof value !== "object") return null;
  if (
    typeof value.id !== "string" ||
    typeof value.chat_id !== "string" ||
    typeof value.version !== "number" ||
    !(value.message_id === null || typeof value.message_id === "string")
  )
    return null;
  const base = {
    id: value.id,
    chat_id: value.chat_id,
    message_id: value.message_id as string | null,
    version: value.version,
  };
  if (event.type === "reminder.fired") {
    if (typeof value.fired_at !== "string" || typeof value.late !== "boolean")
      return null;
    return {
      type: event.type,
      data: { ...base, fired_at: value.fired_at, late: value.late },
    };
  }
  if (
    event.type !== "reminder.created" &&
    event.type !== "reminder.updated" &&
    event.type !== "reminder.deleted"
  )
    return null;
  if (
    typeof value.remind_at !== "string" ||
    (value.state !== "pending" && value.state !== "fired")
  )
    return null;
  const data: ReminderEvent = {
    ...base,
    remind_at: value.remind_at,
    state: value.state,
  };
  if (value.reason === "removed" || value.reason === "message_deleted")
    data.reason = value.reason;
  return { type: event.type, data };
}

export type ReminderReduction = {
  items: Reminder[];
  changed: boolean;
  /**
   * The list must be read again: the event is about a reminder it does not
   * have, or one whose note may have changed (events carry no note).
   */
  stale: boolean;
};

/**
 * Applies a reminder event to a list of reminders (either state). Deleted
 * ones leave; others older than the list's version are ignored; the time,
 * state and firing apply at once.
 */
export function reduceReminders(
  items: readonly Reminder[],
  event: ParsedReminderEvent,
): ReminderReduction {
  const index = items.findIndex((item) => item.id === event.data.id);
  const current = index >= 0 ? items[index]! : null;
  if (event.type === "reminder.deleted") {
    if (!current) return { items: [...items], changed: false, stale: false };
    return {
      items: items.filter((item) => item.id !== event.data.id),
      changed: true,
      stale: false,
    };
  }
  if (!current) return { items: [...items], changed: false, stale: true };
  if (current.version >= event.data.version)
    return { items: [...items], changed: false, stale: false };
  const next = [...items];
  if (event.type === "reminder.fired") {
    next[index] = {
      ...current,
      state: "fired",
      fired_at: event.data.fired_at,
      late: event.data.late,
      version: event.data.version,
    };
    return { items: next, changed: true, stale: false };
  }
  const data = event.data;
  next[index] = {
    ...current,
    message_id: data.message_id,
    remind_at: data.remind_at,
    state: data.state,
    fired_at: data.state === "pending" ? null : current.fired_at,
    late: data.state === "pending" ? false : current.late,
    version: data.version,
  };
  // A move from another device may carry a new note.
  return {
    items: next,
    changed: true,
    stale: event.type === "reminder.updated",
  };
}

/** Puts a reminder returned by the server in its place, keeping the newer one. */
export function upsertReminder(
  items: readonly Reminder[],
  record: Reminder,
): Reminder[] {
  const index = items.findIndex((item) => item.id === record.id);
  if (index < 0) return [...items, record];
  if (items[index]!.version > record.version) return [...items];
  const next = [...items];
  next[index] = record;
  return next;
}

/** The bell of one message in the feed, from listReminderIds. */
export function reminderFor(
  entries: readonly ReminderIdEntry[] | undefined,
  messageID: string,
): ReminderIdEntry | null {
  return entries?.find((entry) => entry.message_id === messageID) ?? null;
}

/**
 * The bells of one chat after an event or a local change. Reminders whose
 * message was deleted have no bell.
 */
export function reduceReminderIds(
  entries: readonly ReminderIdEntry[],
  chatID: string,
  event: ParsedReminderEvent,
): ReminderIdEntry[] {
  const { message_id: messageID } = event.data;
  if (event.data.chat_id !== chatID || !messageID) return [...entries];
  const rest = entries.filter((entry) => entry.message_id !== messageID);
  if (event.type === "reminder.deleted") return rest;
  const current = entries.find((entry) => entry.message_id === messageID);
  if (event.type === "reminder.fired")
    return current ? [...rest, { ...current, state: "fired" }] : [...entries];
  return [
    ...rest,
    {
      message_id: messageID,
      remind_at: event.data.remind_at,
      state: event.data.state,
    },
  ];
}

/** The bells after the reader sets or removes a reminder here. */
export function withReminder(
  entries: readonly ReminderIdEntry[] | undefined,
  messageID: string,
  remindAt: string | null,
): ReminderIdEntry[] {
  const rest = (entries ?? []).filter(
    (entry) => entry.message_id !== messageID,
  );
  return remindAt
    ? [
        ...rest,
        { message_id: messageID, remind_at: remindAt, state: "pending" },
      ]
    : rest;
}

/** TanStack Query keys; they always carry the reader's id. */
export const reminderKeys = {
  all: (userID: string) => ["reminders", userID] as const,
  list: (userID: string, state: "pending" | "fired") =>
    ["reminders", userID, "list", state] as const,
  ids: (userID: string, chatID: string) =>
    ["reminders", userID, "ids", chatID] as const,
};

/** The part of a TanStack QueryClient the reminder helpers need. */
export interface ReminderQueryCache {
  setQueryData(
    queryKey: readonly unknown[],
    updater: (
      value: ReminderIdEntry[] | undefined,
    ) => ReminderIdEntry[] | undefined,
  ): unknown;
  invalidateQueries(filters: { queryKey: readonly unknown[] }): unknown;
}

/**
 * Brings cached reminders up to date after a realtime event: the bells of
 * the chat at once, the lists in «Важные» on next view.
 */
export function applyReminderEvent(
  cache: ReminderQueryCache,
  userID: string,
  event: ParsedReminderEvent,
): void {
  cache.setQueryData(reminderKeys.ids(userID, event.data.chat_id), (entries) =>
    entries ? reduceReminderIds(entries, event.data.chat_id, event) : entries,
  );
  void cache.invalidateQueries({ queryKey: ["reminders", userID, "list"] });
}

export type ReminderErrorKind =
  | "invalid"
  | "limit"
  /** The message is not visible, or the reminder is gone. */
  | "gone"
  | "rateLimited"
  /** The server has no reminders yet. */
  | "unavailable"
  | "network"
  | "other";

export function reminderErrorKind(error: unknown): ReminderErrorKind {
  if (!(error instanceof APIError)) return "network";
  switch (error.code) {
    case "reminder_invalid":
    case "validation_failed":
      return "invalid";
    case "reminder_limit_reached":
      return "limit";
    case "reminder_not_found":
    case "message_not_found":
      return "gone";
    case "rate_limited":
      return "rateLimited";
    case "not_implemented":
      return "unavailable";
  }
  if (error.status === 404) return "gone";
  if (error.status === 422) return "invalid";
  if (error.status === 429) return "rateLimited";
  if (error.status === 501) return "unavailable";
  return "other";
}
