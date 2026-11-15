import { APIError } from "./api";
import {
  atLocal,
  capitalize,
  clockTime,
  dayMonth,
  localDayDistance,
  type CalendarLocale,
} from "./calendar";
import { declineRuName, firstName, firstNameIn } from "./names";
import { hasServerFeature, serverFeature } from "./realtime";
import { formatRequestDue } from "./requests";
import type {
  AwayKind,
  AwayPublic,
  AwayStatus,
  DurableEvent,
  Message,
  SetAwayRequest,
  SubstitutingEntry,
} from "./types";

/**
 * «Отсутствую», phase 6.7 wave 4: a person says they are on vacation, at an
 * appointment, on a trip, not to be disturbed or something of their own,
 * until when, who substitutes them, whether to auto-reply in direct chats
 * and to mute push. Shared by the phone and the web: the kinds, the «до»
 * chips in the device's time zone, the form and its checks, the default
 * auto-reply, every line colleagues see («в отпуске до 30 ноября», «Вместо
 * Анны — Марина Соколова», the mention hint), the «Люди» filters and the
 * realtime events.
 *
 * Time decides, not the flag: `AwayPublic.active` is as of the response,
 * clients recheck `starts_at <= now < ends_at` against the clock.
 */

export const awayKinds: readonly AwayKind[] = [
  "vacation",
  "appointment",
  "trip",
  "dnd",
  "other",
];

export const awayKindEmoji: Record<AwayKind, string> = {
  vacation: "🌴",
  appointment: "🩺",
  trip: "🚗",
  dnd: "🔕",
  other: "⏸",
};

/** The server limits, mirrored for the form. */
export const awayLimits = {
  labelMaxLength: 40,
  autoreplyMaxLength: 500,
  /** The start at most 365 days ahead. */
  startHorizonMs: 365 * 24 * 60 * 60_000,
  /** The period at most 180 days long. */
  maxLengthMs: 180 * 24 * 60 * 60_000,
} as const;

/** True when the server announced «Отсутствую» (`actor_away`). */
export function awayAvailable(
  features: Iterable<string> | null | undefined,
): boolean {
  return hasServerFeature(features, serverFeature.away);
}

type AwayTimes = Pick<AwayPublic, "starts_at" | "ends_at">;

// presenceText.parseInstant, repeated so presenceText may import this module.
const instant = (value: string) =>
  Date.parse(value.replace(/(\.\d{3})\d+/, "$1"));

/** In effect now: starts_at <= now < ends_at, by the clock. */
export function isAwayActive(
  away: AwayTimes | null | undefined,
  now: Date,
): boolean {
  if (!away) return false;
  const start = instant(away.starts_at);
  const end = instant(away.ends_at);
  const at = now.getTime();
  return (
    Number.isFinite(start) && Number.isFinite(end) && start <= at && at < end
  );
}

/** Set ahead and not started yet. */
export function isAwayPlanned(
  away: AwayTimes | null | undefined,
  now: Date,
): boolean {
  if (!away) return false;
  const start = instant(away.starts_at);
  return Number.isFinite(start) && start > now.getTime();
}

/** The away status when it is in effect now, else null. */
export function activeAway<T extends AwayTimes>(
  away: T | null | undefined,
  now: Date,
): T | null {
  return away && isAwayActive(away, now) ? away : null;
}

/** When the line should change by itself (start or end), for a timer; null when never. */
export function nextAwayChange(
  away: AwayTimes | null | undefined,
  now: Date,
): Date | null {
  if (!away) return null;
  const at = now.getTime();
  for (const value of [instant(away.starts_at), instant(away.ends_at)])
    if (Number.isFinite(value) && value > at) return new Date(value);
  return null;
}

// ---------------------------------------------------------------------------
// Words

const kindWords: Record<
  CalendarLocale,
  Record<AwayKind, { title: string; state: string }>
> = {
  ru: {
    vacation: { title: "В отпуске", state: "в отпуске" },
    appointment: { title: "На приёме", state: "на приёме" },
    trip: { title: "На выезде", state: "на выезде" },
    dnd: { title: "Не беспокоить", state: "не беспокоить" },
    other: { title: "Другое", state: "" },
  },
  en: {
    vacation: { title: "On vacation", state: "on vacation" },
    appointment: { title: "At an appointment", state: "at an appointment" },
    trip: { title: "On a trip", state: "on a trip" },
    dnd: { title: "Do not disturb", state: "do not disturb" },
    other: { title: "Other", state: "" },
  },
};

/** The tile of the kind: «В отпуске», «Другое». */
export function awayKindTitle(kind: AwayKind, locale: CalendarLocale): string {
  return kindWords[locale][kind].title;
}

const lowerFirst = (value: string) =>
  value ? value[0]!.toLocaleLowerCase() + value.slice(1) : value;

