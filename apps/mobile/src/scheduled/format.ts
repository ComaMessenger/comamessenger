// Pure formatting of scheduled times on the device clock; the 12/24-hour
// choice comes from the caller so this file stays free of native modules.
// What times may be chosen lives in packages/core (scheduled.ts), shared
// with the web.

const dayMs = 24 * 60 * 60_000;

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

/** Joins a calendar day and a time of day picked apart into one moment. */
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
  const distance = dayDistance(at, now);
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
  const distance = dayDistance(day, now);
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
