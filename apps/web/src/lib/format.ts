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
  const date = new Date(value);
  const sameDay = date.toDateString() === now.toDateString();
  if (sameDay) return formatTime(value);
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString())
    return i18n.t("yesterday");
  const days = (now.getTime() - date.getTime()) / 86_400_000;
  if (days < 7)
    return new Intl.DateTimeFormat(activeLocale(), { weekday: "short" }).format(
      date,
    );
  if (date.getFullYear() === now.getFullYear())
    return new Intl.DateTimeFormat(activeLocale(), {
      day: "numeric",
      month: "short",
    }).format(date);
  return new Intl.DateTimeFormat(activeLocale(), {
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(date);
}

export function formatDaySeparator(value: string, now = new Date()) {
  const date = new Date(value);
  if (date.toDateString() === now.toDateString()) return i18n.t("today");
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString())
    return i18n.t("yesterday");
  return new Intl.DateTimeFormat(activeLocale(), {
    day: "numeric",
    month: "long",
    ...(date.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }),
  }).format(date);
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
