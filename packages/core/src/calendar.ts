import type { PresenceLocale } from "./presenceText";

/**
 * Local calendar arithmetic and short date words shared by requests and
 * reminders. Everything runs in the device time zone, which is the person's
 * own after syncDeviceTimezone; the server only ever sees UTC instants.
 *
 * Words are written out rather than taken from Intl: the phone's JS engine
 * does not guarantee locale data.
 */

export type CalendarLocale = PresenceLocale;

/** `base` moved by whole local days and set to hour:minute. */
export function atLocal(
  base: Date,
  dayOffset: number,
  hour: number,
  minute = 0,
): Date {
  // A day across a daylight saving change is 23 or 25 hours long, and 9:00
  // stays 9:00.
  const result = new Date(base);
  result.setDate(result.getDate() + dayOffset);
  result.setHours(hour, minute, 0, 0);
  return result;
}

/** Local calendar day as YYYY-MM-DD. */
export function localDayKey(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Whole local days from now's day to at's day: 0 today, 1 tomorrow, −1 yesterday. */
export function localDayDistance(at: Date, now: Date): number {
  const a = Date.UTC(at.getFullYear(), at.getMonth(), at.getDate());
  const b = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((a - b) / 86_400_000);
}

const ruWeekdays = ["вс", "пн", "вт", "ср", "чт", "пт", "сб"];
const enWeekdays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const ruMonthsGenitive = [
  "января",
  "февраля",
  "марта",
  "апреля",
  "мая",
  "июня",
  "июля",
  "августа",
  "сентября",
  "октября",
  "ноября",
  "декабря",
];
const enMonths = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

/** «пт» / «Fri». */
export function weekdayShort(date: Date, locale: CalendarLocale): string {
  return (locale === "ru" ? ruWeekdays : enWeekdays)[date.getDay()]!;
}

/** «9:00», «18:30» / «9:00 AM». Hours without a leading zero, as in the prototype. */
export function clockTime(date: Date, locale: CalendarLocale): string {
  const minutes = String(date.getMinutes()).padStart(2, "0");
  if (locale === "ru") return `${date.getHours()}:${minutes}`;
  const hours = date.getHours() % 12 || 12;
  return `${hours}:${minutes} ${date.getHours() < 12 ? "AM" : "PM"}`;
}

/** «16 ноября» / «Nov 16», with the year when it is not now's. */
export function dayMonth(
  date: Date,
  now: Date,
  locale: CalendarLocale,
): string {
  const year =
    date.getFullYear() === now.getFullYear() ? "" : ` ${date.getFullYear()}`;
  if (locale === "ru")
    return `${date.getDate()} ${ruMonthsGenitive[date.getMonth()]}${year}`;
  return `${enMonths[date.getMonth()]} ${date.getDate()}${year ? `,${year}` : ""}`;
}

/** First letter in upper case, for a phrase that starts a line or a button. */
export function capitalize(value: string): string {
  return value ? value[0]!.toUpperCase() + value.slice(1) : value;
}