/** «в отпуске»; the own label of «Другое» as typed, first letter lowered. */
export function awayState(
  away: Pick<AwayPublic, "kind" | "label">,
  locale: CalendarLocale,
): string {
  if (away.kind === "other") return lowerFirst(away.label.trim());
  return kindWords[locale][away.kind].state;
}

/** Local midnight: the end of a whole day («до 30 ноября» ends at 1 December 0:00). */
function isMidnight(date: Date): boolean {
  return (
    date.getHours() === 0 && date.getMinutes() === 0 && date.getSeconds() === 0
  );
}

/** The last day a period ending at local midnight covers. */
function inclusiveDay(end: Date): Date {
  return atLocal(end, -1, 12);
}

/**
 * The «до» part, without «до»: «30 ноября» (a period of whole days),
 * «конца дня», «14:00» today, «завтра, 9:00», «20 ноября, 18:00».
 */
export function formatAwayUntil(
  endsAt: Date,
  now: Date,
  locale: CalendarLocale,
): string {
  const ru = locale === "ru";
  if (isMidnight(endsAt)) {
    const day = inclusiveDay(endsAt);
    if (localDayDistance(day, now) === 0)
      return ru ? "конца дня" : "end of day";
    return dayMonth(day, now, locale);
  }
  const days = localDayDistance(endsAt, now);
  if (days === 0) return clockTime(endsAt, locale);
  if (days === 1)
    return `${ru ? "завтра" : "tomorrow"}, ${clockTime(endsAt, locale)}`;
  return `${dayMonth(endsAt, now, locale)}, ${clockTime(endsAt, locale)}`;
}

const until = (locale: CalendarLocale) => (locale === "ru" ? "до" : "until");

/**
 * «с 20 по 30 ноября» for whole days, «с 28 ноября по 3 декабря», else
 * «с завтра, 10:00 до 14:00».
 */
export function formatAwayPeriod(
  away: AwayTimes,
  now: Date,
  locale: CalendarLocale,
): string {
  const start = new Date(instant(away.starts_at));
  const end = new Date(instant(away.ends_at));
  const ru = locale === "ru";
  if (isMidnight(start) && isMidnight(end)) {
    const last = inclusiveDay(end);
    const sameMonth =
      start.getFullYear() === last.getFullYear() &&
      start.getMonth() === last.getMonth();
    const from = sameMonth
      ? String(start.getDate())
      : dayMonth(start, now, locale);
    if (localDayDistance(last, start) === 0)
      return dayMonth(start, now, locale);
    return ru
      ? `с ${from} по ${dayMonth(last, now, locale)}`
      : `${from}–${dayMonth(last, now, locale)}`;
  }
  const from = formatRequestDue(start, now, locale);
  return ru
    ? `с ${from} до ${formatAwayUntil(end, start, locale)}`
    : `from ${from} until ${formatAwayUntil(end, start, locale)}`;
}

/**
 * The line colleagues see: «в отпуске до 30 ноября», «на приёме до 14:00»,
 * «нет на месте до конца дня». A planned one: «с 20 по 30 ноября — в
 * отпуске». Empty when there is none or it is over.
 */
export function awayLine(
  away:
    | Pick<AwayPublic, "kind" | "label" | "starts_at" | "ends_at">
    | null
    | undefined,
  now: Date,
  locale: CalendarLocale,
): string {
  if (!away) return "";
  const end = new Date(instant(away.ends_at));
  if (!Number.isFinite(end.getTime()) || end.getTime() <= now.getTime())
    return "";
  const state = awayState(away, locale);
  if (isAwayPlanned(away, now))
    return `${formatAwayPeriod(away, now, locale)} — ${state}`;
  return `${state} ${until(locale)} ${formatAwayUntil(end, now, locale)}`;
}

/** «В отпуске до 30 ноября», as a line of its own (the server's status_text). */
export function awayTitle(
  away:
    | Pick<AwayPublic, "kind" | "label" | "starts_at" | "ends_at">
    | null
    | undefined,
  now: Date,
  locale: CalendarLocale,
): string {
  return capitalize(awayLine(away, now, locale));
}

/** «🌴 в отпуске до 30 ноября» in the header of a direct chat. */
export function awayHeaderText(
  away: Pick<AwayPublic, "kind" | "label" | "starts_at" | "ends_at">,
  now: Date,
  locale: CalendarLocale,
): string {
  const line = awayLine(away, now, locale);
  return line ? `${awayKindEmoji[away.kind]} ${line}` : "";
}

// ---------------------------------------------------------------------------
// «До» chips

export type AwayPresetID =
  | "weekEnd"
  | "twoWeeks"
  | "at13"
  | "at14"
  | "at16"
  | "at18"
  | "endOfDay"
  | "tomorrow"
  | "hour"
  | "tomorrow9";

export type AwayPreset = {
  id: AwayPresetID;
  at: Date;
  /** «20 ноября», «14:00», «конец дня», «завтра», «1 час», «завтра 9:00». */
  label: string;
};

