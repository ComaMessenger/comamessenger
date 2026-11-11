import {
  APIError,
  failureReasonKey,
  notRetryableReason,
  scheduledDayKind,
  type SchedulePresetID,
} from "@comamessenger/core";
import i18n from "../i18n";
import { activeLocale } from "../lib/format";
import { messageOf } from "../errors";

const presetKeys: Record<SchedulePresetID, string> = {
  inHour: "schedulePresetInHour",
  thisEvening: "schedulePresetThisEvening",
  tomorrowMorning: "schedulePresetTomorrowMorning",
  nextMonday: "schedulePresetNextMonday",
};

export function presetLabel(id: SchedulePresetID) {
  return i18n.t(presetKeys[id]);
}

export function clockTime(date: Date) {
  return new Intl.DateTimeFormat(activeLocale(), {
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

/** "today at 18:00", "tomorrow at 9:00", "Mon, 16 Nov at 9:00". */
export function formatScheduledWhen(value: string | Date, now = new Date()) {
  const date = typeof value === "string" ? new Date(value) : value;
  const time = clockTime(date);
  if (date.toDateString() === now.toDateString())
    return i18n.t("scheduledWhenToday", { time });
  if (scheduledDayKind(date, now) === "tomorrow")
    return i18n.t("scheduledWhenTomorrow", { time });
  return i18n.t("scheduledWhenDate", { date: formatDayName(date, now), time });
}

/** Day heading in the list: weekday and date, with the year when not this one. */
export function formatDayName(date: Date, now = new Date()) {
  return new Intl.DateTimeFormat(activeLocale(), {
    weekday: "short",
    day: "numeric",
    month: "long",
    ...(date.getFullYear() !== now.getFullYear() ? { year: "numeric" } : {}),
  }).format(date);
}

export function reasonText(reason: string | null | undefined) {
  return i18n.t(failureReasonKey(reason));
}

/** The device's time zone, shown next to the custom time. */
export function deviceTimeZone() {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

/** Words for a refusal of a scheduled message request. */
export function scheduledErrorText(cause: unknown) {
  const reason = notRetryableReason(cause);
  if (reason !== null)
    return i18n.t("scheduledNotRetryable", { reason: reasonText(reason) });
  if (cause instanceof APIError) {
    if (cause.code === "limit_reached") return i18n.t("scheduledLimitReached");
    if (
      cause.code === "scheduled_message_closed" ||
      cause.code === "scheduled_message_not_found"
    )
      return i18n.t("scheduledClosed");
  }
  return messageOf(cause);
}
