import {
  formatDaySeparator as formatFeedDay,
  formatListTime as formatCompactTime,
} from "@comamessenger/core";
import i18n from "../i18n";

export function activeLocale() {
  return i18n.language === "pseudo" ? "en" : i18n.language;
}

export function formatTime(value: string) {
  return new Intl.DateTimeFormat(activeLocale(), {
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

export function formatDay(value: string) {
  return new Intl.DateTimeFormat(activeLocale(), {
    day: "2-digit",
    month: "2-digit",
  }).format(new Date(value));
}

export function formatLongDate(value: string) {
  return new Intl.DateTimeFormat(activeLocale(), { dateStyle: "long" }).format(
    new Date(value),
  );
}

export function formatDateTime(value: string) {
  return new Intl.DateTimeFormat(activeLocale(), {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

/** Compact time for list rows: today → HH:MM, this week → weekday, else → D MMM. */
export function formatListTime(value: string, now = new Date()) {
  return formatCompactTime(value, activeLocale(), i18n.t("yesterday"), now);
}

export function formatDaySeparator(value: string, now = new Date()) {
  return formatFeedDay(
    value,
    activeLocale(),
    { today: i18n.t("today"), yesterday: i18n.t("yesterday") },
    now,
  );
}

export function minuteGap(a: string, b: string) {
  return (new Date(b).getTime() - new Date(a).getTime()) / 60000;
}

export function formatBytes(value: number) {
  const locale = activeLocale();
  const format = (amount: number, unit: string) =>
    `${new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(amount)} ${unit}`;
  if (value < 1000) return format(value, i18n.t("unitBytes"));
  if (value < 1_000_000) return format(value / 1000, i18n.t("unitKilobytes"));
  if (value < 1_000_000_000)
    return format(value / 1_000_000, i18n.t("unitMegabytes"));
  return format(value / 1_000_000_000, i18n.t("unitGigabytes"));
}

export function greetingKey(now = new Date()) {
  const hour = now.getHours();
  if (hour < 5) return "greetingNight";
  if (hour < 12) return "greetingMorning";
  if (hour < 18) return "greetingDay";
  return "greetingEvening";
}

export function firstName(displayName: string) {
  return displayName.trim().split(/\s+/)[0] ?? displayName;
}

/** "12 min", "1 h", "yesterday", "Mon" — compact age for list rows. */
export function formatAge(value: string, now = new Date()) {
  const minutes = Math.max(0, Math.round((now.getTime() - new Date(value).getTime()) / 60_000));
  if (minutes < 1) return i18n.t("justNow");
  if (minutes < 60) return i18n.t("minutesShort", { count: minutes });
  if (minutes < 24 * 60 && new Date(value).toDateString() === now.toDateString())
    return i18n.t("hoursShort", { count: Math.round(minutes / 60) });
  return formatListTime(value, now);
}

/** "12 min ago", "2 h ago", "yesterday", "Mon" — age as a phrase for sentences. */
export function formatAgePhrase(value: string, now = new Date()) {
  const minutes = Math.max(0, Math.round((now.getTime() - new Date(value).getTime()) / 60_000));
  if (minutes < 1) return i18n.t("justNow");
  if (minutes < 60) return i18n.t("minutesAgo", { count: minutes });
  if (minutes < 24 * 60 && new Date(value).toDateString() === now.toDateString())
    return i18n.t("hoursAgo", { count: Math.round(minutes / 60) });
  return formatListTime(value, now).toLocaleLowerCase();
}