const presetIDs: Record<AwayKind, readonly AwayPresetID[]> = {
  vacation: ["weekEnd", "twoWeeks"],
  appointment: ["at14", "at16", "endOfDay"],
  trip: ["at13", "at18", "tomorrow"],
  dnd: ["hour", "at18", "tomorrow9"],
  other: ["hour", "endOfDay", "tomorrow9"],
};

/** The end of a chosen day: «до 30 ноября» is up to 1 December 0:00 local. */
export function awayEndOfDay(day: Date): Date {
  return atLocal(day, 1, 0);
}

/** The start of a chosen day, for «С» another date. */
export function awayStartOfDay(day: Date): Date {
  return atLocal(day, 0, 0);
}

function presetAt(id: AwayPresetID, base: Date): Date {
  switch (id) {
    case "weekEnd": {
      // The nearest Sunday after today, inclusive.
      const toSunday = (7 - base.getDay()) % 7 || 7;
      return atLocal(base, toSunday + 1, 0);
    }
    case "twoWeeks":
      return atLocal(base, 14, 0);
    case "at13":
      return atLocal(base, 0, 13);
    case "at14":
      return atLocal(base, 0, 14);
    case "at16":
      return atLocal(base, 0, 16);
    case "at18":
      return atLocal(base, 0, 18);
    case "endOfDay":
      return atLocal(base, 1, 0);
    case "tomorrow":
      return atLocal(base, 2, 0);
    case "hour":
      return new Date(base.getTime() + 60 * 60_000);
    case "tomorrow9":
      return atLocal(base, 1, 9);
  }
}

function presetLabel(
  id: AwayPresetID,
  at: Date,
  base: Date,
  locale: CalendarLocale,
): string {
  const ru = locale === "ru";
  switch (id) {
    case "weekEnd":
    case "twoWeeks":
      return dayMonth(inclusiveDay(at), base, locale);
    case "endOfDay":
      return ru ? "конец дня" : "end of day";
    case "tomorrow":
      return ru ? "завтра" : "tomorrow";
    case "hour":
      return ru ? "1 час" : "1 hour";
    case "tomorrow9":
      return `${ru ? "завтра" : "tomorrow"} ${clockTime(at, locale)}`;
    default:
      return clockTime(at, locale);
  }
}

/**
 * The «до» chips of a kind (decision 3) in the device's time zone, counted
 * from the start (`startsAt`, or now): a vacation — the coming Sunday and
 * two weeks, whole days; an appointment — 14:00, 16:00, the end of the day;
 * a trip — 13:00, 18:00, tomorrow (the whole day); «не беспокоить» and
 * «Другое» — an hour, 18:00 or the end of the day, tomorrow 9:00. A time
 * that has passed is left out. «Другая дата» is the form's own.
 */
export function awayPresets(
  kind: AwayKind,
  now: Date,
  options: { startsAt?: Date | null; locale?: CalendarLocale } = {},
): AwayPreset[] {
  const base =
    options.startsAt && options.startsAt.getTime() > now.getTime()
      ? options.startsAt
      : now;
  const locale = options.locale ?? "ru";
  return presetIDs[kind]
    .map((id) => {
      const at = presetAt(id, base);
      return { id, at, label: presetLabel(id, at, base, locale) };
    })
    .filter(
      (preset) =>
        preset.at.getTime() > base.getTime() &&
        preset.at.getTime() - base.getTime() <= awayLimits.maxLengthMs,
    );
}

// ---------------------------------------------------------------------------
// The form

export type AwayDraft = {
  kind: AwayKind;
  /** The own text of «Другое», up to 40 characters. */
  label: string;
  /** «С»: null — now. */
  startsAt: Date | null;
  /** «До»: required. */
  endsAt: Date | null;
  /** The chip «до» was set with; null — «Другая дата» or nothing yet. */
  endsPreset: AwayPresetID | null;
  autoreplyEnabled: boolean;
  autoreplyText: string;
  /** The person typed the text: the default no longer follows the fields. */
  autoreplyEdited: boolean;
  substituteID: string | null;
  /** «Не присылать уведомления». */
  mutePush: boolean;
  /** AwayStatus.version the form was opened at; null for a new status. */
  expectedVersion: number | null;
};

/**
 * The switches a kind starts with (decision 4 and 7): the auto-reply on for
 * a vacation and a trip, push muted for a vacation and «не беспокоить».
 */
export function awayKindDefaults(
  kind: AwayKind,
): Pick<AwayDraft, "autoreplyEnabled" | "mutePush"> {
  return {
    autoreplyEnabled: kind === "vacation" || kind === "trip",
    mutePush: kind === "vacation" || kind === "dnd",
  };
}

/** A fresh form of a kind; «до» is the kind's first chip. */
export function emptyAwayDraft(
  now: Date,
  kind: AwayKind = "vacation",
): AwayDraft {
  const first = awayPresets(kind, now)[0] ?? null;
  return {
    kind,
    label: "",
    startsAt: null,
    endsAt: first?.at ?? null,
    endsPreset: first?.id ?? null,
    autoreplyText: "",
    autoreplyEdited: false,
    substituteID: null,
    expectedVersion: null,
    ...awayKindDefaults(kind),
  };
}

