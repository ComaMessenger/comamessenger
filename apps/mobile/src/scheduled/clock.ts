import { useEffect, useMemo, useState } from "react";
import { getCalendars } from "expo-localization";
import { useTranslation } from "react-i18next";
import type { Clock } from "./format";
import { formatDay, formatTime } from "./format";

/** The device clock: language of the app, 12 or 24 hours as the phone is set. */
export function useClock(): Clock {
  const { i18n } = useTranslation();
  return useMemo(() => {
    let hour12 = false;
    try {
      hour12 = getCalendars()[0]?.uses24hourClock === false;
    } catch {
      hour12 = false;
    }
    return { locale: i18n.language, hour12 };
  }, [i18n.language]);
}

/** Current time, refreshed every `everyMs` so «через час» and «сегодня» stay true. */
export function useNow(everyMs = 30_000, active = true): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    if (!active) return;
    setNow(new Date());
    const timer = setInterval(() => setNow(new Date()), everyMs);
    return () => clearInterval(timer);
  }, [active, everyMs]);
  return now;
}

/** «завтра, 9:00» or, with `at`, «завтра в 9:00». */
export function useWhen() {
  const { t } = useTranslation();
  const clock = useClock();
  return (at: Date, now: Date, style: "comma" | "at" = "comma") => {
    const day = formatDay(at, now, clock, {
      today: t("scheduledToday"),
      tomorrow: t("scheduledTomorrow"),
    });
    const time = formatTime(at, clock);
    return t(style === "at" ? "scheduledDayAtTime" : "scheduledDayTime", {
      day,
      time,
    });
  };
}
