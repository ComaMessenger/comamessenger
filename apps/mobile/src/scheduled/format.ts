import { scheduledMobile } from "@comamessenger/core";

// Pure formatting of scheduled times on the device clock; the 12/24-hour
// choice comes from the caller so this file stays free of native modules.

export type Clock = { locale: string; hour12: boolean };

export function formatTime(at: Date, clock: Clock): string {
  return new Intl.DateTimeFormat(clock.locale, {
    hour: "numeric",
    minute: "2-digit",
    hour12: clock.hour12,
  }).format(at);
}

/** «16 ноября» or, in another year, «16 ноября 2027 г.». */
export function formatDate(at: Date, now: Date, clock: Clock): string {
  return new Intl.DateTimeFormat(clock.locale, {
    day: "numeric",
    month: "long",
    ...(at.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }),
  }).format(at);
}

/** «ср», for the small line under «Завтра утром». */
export function formatWeekdayShort(at: Date, clock: Clock): string {
  return new Intl.DateTimeFormat(clock.locale, { weekday: "short" }).format(at);
}

function capitalized(text: string): string {
  return text ? text[0]!.toLocaleUpperCase() + text.slice(1) : text;
}

export type DayWords = { today: string; tomorrow: string };

/**
 * The day of a moment in words: «сегодня», «завтра», otherwise the date.
 * Lower case, to sit inside a phrase; the caller capitalizes headings.
 */
export function formatDay(
  at: Date,
  now: Date,
  clock: Clock,
  words: DayWords,
): string {
  const distance = scheduledMobile.dayDistance(at, now);
  if (distance === 0) return words.today;
  if (distance === 1) return words.tomorrow;
  return formatDate(at, now, clock);
}

/** A day heading of the list: «Сегодня», «Завтра», «Понедельник, 16 ноября». */
export function formatSectionDay(
  day: Date,
  now: Date,
  clock: Clock,
  words: DayWords,
): string {
  const distance = scheduledMobile.dayDistance(day, now);
  if (distance === 0) return capitalized(words.today);
  if (distance === 1) return capitalized(words.tomorrow);
  return capitalized(
    new Intl.DateTimeFormat(clock.locale, {
      weekday: "long",
      day: "numeric",
      month: "long",
      ...(day.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }),
    }).format(day),
  );
}