/**
 * Another kind tile: its switches and its first «до» chip. The substitute,
 * the start, the label and a typed auto-reply stay.
 */
export function withAwayKind(
  draft: AwayDraft,
  kind: AwayKind,
  now: Date,
): AwayDraft {
  if (draft.kind === kind) return draft;
  const first = awayPresets(kind, now, { startsAt: draft.startsAt })[0] ?? null;
  return {
    ...draft,
    kind,
    endsAt: first?.at ?? null,
    endsPreset: first?.id ?? null,
    ...awayKindDefaults(kind),
  };
}

/** A chip of «до» was tapped. */
export function withAwayPreset(
  draft: AwayDraft,
  preset: AwayPreset,
): AwayDraft {
  return { ...draft, endsAt: preset.at, endsPreset: preset.id };
}

/** The form opened on a saved status. */
export function awayDraftFromStatus(status: AwayStatus): AwayDraft {
  return {
    kind: status.kind,
    label: status.label,
    startsAt: new Date(instant(status.starts_at)),
    endsAt: new Date(instant(status.ends_at)),
    endsPreset: null,
    autoreplyEnabled: status.autoreply.enabled,
    autoreplyText: status.autoreply.text,
    autoreplyEdited: true,
    substituteID: status.substitute_id,
    mutePush: status.mute_push,
    expectedVersion: status.version,
  };
}

/** A name in the dative for «к Марине Соколовой»; null when not certain. */
function toWhom(name: string, locale: CalendarLocale): string | null {
  if (locale !== "ru") return name;
  return declineRuName(name, "dative");
}

/**
 * The auto-reply the client offers (decision 4): «Я в отпуске до 30
 * ноября. По срочным вопросам — к Марине Соколовой». The «до» part is
 * counted from the start, so a planned status reads right when it is sent.
 */
export function defaultAutoreply(
  input: {
    kind: AwayKind;
    label?: string;
    startsAt?: Date | null;
    endsAt: Date;
    /** The substitute's display name. */
    substitute?: string | null;
  },
  now: Date,
  locale: CalendarLocale,
): string {
  const ru = locale === "ru";
  const from =
    input.startsAt && input.startsAt.getTime() > now.getTime()
      ? input.startsAt
      : now;
  const when = `${until(locale)} ${formatAwayUntil(input.endsAt, from, locale)}`;
  let first: string;
  if (ru)
    switch (input.kind) {
      case "vacation":
        first = `Я в отпуске ${when}.`;
        break;
      case "appointment":
        first = `Я на приёме ${when}, отвечу после.`;
        break;
      case "trip":
        first = `Я на выезде ${when}, отвечу после.`;
        break;
      case "dnd":
        first = `Не беспокоить ${when} — отвечу позже.`;
        break;
      case "other":
        first = `${capitalize((input.label ?? "").trim()) || "Нет на месте"} ${when}, отвечу позже.`;
        break;
    }
  else
    switch (input.kind) {
      case "vacation":
        first = `I'm on vacation ${when}.`;
        break;
      case "appointment":
        first = `I'm at an appointment ${when}, will reply after.`;
        break;
      case "trip":
        first = `I'm on a trip ${when}, will reply after.`;
        break;
      case "dnd":
        first = `Do not disturb ${when} — I'll reply later.`;
        break;
      case "other":
        first = `${capitalize((input.label ?? "").trim()) || "Away"} ${when}, I'll reply later.`;
        break;
    }
  const substitute = input.substitute?.trim();
  if (!substitute) {
    if (input.kind === "vacation")
      return ru
        ? `${first.slice(0, -1)}, отвечу после возвращения.`
        : `${first.slice(0, -1)}, I'll reply when I'm back.`;
    return first;
  }
  if (!ru) return `${first} For urgent questions, contact ${substitute}.`;
  const dative = toWhom(substitute, locale);
  return dative
    ? `${first} По срочным вопросам — к ${dative}.`
    : `${first} По срочным вопросам пишите: ${substitute}.`;
}

/**
 * The draft with the default auto-reply filled in while the person has not
 * typed their own: call it after every change of the kind, the dates or the
 * substitute.
 */
export function withDefaultAutoreply(
  draft: AwayDraft,
  substituteName: string | null,
  now: Date,
  locale: CalendarLocale,
): AwayDraft {
  if (draft.autoreplyEdited || !draft.endsAt) return draft;
  const text = defaultAutoreply(
    {
      kind: draft.kind,
      label: draft.label,
      startsAt: draft.startsAt,
      endsAt: draft.endsAt,
      substitute: substituteName,
    },
    now,
    locale,
  );
  return text === draft.autoreplyText
    ? draft
    : { ...draft, autoreplyText: text };
}

