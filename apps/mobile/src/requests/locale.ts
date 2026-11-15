import type { CalendarLocale } from "@comamessenger/core";

/** The calendar words of @comamessenger/core: Russian unless the app is in English. */
export function calendarLocale(language: string): CalendarLocale {
  return language.startsWith("en") ? "en" : "ru";
}
