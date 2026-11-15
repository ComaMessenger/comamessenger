import { atLocal, type CalendarLocale } from "./calendar";
import {
  activeAway,
  awayKindEmoji,
  awayLine,
  awayTitle,
  isAwayPlanned,
} from "./away";
import { parseInstant } from "./presenceText";
import type { AwayPublic, SetStatusRequest, User } from "./types";

/**
 * The person's own status («Свой статус»: an emoji, a text, until when),
 * shared by the web dialog and the phone sheet (phase 6.7 decision 13: the
 * phone gets it too, with the same presets and expiries as the web). Works
 * with servers without actor_away: PUT/DELETE /api/v1/me/status are older.
 * While an away status is in effect it is shown instead (decision 12).
 */

export const customStatusLimits = { textMaxLength: 100 } as const;

/** «Не сбрасывать», «Через час», «Сегодня», «Через неделю». */
export type CustomStatusExpiry = "none" | "hour" | "today" | "week";

export const customStatusExpiries: readonly CustomStatusExpiry[] = [
  "none",
  "hour",
  "today",
  "week",
];

/** Translation keys of the expiry chips (the web's existing ones). */
export const customStatusExpiryLabelKeys: Record<CustomStatusExpiry, string> = {
  none: "statusNever",
  hour: "statusInHour",
  today: "statusToday",
  week: "statusInWeek",
};

/** When a status set now with this expiry ends; null — never. «Сегодня» is 23:59. */
export function customStatusExpiresAt(
  expiry: CustomStatusExpiry,
  now: Date,
): Date | null {
  switch (expiry) {
    case "hour":
      return new Date(now.getTime() + 60 * 60_000);
    case "today":
      return atLocal(now, 0, 23, 59);
    case "week":
      return new Date(now.getTime() + 7 * 24 * 60 * 60_000);
    case "none":
      return null;
  }
}

export type CustomStatusPreset = {
  emoji: string;
  /** Translation key of the text. */
  labelKey: string;
  /** Translation key of the duration under it. */
  durationKey: string;
  expiry: CustomStatusExpiry;
};

/** The quick statuses of the web dialog, in its order. */
export const customStatusPresets: readonly CustomStatusPreset[] = [
  {
    emoji: "📅",
    labelKey: "statusPresetMeeting",
    durationKey: "statusDurationHour",
    expiry: "hour",
  },
  {
    emoji: "🏠",
    labelKey: "statusPresetRemote",
    durationKey: "statusDurationToday",
    expiry: "today",
  },
  {
    emoji: "🤒",
    labelKey: "statusPresetSick",
    durationKey: "statusDurationWeek",
    expiry: "week",
  },
  {
    emoji: "🏝",
    labelKey: "statusPresetVacation",
    durationKey: "statusDurationCustom",
    expiry: "none",
  },
];

export type CustomStatusDraft = {
  emoji: string;
  text: string;
  expiry: CustomStatusExpiry;
};

/** The form opened on the person's current status; the expiry starts at «никогда». */
export function customStatusDraft(
  user: Pick<User, "status_emoji" | "status_text">,
): CustomStatusDraft {
  return { emoji: user.status_emoji, text: user.status_text, expiry: "none" };
}

export type CustomStatusProblem = { field: "text"; reason: "tooLong" };

export function customStatusProblem(
  draft: CustomStatusDraft,
): CustomStatusProblem | null {
  return [...draft.text.trim()].length > customStatusLimits.textMaxLength
    ? { field: "text", reason: "tooLong" }
    : null;
}

/** The body of setStatus. */
export function toSetStatusInput(
  draft: CustomStatusDraft,
  now: Date,
): SetStatusRequest {
  return {
    emoji: draft.emoji,
    text: draft.text.trim(),
    expires_at: customStatusExpiresAt(draft.expiry, now)?.toISOString() ?? null,
  };
}

type StatusFields = {
  status_emoji?: string;
  status_text?: string;
  status_expires_at?: string | null;
};

/** The custom status set and not expired; null without one. */
export function liveCustomStatus(
  person: StatusFields,
  now: Date,
): { emoji: string; text: string; expiresAt: Date | null } | null {
  const emoji = person.status_emoji ?? "";
  const text = person.status_text ?? "";
  if (!emoji && !text) return null;
  const expires = person.status_expires_at
    ? parseInstant(person.status_expires_at)
    : NaN;
  if (Number.isFinite(expires) && expires <= now.getTime()) return null;
  return {
    emoji,
    text,
    expiresAt: Number.isFinite(expires) ? new Date(expires) : null,
  };
}

/**
 * The status to draw next to someone else: the away status while it is in
 * effect, else the custom one. For other people the server already puts
 * the away status into status_emoji and status_text (for older clients);
 * this keeps the two from being shown twice.
 */
export function shownStatus(
  person: StatusFields & { away?: AwayPublic | null },
  now: Date,
  locale: CalendarLocale,
): { emoji: string; text: string; away: boolean } | null {
  const away = activeAway(person.away, now);
  if (away)
    return {
      emoji: awayKindEmoji[away.kind],
      text: awayTitle(away, now, locale),
      away: true,
    };
  const custom = liveCustomStatus(person, now);
  return custom
    ? { emoji: custom.emoji, text: custom.text, away: false }
    : null;
}

export type MyStatusSummary =
  | { kind: "away"; emoji: string; text: string }
  /** «С 20 по 30 ноября — в отпуске», with the custom status meanwhile. */
  | {
      kind: "planned";
      emoji: string;
      text: string;
      custom: { emoji: string; text: string } | null;
    }
  | { kind: "custom"; emoji: string; text: string }
  | { kind: "none" };

/**
 * The «Статус» row of «Ещё» and the web profile menu: the away status in
 * effect, a planned one, the custom status, or nothing. `getMe` gives the
 * custom status as set even while away is in effect (decision 12).
 */
export function myStatusSummary(
  user: StatusFields & { away?: AwayPublic | null },
  now: Date,
  locale: CalendarLocale,
): MyStatusSummary {
  const away = activeAway(user.away, now);
  if (away)
    return {
      kind: "away",
      emoji: awayKindEmoji[away.kind],
      text: awayTitle(away, now, locale),
    };
  const custom = liveCustomStatus(user, now);
  if (user.away && isAwayPlanned(user.away, now)) {
    const line = awayLine(user.away, now, locale);
    return {
      kind: "planned",
      emoji: awayKindEmoji[user.away.kind],
      text: line ? line[0]!.toLocaleUpperCase() + line.slice(1) : line,
      custom: custom ? { emoji: custom.emoji, text: custom.text } : null,
    };
  }
  if (custom) return { kind: "custom", emoji: custom.emoji, text: custom.text };
  return { kind: "none" };
}

/** Sections of the status sheet: «Отсутствую» only with actor_away. */
export type StatusSheetSection = "away" | "custom";

export function statusSheetSections(awayOn: boolean): StatusSheetSection[] {
  return awayOn ? ["away", "custom"] : ["custom"];
}