export type AwayDraftProblem =
  | { field: "label"; reason: "empty" | "tooLong" }
  | { field: "endsAt"; reason: "empty" | "beforeStart" | "tooLong" }
  | { field: "startsAt"; reason: "tooFar" }
  | { field: "autoreply"; reason: "empty" | "tooLong" }
  | { field: "substitute"; reason: "self" };

/** The start that will be sent: null — now (also when the chosen one has passed). */
function effectiveStart(draft: Pick<AwayDraft, "startsAt">, now: Date): Date {
  return draft.startsAt && draft.startsAt.getTime() > now.getTime()
    ? draft.startsAt
    : now;
}

/**
 * The first reason the form cannot be saved, in the order of its fields;
 * null when it can. The server's rules: the label of «Другое» 1–40
 * characters, «до» after «с» and at most 180 days later, «с» at most 365
 * days ahead, an enabled auto-reply 1–500 characters, not oneself as the
 * substitute.
 */
export function awayDraftProblem(
  draft: AwayDraft,
  now: Date,
  selfID?: string,
): AwayDraftProblem | null {
  if (draft.kind === "other") {
    const label = draft.label.trim();
    if (!label) return { field: "label", reason: "empty" };
    if ([...label].length > awayLimits.labelMaxLength)
      return { field: "label", reason: "tooLong" };
  }
  const start = effectiveStart(draft, now);
  if (start.getTime() - now.getTime() > awayLimits.startHorizonMs)
    return { field: "startsAt", reason: "tooFar" };
  if (!draft.endsAt) return { field: "endsAt", reason: "empty" };
  if (draft.endsAt.getTime() <= start.getTime())
    return { field: "endsAt", reason: "beforeStart" };
  if (draft.endsAt.getTime() - start.getTime() > awayLimits.maxLengthMs)
    return { field: "endsAt", reason: "tooLong" };
  if (draft.autoreplyEnabled) {
    const text = draft.autoreplyText.trim();
    if (!text) return { field: "autoreply", reason: "empty" };
    if ([...text].length > awayLimits.autoreplyMaxLength)
      return { field: "autoreply", reason: "tooLong" };
  }
  if (selfID && draft.substituteID === selfID)
    return { field: "substitute", reason: "self" };
  return null;
}

/**
 * The body of setAway. «С» is sent only when it is ahead (the server takes
 * absent as now); a disabled auto-reply keeps its text for next time.
 */
export function toSetAwayInput(draft: AwayDraft, now: Date): SetAwayRequest {
  const start = draft.startsAt;
  return {
    kind: draft.kind,
    ...(draft.kind === "other" ? { label: draft.label.trim() } : {}),
    ...(start && start.getTime() > now.getTime()
      ? { starts_at: start.toISOString() }
      : {}),
    ends_at: (draft.endsAt ?? now).toISOString(),
    autoreply: {
      enabled: draft.autoreplyEnabled,
      text: draft.autoreplyText.trim(),
    },
    substitute_id: draft.substituteID,
    mute_push: draft.mutePush,
    ...(draft.expectedVersion !== null
      ? { expected_version: draft.expectedVersion }
      : {}),
  };
}

// ---------------------------------------------------------------------------
// What colleagues see

/** Who may be shown as the substitute: someone known, active and not away. */
export type AwayPerson = {
  actor_id: string;
  display_name: string;
  type?: "user" | "agent";
  away?: AwayPublic | null;
  /** Deactivated people are never shown as substitutes. */
  deactivated?: boolean;
};

/**
 * The substitute to show (decision 5): the server already hides one who is
 * deactivated or away; the client checks again with what it knows now
 * (fresher away events). Null without one.
 */
export function visibleSubstitute<T extends AwayPerson>(
  away: Pick<AwayPublic, "substitute_id"> | null | undefined,
  lookup: (actorID: string) => T | null | undefined,
  now: Date,
): T | null {
  const id = away?.substitute_id;
  if (!id) return null;
  const person = lookup(id);
  if (!person || person.deactivated || person.type === "agent") return null;
  if (isAwayActive(person.away, now)) return null;
  return person;
}

/** The kind's mark instead of the green dot on an avatar (decision 9). */
export type AvatarBadge =
  | { kind: "away"; awayKind: AwayKind; emoji: string }
  | { kind: "online" }
  | null;

export function avatarBadge(
  presence: "online" | "away" | "offline" | null | undefined,
  away: AwayPublic | null | undefined,
  now: Date,
): AvatarBadge {
  const current = activeAway(away, now);
  if (current)
    return {
      kind: "away",
      awayKind: current.kind,
      emoji: awayKindEmoji[current.kind],
    };
  return presence === "online" ? { kind: "online" } : null;
}

/** The slot line of a direct chat with someone away (decision 10). */
export type AwaySlotLine = {
  title: string;
  caption: string;
  emoji: string;
  /** A tap opens the direct chat with the substitute. */
  substituteID: string | null;
};

/**
 * «Вместо Анны — Марина Соколова» under «Анна в отпуске до 30 ноября», or
 * only «Анна в отпуске до 30 ноября» without a substitute. Null when the
 * peer is not away now or is an agent.
 */
