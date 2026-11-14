import { formatBytes, formatListTime, relativeAge } from "@comamessenger/core";
import i18n from "@/i18n";

/** "только что", "12 мин назад", "вчера", "5 нояб." — age as a phrase. */
export function agePhrase(value: string, now = new Date()) {
  const age = relativeAge(value, now);
  if (age.unit === "now") return i18n.t("kbAgeJustNow");
  if (age.unit === "minutes")
    return i18n.t("kbAgeMinutes", { count: age.count });
  if (age.unit === "hours") return i18n.t("kbAgeHours", { count: age.count });
  return formatListTime(
    value,
    i18n.language,
    i18n.t("yesterday"),
    now,
  ).toLocaleLowerCase();
}

export function bytes(value: number) {
  return formatBytes(value, i18n.language, {
    bytes: i18n.t("unitBytes"),
    kilobytes: i18n.t("unitKilobytes"),
    megabytes: i18n.t("unitMegabytes"),
    gigabytes: i18n.t("unitGigabytes"),
  });
}
