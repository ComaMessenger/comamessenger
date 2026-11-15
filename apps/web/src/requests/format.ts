import { useMemo } from "react";
import { useStore } from "zustand";
import {
  capitalize,
  requestErrorKind,
  reminderErrorKind,
  workplaceFeatures,
  type CalendarLocale,
  type RequestErrorKind,
  type ReminderErrorKind,
} from "@comamessenger/core";
import i18n from "../i18n";
import { useMessenger } from "../shell/MessengerContext";

/** The locale of the shared calendar words: today, Fri, 18:00. */
export function calendarLocale(): CalendarLocale {
  return i18n.language === "ru" ? "ru" : "en";
}

export { capitalize };

const requestFailKeys: Record<RequestErrorKind, string> = {
  closed: "requestFailClosed",
  tooLate: "requestFailTooLate",
  archived: "requestFailArchived",
  notMember: "requestFailNotMember",
  audienceEmpty: "requestFailAudienceEmpty",
  tooManyRecipients: "requestFailTooManyRecipients",
  audienceUnavailable: "requestFailAudienceUnavailable",
  limit: "requestFailLimit",
  remindTooSoon: "requestFailRemindTooSoon",
  invalid: "requestFailInvalid",
  conflict: "requestFailConflict",
  gone: "requestFailGone",
  forbidden: "requestFailForbidden",
  rateLimited: "requestFailRateLimited",
  unavailable: "requestFailUnavailable",
  network: "requestFailNetwork",
  other: "requestFailOther",
};

/** Words for a refused request call, for a toast or the form. */
export function requestErrorText(error: unknown): string {
  return i18n.t(requestFailKeys[requestErrorKind(error)]);
}

const reminderFailKeys: Record<ReminderErrorKind, string> = {
  invalid: "reminderFailInvalid",
  limit: "reminderFailLimit",
  gone: "reminderFailGone",
  rateLimited: "reminderFailRateLimited",
  unavailable: "reminderFailUnavailable",
  network: "reminderFailNetwork",
  other: "reminderFailOther",
};

export function reminderErrorText(error: unknown): string {
  return i18n.t(reminderFailKeys[reminderErrorKind(error)]);
}

/** What the server announced in hello: requests and reminders. */
export function useWorkplaceFeatures() {
  const { store } = useMessenger();
  const features = useStore(store, (state) => state.features);
  return useMemo(() => workplaceFeatures(features), [features]);
}