export function awaySlot(
  peer: AwayPerson,
  substitute: Pick<AwayPerson, "actor_id" | "display_name"> | null,
  now: Date,
  locale: CalendarLocale,
): AwaySlotLine | null {
  if (peer.type === "agent") return null;
  const away = activeAway(peer.away, now);
  if (!away) return null;
  const sentence = awaySentence(peer.display_name, away, now, locale);
  const emoji = awayKindEmoji[away.kind];
  if (!substitute)
    return {
      title: sentence,
      caption: locale === "ru" ? "Отсутствует" : "Away",
      emoji,
      substituteID: null,
    };
  const name = firstName(peer.display_name);
  const title =
    locale === "ru"
      ? declineRuName(name, "genitive")
        ? `Вместо ${declineRuName(name, "genitive")} — ${substitute.display_name}`
        : `Замещает: ${substitute.display_name}`
      : `Instead of ${name} — ${substitute.display_name}`;
  return { title, caption: sentence, emoji, substituteID: substitute.actor_id };
}

/**
 * «Анна в отпуске до 30 ноября», «Анна просит не беспокоить до 18:00»,
 * «Анна: нет на месте до 14:00». Only the first name is used.
 */
export function awaySentence(
  name: string,
  away: Pick<AwayPublic, "kind" | "label" | "starts_at" | "ends_at">,
  now: Date,
  locale: CalendarLocale,
): string {
  const who = firstName(name);
  const end = new Date(instant(away.ends_at));
  const when = `${until(locale)} ${formatAwayUntil(end, now, locale)}`;
  const ru = locale === "ru";
  switch (away.kind) {
    case "dnd":
      return ru
        ? `${who} просит не беспокоить ${when}`
        : `${who} asked not to be disturbed ${when}`;
    case "other":
      return `${who}: ${awayState(away, locale)} ${when}`;
    default:
      return ru
        ? `${who} ${awayState(away, locale)} ${when}`
        : `${who} is ${awayState(away, locale)} ${when}`;
  }
}

export type MentionAwayHint = {
  actorID: string;
  /** «Анна в отпуске до 30 ноября — ответит позже» / «… — уведомление не придёт». */
  text: string;
  /** Push is off: the mention will not reach the person now. */
  notificationsOff: boolean;
  /** «Упомянуть Марину», when someone substitutes. */
  substitute: { actorID: string; label: string; name: string } | null;
};

/**
 * The line over the composer once someone away is mentioned (decision 8),
 * and the quiet «видно только вам» line under the sent message. Null when
 * the person is not away now.
 */
export function mentionAwayHint(
  person: AwayPerson,
  substitute: Pick<AwayPerson, "actor_id" | "display_name"> | null,
  now: Date,
  locale: CalendarLocale,
): MentionAwayHint | null {
  if (person.type === "agent") return null;
  const away = activeAway(person.away, now);
  if (!away) return null;
  const ru = locale === "ru";
  const tail = away.notifications_off
    ? ru
      ? "уведомление не придёт"
      : "won't be notified"
    : ru
      ? "ответит позже"
      : "will reply later";
  return {
    actorID: person.actor_id,
    text: `${awaySentence(person.display_name, away, now, locale)} — ${tail}`,
    notificationsOff: away.notifications_off,
    substitute: substitute
      ? {
          actorID: substitute.actor_id,
          name: substitute.display_name,
          label: ru
            ? `Упомянуть ${firstNameIn(substitute.display_name, "accusative")}`
            : `Mention ${firstName(substitute.display_name)}`,
        }
      : null,
  };
}

/**
 * The mark next to a person in the @ menu and in pickers: «в отпуске до 30
 * ноября». Null when they are not away now.
 */
export function awayNote(
  person: Pick<AwayPerson, "away" | "type">,
  now: Date,
  locale: CalendarLocale,
): string | null {
  if (person.type === "agent") return null;
  const away = activeAway(person.away, now);
  return away ? awayLine(away, now, locale) : null;
}

export type AwayPickerHint = {
  /** «в отпуске до 30 ноября · замещает Марина». */
  text: string;
  /** «Выбрать Марину». */
  choose: { actorID: string; label: string } | null;
};

/**
 * The hint next to someone away when choosing a task's responsible person
 * or a request's recipients (decision 6): nothing is redirected by itself,
 * the author chooses.
 */
export function awayPickerHint(
  person: AwayPerson,
  substitute: Pick<AwayPerson, "actor_id" | "display_name"> | null,
  now: Date,
  locale: CalendarLocale,
): AwayPickerHint | null {
  const line = awayNote(person, now, locale);
  if (!line) return null;
  const ru = locale === "ru";
  if (!substitute) return { text: line, choose: null };
  const name = firstName(substitute.display_name);
  return {
    text: `${line} · ${ru ? "замещает" : "substitute:"} ${name}`,
    choose: {
      actorID: substitute.actor_id,
      label: ru
        ? `Выбрать ${firstNameIn(substitute.display_name, "accusative")}`
        : `Choose ${name}`,
    },
  };
}

/** «Вы замещаете Анну до 30 ноября» / «… с 20 по 30 ноября» in «Ещё». */
export function substitutingLine(
  entry: Pick<SubstitutingEntry, "away">,
  name: string,
  now: Date,
  locale: CalendarLocale,
): string {
  const ru = locale === "ru";
  const who = ru ? firstNameIn(name, "accusative") : firstName(name);
  const when = isAwayPlanned(entry.away, now)
    ? formatAwayPeriod(entry.away, now, locale)
    : `${until(locale)} ${formatAwayUntil(new Date(instant(entry.away.ends_at)), now, locale)}`;
  return ru
    ? `Вы замещаете ${who} ${when}`
    : `You substitute for ${who} ${when}`;
}

/** «выкл. до 30 ноября» on the «Уведомления» row while one's push is muted. */
export function awayNotificationsText(
  away:
    | Pick<AwayPublic, "starts_at" | "ends_at" | "notifications_off">
    | null
    | undefined,
  now: Date,
  locale: CalendarLocale,
): string | null {
  if (!away?.notifications_off || !isAwayActive(away, now)) return null;
  const end = new Date(instant(away.ends_at));
  return `${locale === "ru" ? "выкл." : "off"} ${until(locale)} ${formatAwayUntil(end, now, locale)}`;
}

/** An auto-reply message: the «АВТООТВЕТ» mark and a muted bubble. */
export function isAutoReply(message: Pick<Message, "auto_reply">): boolean {
  return message.auto_reply === true;
}

// ---------------------------------------------------------------------------
// «Люди»: «Все · На месте · Отсутствуют»

export type AwayPresenceFilter = "all" | "here" | "away";

export const awayPresenceFilterLabelKeys: Record<AwayPresenceFilter, string> = {
  all: "peopleFilterAll",
  here: "peopleFilterHere",
  away: "peopleFilterAway",
};

/** The chips; none before the server has actor_away. */
export function awayPresenceFilters(
  features: Iterable<string> | null | undefined,
): AwayPresenceFilter[] {
  return awayAvailable(features) ? ["all", "here", "away"] : [];
}

/** The `presence` parameter of listActors for a chip. */
export function awayPresenceParam(
  filter: AwayPresenceFilter,
): "here" | "away" | undefined {
  return filter === "all" ? undefined : filter;
}

/** The chip over a loaded list: agents are neither here nor away. */
export function matchesAwayPresence(
  person: Pick<AwayPerson, "away" | "type">,
  filter: AwayPresenceFilter,
  now: Date,
): boolean {
  if (filter === "all") return true;
  if (person.type === "agent") return false;
  return isAwayActive(person.away, now) === (filter === "away");
}

/**
 * The caption under a name in «Люди»: «инструктор · в отпуске до 30
 * ноября», yellow (`away`) while it is in effect. A planned one is in the
 * person's card (awayLine), not here.
 */
export function personAwayCaption(
  person: { title?: string | null; away?: AwayPublic | null; type?: string },
  now: Date,
  locale: CalendarLocale,
): { text: string; away: boolean } {
  const title = (person.title ?? "").trim();
  const away = person.type === "agent" ? null : activeAway(person.away, now);
  if (!away) return { text: title, away: false };
  const line = awayLine(away, now, locale);
  return { text: title ? `${title} · ${line}` : line, away: true };
}

// ---------------------------------------------------------------------------
// Realtime and the cache

export type AwayEvent =
  | {
      type: "actor.away.updated";
      data: { actor_id: string; away: AwayPublic | null };
    }
  | {
      type: "away.substitute.assigned";
      data: { actor_id: string; starts_at: string; ends_at: string };
    }
  | { type: "away.substitute.removed"; data: { actor_id: string } };

export type AwayEventType = AwayEvent["type"];

export function isAwayEvent(type: string): type is AwayEventType {
  return (
    type === "actor.away.updated" ||
    type === "away.substitute.assigned" ||
    type === "away.substitute.removed"
  );
}

const isString = (value: unknown): value is string => typeof value === "string";

/** An AwayPublic as the client needs it; anything else is null. */
export function parseAwayPublic(value: unknown): AwayPublic | null {
  if (!value || typeof value !== "object") return null;
  const away = value as Record<string, unknown>;
  if (
    !awayKinds.includes(away.kind as AwayKind) ||
    !isString(away.starts_at) ||
    !isString(away.ends_at) ||
    !(away.substitute_id === null || isString(away.substitute_id))
  )
    return null;
  return {
    kind: away.kind as AwayKind,
    label: isString(away.label) ? away.label : "",
    starts_at: away.starts_at,
    ends_at: away.ends_at,
    active: away.active === true,
    substitute_id: (away.substitute_id as string | null) ?? null,
    notifications_off: away.notifications_off === true,
  };
}

/** An away event with the expected shape, else null (the log is replayed). */
export function parseAwayEvent(event: DurableEvent): AwayEvent | null {
  const value = event.data as Record<string, unknown> | null;
  if (!value || typeof value !== "object" || !isString(value.actor_id))
    return null;
  const actorID = value.actor_id;
  if (event.type === "actor.away.updated") {
    if (value.away === null)
      return { type: event.type, data: { actor_id: actorID, away: null } };
    const away = parseAwayPublic(value.away);
    return away
      ? { type: event.type, data: { actor_id: actorID, away } }
      : null;
  }
  if (event.type === "away.substitute.assigned") {
    if (!isString(value.starts_at) || !isString(value.ends_at)) return null;
    return {
      type: event.type,
      data: {
        actor_id: actorID,
        starts_at: value.starts_at,
        ends_at: value.ends_at,
      },
    };
  }
  if (event.type === "away.substitute.removed")
    return { type: event.type, data: { actor_id: actorID } };
  return null;
}

/**
 * Away statuses learnt from actor.away.updated, by person; null — removed.
 * Fresher than any page read before the event.
 */
export type AwayOverrides = Record<string, AwayPublic | null>;

/** The away status to show: an event's first, then what REST said. */
export function currentAway(
  actorID: string,
  rest: AwayPublic | null | undefined,
  overrides: AwayOverrides,
): AwayPublic | null {
  return actorID in overrides ? (overrides[actorID] ?? null) : (rest ?? null);
}

/** A person object with the fresher away status put in. */
export function withCurrentAway<
  T extends { actor_id: string; away?: AwayPublic | null },
>(person: T, overrides: AwayOverrides): T {
  if (!(person.actor_id in overrides)) return person;
  return { ...person, away: overrides[person.actor_id] ?? null };
}

/**
 * Applies away.substitute.* and actor.away.updated to «Вы замещаете …»
 * (listSubstituting). `stale` asks to read the list again: a new entry,
 * whose AwayPublic the event does not carry.
 */
export function reduceSubstituting(
  items: readonly SubstitutingEntry[],
  event: AwayEvent,
): { items: SubstitutingEntry[]; changed: boolean; stale: boolean } {
  const index = items.findIndex(
    (item) => item.actor_id === event.data.actor_id,
  );
  if (event.type === "away.substitute.removed") {
    if (index < 0) return { items: [...items], changed: false, stale: false };
    return {
      items: items.filter((_, i) => i !== index),
      changed: true,
      stale: false,
    };
  }
  if (event.type === "away.substitute.assigned") {
    if (index < 0) return { items: [...items], changed: false, stale: true };
    const next = [...items];
    next[index] = {
      ...items[index]!,
      away: {
        ...items[index]!.away,
        starts_at: event.data.starts_at,
        ends_at: event.data.ends_at,
      },
    };
    return { items: next, changed: true, stale: false };
  }
  if (index < 0) return { items: [...items], changed: false, stale: false };
  const away = event.data.away;
  if (!away)
    return {
      items: items.filter((_, i) => i !== index),
      changed: true,
      stale: false,
    };
  const next = [...items];
  next[index] = { ...items[index]!, away };
  return { items: next, changed: true, stale: false };
}

/** TanStack Query keys; they always carry the reader's id. */
export const awayKeys = {
  all: (userID: string) => ["away", userID] as const,
  mine: (userID: string) => ["away", userID, "mine"] as const,
  substituting: (userID: string) => ["away", userID, "substituting"] as const,
  people: (userID: string, filter: AwayPresenceFilter) =>
    ["away", userID, "people", filter] as const,
};

export type AwayErrorKind =
  | "invalid"
  /** The substitute is an agent, inactive or away themselves. */
  | "substituteInvalid"
  /** Changed on another device meanwhile: read getAway again. */
  | "conflict"
  | "forbidden"
  | "rateLimited"
  /** The server has no «Отсутствую» yet. */
  | "unavailable"
  | "network"
  | "other";

/** What went wrong with an away call, for the toast. */
export function awayErrorKind(error: unknown): AwayErrorKind {
  if (!(error instanceof APIError)) return "network";
  switch (error.code) {
    case "away_invalid":
    case "validation_failed":
      return "invalid";
    case "away_substitute_invalid":
      return "substituteInvalid";
    case "away_version_conflict":
    case "version_conflict":
      return "conflict";
    case "forbidden":
      return "forbidden";
    case "rate_limited":
      return "rateLimited";
    case "not_implemented":
      return "unavailable";
  }
  if (error.status === 403) return "forbidden";
  if (error.status === 422) return "invalid";
  if (error.status === 429) return "rateLimited";
  if (error.status === 501) return "unavailable";
  return "other";
}

/** The field the server named in 422 away_invalid (`details.field`). */
export function awayInvalidField(error: unknown): string | null {
  if (!(error instanceof APIError) || error.code !== "away_invalid")
    return null;
  return typeof error.details.field === "string" ? error.details.field : null;
}
