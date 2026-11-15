import { APIError } from "./api";
import {
  atLocal,
  clockTime,
  dayMonth,
  localDayDistance,
  weekdayShort,
  type CalendarLocale,
} from "./calendar";
import { canAddressGroups, expandDepartment, expandPosition } from "./org";
import { pluralCategory } from "./presenceText";
import { hasServerFeature, serverFeature } from "./realtime";
import type {
  ChatMember,
  CreateRequestRequest,
  DurableEvent,
  Message,
  MessageRequest,
  MessageRequestViewer,
  MessageRequestViewerAnswer,
  OrgStructure,
  RequestAnswer,
  RequestAnswerCounts,
  RequestAnswerPreset,
  RequestAnswerSpec,
  RequestAssignedEvent,
  RequestAnswerUpdatedEvent,
  RequestAudience,
  RequestAutoRemindedEvent,
  RequestRemindedEvent,
  RequestRemindResult,
  RequestTallyUpdatedEvent,
  RequestUpdatedEvent,
  User,
} from "./types";

/**
 * Requests («Запрос»): a message that asks chosen people for an answer with
 * one tap. Shared by the phone and the web: the answer types, the form
 * checks, the due dates offered, the card each reader sees and keeping the
 * request current from realtime events.
 *
 * What every reader may see lives on the message (`Message.request`, the
 * same for all). What this reader may do lives in a separate viewer
 * (`MessageRequestViewer`): REST pages carry it as `Message.request_viewer`,
 * realtime frames never do. The client keeps viewers in a map by message id
 * (see RequestViewerEntry and the messenger store).
 */

/** The server limits, mirrored for the form. */
export const requestLimits = {
  maxRecipients: 500,
  customOptionsMin: 2,
  customOptionsMax: 4,
  customOptionMaxLength: 32,
  commentMaxLength: 280,
  /** A due date at least 10 minutes ahead… */
  dueMinLeadMs: 10 * 60_000,
  /** …and at most 90 days ahead. */
  dueHorizonMs: 90 * 24 * 60 * 60_000,
  /** The automatic reminder needs the due date at least an hour ahead. */
  autoRemindMinLeadMs: 60 * 60_000,
  /** A manual reminder again after 2 hours… */
  remindIntervalMs: 2 * 60 * 60_000,
  /** …and at most 5 per request. */
  remindMax: 5,
} as const;

// ---------------------------------------------------------------------------
// Answer types

/** Ready-made answer types in the order of the form; custom last. */
export const requestAnswerPresets: readonly RequestAnswerPreset[] = [
  "ack",
  "yes_no",
  "attend",
  "done",
  "custom",
];

/** Translation keys of the answer types: «Ознакомлен(а)», «Да / Нет»… */
export const requestPresetLabelKeys: Record<RequestAnswerPreset, string> = {
  ack: "requestPresetAck",
  yes_no: "requestPresetYesNo",
  attend: "requestPresetAttend",
  done: "requestPresetDone",
  custom: "requestPresetCustom",
};

/**
 * Translation keys of the buttons of each ready-made type. They are stored
 * on the server as a key and worded by the client; custom buttons are text.
 */
export const requestPresetOptionKeys: Record<
  Exclude<RequestAnswerPreset, "custom">,
  readonly string[]
> = {
  ack: ["requestOptionAck"],
  yes_no: ["requestOptionYes", "requestOptionNo"],
  attend: ["requestOptionAttend", "requestOptionNotAttend"],
  done: ["requestOptionDone"],
};

type Translate = (key: string) => string;

/**
 * Button labels of a request, in option order: tally[i], answer.option and
 * filter=option:i all index this list. A type from a newer server falls back
 * to the options it sends, if any.
 */
export function requestOptionLabels(
  request: { answer: RequestAnswerSpec },
  t: Translate,
): string[] {
  const { preset, options } = request.answer;
  if (preset === "custom") return [...(options ?? [])];
  const keys =
    requestPresetOptionKeys[preset as Exclude<RequestAnswerPreset, "custom">];
  if (keys) return keys.map((key) => t(key));
  return [...(options ?? [])];
}

// ---------------------------------------------------------------------------
// The form

export type RequestDraftAudience =
  | { kind: "chat" }
  | { kind: "people"; actorIDs: string[] }
  /** Wave 2: everyone of the department and its subdepartments. */
  | { kind: "department"; departmentID: string }
  /** Wave 2: everyone with the position. */
  | { kind: "position"; positionID: string };

export type RequestAudienceSegment = RequestDraftAudience["kind"];

/**
 * The segments of «Кому» in the request form: «Весь чат» and «Люди» for
 * everyone; «Отдел» and «Должность» only when the server announced both
 * message_requests and org_structure and the author may address groups
 * (requests.address_groups, the owner always). With a structure, a segment
 * with nothing to choose (no departments, no positions) is left out.
 */
export function audienceSegments(
  user: User,
  features: Iterable<string> | null | undefined,
  structure?: OrgStructure | null,
): RequestAudienceSegment[] {
  const segments: RequestAudienceSegment[] = ["chat", "people"];
  const list = features ? [...features] : [];
  if (
    !hasServerFeature(list, serverFeature.requests) ||
    !hasServerFeature(list, serverFeature.orgStructure) ||
    !canAddressGroups(user)
  )
    return segments;
  if (!structure || structure.departments.length) segments.push("department");
  if (!structure || structure.positions.length) segments.push("position");
  return segments;
}

export type RequestDraft = {
  body: string;
  audience: RequestDraftAudience;
  preset: RequestAnswerPreset;
  /** Custom buttons as typed, blank rows included; see requestCustomOptions. */
  customOptions: string[];
  allowComment: boolean;
  dueAt: Date | null;
  /** The switch; it only takes effect with a due date an hour ahead. */
  autoRemind: boolean;
};

/** A fresh form, as the prototype opens it. */
export function emptyRequestDraft(): RequestDraft {
  return {
    body: "",
    audience: { kind: "chat" },
    preset: "ack",
    customOptions: ["", ""],
    allowComment: true,
    dueAt: null,
    autoRemind: true,
  };
}

/** Custom buttons that will be sent: trimmed, blank rows left out. */
export function requestCustomOptions(
  draft: Pick<RequestDraft, "customOptions">,
) {
  return draft.customOptions
    .map((option) => option.trim())
    .filter((option) => option.length > 0);
}

/**
 * Who will be asked: active people of the chat for «Весь чат», the chosen
 * ones for «Люди», the people of the department (with subdepartments) or
 * of the position who are in the chat; never the author and never agents.
 * The server does the same at the moment of sending; this is for «Ждём от N
 * человек». A department or position needs the structure; without it
 * nobody is counted.
 */
export function requestRecipientIDs(
  audience: RequestDraftAudience,
  members: readonly Pick<ChatMember, "actor_id" | "type">[],
  selfID: string,
  structure?: OrgStructure | null,
): string[] {
  const people = members.filter(
    (member) => member.type === "user" && member.actor_id !== selfID,
  );
  if (audience.kind === "chat") return people.map((member) => member.actor_id);
  if (audience.kind === "department" || audience.kind === "position") {
    if (!structure) return [];
    const options = {
      chatMemberIDs: people.map((member) => member.actor_id),
      excludeActorID: selfID,
    };
    const expansion =
      audience.kind === "department"
        ? expandDepartment(structure, audience.departmentID, options)
        : expandPosition(structure, audience.positionID, options);
    return expansion.inChat.map((person) => person.actorID);
  }
  const chosen = new Set(audience.actorIDs);
  return people
    .filter((member) => chosen.has(member.actor_id))
    .map((member) => member.actor_id);
}

/** «Ждём от N человек»: requestRecipientIDs(...).length. */
export function audienceCount(
  audience: RequestDraftAudience,
  structure: OrgStructure | null | undefined,
  members: readonly Pick<ChatMember, "actor_id" | "type">[],
  authorID: string,
): number {
  return requestRecipientIDs(audience, members, authorID, structure).length;
}

export type RequestDueProblem = "past" | "tooFar";

/** Why the server would refuse this due date; null when it is fine. */
export function requestDueProblem(
  at: Date,
  now: Date,
): RequestDueProblem | null {
  const lead = at.getTime() - now.getTime();
  if (!Number.isFinite(lead) || lead < requestLimits.dueMinLeadMs)
    return "past";
  if (lead > requestLimits.dueHorizonMs) return "tooFar";
  return null;
}

/** The automatic reminder switch is available: a due date an hour ahead. */
export function autoRemindAvailable(dueAt: Date | null, now: Date): boolean {
  return (
    dueAt !== null &&
    dueAt.getTime() - now.getTime() >= requestLimits.autoRemindMinLeadMs
  );
}

/**
 * When those who have not answered get the automatic reminder, the server's
 * formula: max(due − 24 h, created + (due − created) / 2). For «до пт, 18:00»
 * set on Tuesday it is Thursday 18:00; for «сегодня, 18:00» set at 10:00 it
 * is 14:00.
 */
export function autoRemindAt(created: Date, due: Date): Date {
  const dayBefore = due.getTime() - 24 * 60 * 60_000;
  const halfway =
    created.getTime() + Math.floor((due.getTime() - created.getTime()) / 2);
  return new Date(Math.max(dayBefore, halfway));
}

export type RequestDraftProblem =
  | { field: "body"; reason: "empty" }
  | { field: "audience"; reason: "empty" | "tooMany" }
  | {
      field: "options";
      reason: "tooFew" | "tooMany" | "tooLong" | "duplicate";
      /** The offending button among requestCustomOptions. */
      index?: number;
    }
  | { field: "dueAt"; reason: RequestDueProblem };

/**
 * The first reason the form cannot be sent, in the order of its fields;
 * null when it can. `recipients` is requestRecipientIDs(...).length.
 */
export function requestDraftProblem(
  draft: RequestDraft,
  now: Date,
  recipients: number,
): RequestDraftProblem | null {
  if (!draft.body.trim()) return { field: "body", reason: "empty" };
  if (recipients < 1) return { field: "audience", reason: "empty" };
  if (recipients > requestLimits.maxRecipients)
    return { field: "audience", reason: "tooMany" };
  if (draft.preset === "custom") {
    const options = requestCustomOptions(draft);
    if (options.length < requestLimits.customOptionsMin)
      return { field: "options", reason: "tooFew" };
    if (options.length > requestLimits.customOptionsMax)
      return { field: "options", reason: "tooMany" };
    const seen = new Set<string>();
    for (const [index, option] of options.entries()) {
      if ([...option].length > requestLimits.customOptionMaxLength)
        return { field: "options", reason: "tooLong", index };
      const folded = option.toLowerCase();
      if (seen.has(folded))
        return { field: "options", reason: "duplicate", index };
      seen.add(folded);
    }
  }
  if (draft.dueAt) {
    const reason = requestDueProblem(draft.dueAt, now);
    if (reason) return { field: "dueAt", reason };
  }
  return null;
}

/**
 * The body of createRequest. The automatic reminder is sent only when the
 * due date allows it, as the switch shows.
 */
export function toCreateRequestInput(
  draft: RequestDraft,
  clientMsgID: string,
  now: Date,
  extra: {
    bodyFormat?: "plain" | "markdown";
    mentionedActorIDs?: string[];
    /** Only when the server announced org_structure. */
    mentionedDepartmentIDs?: string[];
  } = {},
): CreateRequestRequest {
  const input: CreateRequestRequest = {
    client_msg_id: clientMsgID,
    body: draft.body.trim(),
    body_format: extra.bodyFormat ?? "plain",
    audience: audienceInput(draft.audience),
    answer:
      draft.preset === "custom"
        ? { preset: "custom", options: requestCustomOptions(draft) }
        : { preset: draft.preset },
    allow_comment: draft.allowComment,
    auto_remind: draft.autoRemind && autoRemindAvailable(draft.dueAt, now),
  };
  if (draft.dueAt) input.due_at = draft.dueAt.toISOString();
  if (extra.mentionedActorIDs?.length)
    input.mentioned_actor_ids = [...extra.mentionedActorIDs];
  if (extra.mentionedDepartmentIDs?.length)
    input.mentioned_department_ids = [...extra.mentionedDepartmentIDs];
  return input;
}

function audienceInput(
  audience: RequestDraftAudience,
): CreateRequestRequest["audience"] {
  switch (audience.kind) {
    case "chat":
      return { kind: "chat" };
    case "people":
      return { kind: "people", actor_ids: [...audience.actorIDs] };
    case "department":
      return { kind: "department", department_id: audience.departmentID };
    case "position":
      return { kind: "position", position_id: audience.positionID };
  }
}

/**
 * Everything a createRequest depends on but its client_msg_id. A retry with
 * the same signature reuses the id, so the server returns the message it
 * already made instead of a second request.
 */
export function requestSignature(input: CreateRequestRequest): string {
  return JSON.stringify([
    input.body,
    input.body_format ?? "plain",
    input.audience.kind,
    [...(input.audience.actor_ids ?? [])].sort(),
    input.audience.department_id ?? null,
    input.audience.position_id ?? null,
    input.answer.preset,
    input.answer.options ?? [],
    input.allow_comment ?? true,
    input.due_at ?? null,
    Boolean(input.auto_remind),
    [...(input.mentioned_actor_ids ?? [])].sort(),
    [...(input.mentioned_department_ids ?? [])].sort(),
  ]);
}

// ---------------------------------------------------------------------------
// Due dates

export type RequestDuePresetID = "today" | "tomorrow" | "friday";
export type RequestDuePreset = { id: RequestDuePresetID; at: Date };

export const requestDueTodayHour = 18;
export const requestDueTomorrowHour = 12;
export const requestDueFridayHour = 18;

/**
 * Due dates offered as chips: «сегодня, 18:00», «завтра, 12:00» and «до пт,
 * 18:00». Today is left out when less than an hour is left before 18:00; on
 * a Friday after 17:00 «пт» is the next Friday, before 17:00 it would repeat
 * today and is left out. «Без срока» and «Другая дата» are the form's own.
 */
export function requestDuePresets(now: Date): RequestDuePreset[] {
  const today = atLocal(now, 0, requestDueTodayHour);
  const showToday =
    today.getTime() - now.getTime() >= requestLimits.autoRemindMinLeadMs;
  let daysToFriday = (5 - now.getDay() + 7) % 7;
  let friday = atLocal(now, daysToFriday, requestDueFridayHour);
  if (
    daysToFriday === 0 &&
    friday.getTime() - now.getTime() < requestLimits.autoRemindMinLeadMs
  ) {
    daysToFriday = 7;
    friday = atLocal(now, 7, requestDueFridayHour);
  }
  const presets: RequestDuePreset[] = [];
  if (showToday) presets.push({ id: "today", at: today });
  presets.push({
    id: "tomorrow",
    at: atLocal(now, 1, requestDueTomorrowHour),
  });
  if (!(daysToFriday === 0 && showToday))
    presets.push({ id: "friday", at: friday });
  return presets.filter((preset) => !requestDueProblem(preset.at, now));
}

/**
 * A due date as people say it: «сегодня, 18:00», «завтра, 12:00», «пт,
 * 18:00» within a week, «20 ноября, 18:00» further. Callers add «до» where
 * the prototype has it («до пт, 18:00», «ответить до пт»).
 */
export function formatRequestDue(
  due: Date,
  now: Date,
  locale: CalendarLocale,
): string {
  const time = clockTime(due, locale);
  const days = localDayDistance(due, now);
  const ru = locale === "ru";
  if (days === 0) return `${ru ? "сегодня" : "today"}, ${time}`;
  if (days === 1) return `${ru ? "завтра" : "tomorrow"}, ${time}`;
  if (days === -1) return `${ru ? "вчера" : "yesterday"}, ${time}`;
  if (days > 1 && days < 7) return `${weekdayShort(due, locale)}, ${time}`;
  return `${dayMonth(due, now, locale)}, ${time}`;
}

/** The short form for a chat row: «сегодня», «завтра», «пт», «20 ноября». */
export function formatRequestDueDay(
  due: Date,
  now: Date,
  locale: CalendarLocale,
): string {
  const days = localDayDistance(due, now);
  const ru = locale === "ru";
  if (days === 0) return ru ? "сегодня" : "today";
  if (days === 1) return ru ? "завтра" : "tomorrow";
  if (days === -1) return ru ? "вчера" : "yesterday";
  if (days > 1 && days < 7) return weekdayShort(due, locale);
  return dayMonth(due, now, locale);
}

/**
 * Whom the request asks, without names: «весь чат», «3 человека», the name
 * of the only person, and from wave 2 «отдел «Зал ЛФК»».
 */
export function requestAudienceText(
  audience: Pick<RequestAudience, "kind" | "label" | "count">,
  locale: CalendarLocale,
): string {
  const ru = locale === "ru";
  switch (audience.kind) {
    case "chat":
      return ru ? "весь чат" : "whole chat";
    case "department":
      return ru ? `отдел «${audience.label}»` : `${audience.label} department`;
    case "position":
      return ru ? `должность «${audience.label}»` : audience.label;
  }
  if (audience.label) return audience.label;
  const forms = ru
    ? { one: "человек", few: "человека", many: "человек" }
    : { one: "person", few: "people", many: "people" };
  return `${audience.count} ${forms[pluralCategory(audience.count, locale)]}`;
}

/**
 * The chosen addressee in the form, before sending: «отдел «Зал ЛФК»»,
 * «должность «Врач»», «весь чат», «3 человека». `peopleCount` is the number
 * of chosen people for «Люди».
 */
export function requestDraftAudienceText(
  audience: RequestDraftAudience,
  structure: OrgStructure | null | undefined,
  locale: CalendarLocale,
): string {
  switch (audience.kind) {
    case "chat":
      return requestAudienceText({ kind: "chat", label: "", count: 0 }, locale);
    case "people":
      return requestAudienceText(
        { kind: "people", label: "", count: audience.actorIDs.length },
        locale,
      );
    case "department":
      return requestAudienceText(
        {
          kind: "department",
          label:
            structure?.departments.find(
              (item) => item.id === audience.departmentID,
            )?.name ?? "",
          count: 0,
        },
        locale,
      );
    case "position":
      return requestAudienceText(
        {
          kind: "position",
          label:
            structure?.positions.find((item) => item.id === audience.positionID)
              ?.name ?? "",
          count: 0,
        },
        locale,
      );
  }
}

// ---------------------------------------------------------------------------
// The viewer map

/**
 * What the client knows about the reader's part in one request. REST gives
 * the whole viewer; `request.assigned` arrives before the message and only
 * says «this one is for you», so the card shows buttons at once instead of
 * flashing «не от вас».
 */
export type RequestViewerEntry = {
  viewer: MessageRequestViewer;
  /**
   * MessageRequest.version the viewer flags and tally are as of. Events
   * older than it are dropped.
   */
  version: number;
  /** Known from request.assigned or an answer event only: read getRequest for the rest. */
  provisional: boolean;
};

export type RequestViewers = Record<string, RequestViewerEntry>;

/** The viewer of a recipient known only from request.assigned. */
export function provisionalRecipient(): MessageRequestViewer {
  return {
    role: "recipient",
    answer: null,
    can_answer: true,
    can_change: false,
    can_view_answers: false,
    can_close: false,
    can_remind: false,
    next_remind_at: null,
    tally: null,
  };
}

function newerAnswer(
  left: MessageRequestViewerAnswer | null,
  right: MessageRequestViewerAnswer | null,
): MessageRequestViewerAnswer | null {
  if (!left) return right;
  if (!right) return left;
  return right.version >= left.version ? right : left;
}

/**
 * Puts a viewer read by REST (the feed, getRequest, answerRequest,
 * closeRequest, the inbox) into the map. The fresher one wins; an answer is
 * never replaced by an older one.
 */
export function mergeRequestViewer(
  current: RequestViewerEntry | undefined,
  viewer: MessageRequestViewer,
  version: number,
): RequestViewerEntry {
  const incoming: RequestViewerEntry = { viewer, version, provisional: false };
  if (!current) return incoming;
  const base =
    current.provisional || version >= current.version ? incoming : current;
  return {
    ...base,
    viewer: {
      ...base.viewer,
      answer: newerAnswer(current.viewer.answer, viewer.answer),
    },
  };
}

// ---------------------------------------------------------------------------
// Realtime

export type RequestEventType =
  | "request.assigned"
  | "request.updated"
  | "request.tally.updated"
  | "request.answer.updated"
  | "request.reminded"
  | "request.auto_reminded";

export function isRequestEvent(type: string): type is RequestEventType {
  return type.startsWith("request.");
}

export type RequestEvent =
  | { type: "request.assigned"; data: RequestAssignedEvent; occurredAt: string }
  | { type: "request.updated"; data: RequestUpdatedEvent; occurredAt: string }
  | {
      type: "request.tally.updated";
      data: RequestTallyUpdatedEvent;
      occurredAt: string;
    }
  | {
      type: "request.answer.updated";
      data: RequestAnswerUpdatedEvent;
      occurredAt: string;
    }
  | { type: "request.reminded"; data: RequestRemindedEvent; occurredAt: string }
  | {
      type: "request.auto_reminded";
      data: RequestAutoRemindedEvent;
      occurredAt: string;
    };

const isString = (value: unknown): value is string => typeof value === "string";
const isCount = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;
const isNullableString = (value: unknown): value is string | null =>
  value === null || typeof value === "string";

/**
 * A request.* event when its data has the expected shape, null otherwise:
 * the log is replayed to new devices and may come from a newer server, so it
 * is checked rather than trusted.
 */
export function parseRequestEvent(event: DurableEvent): RequestEvent | null {
  const value = event.data as Record<string, unknown> | null;
  if (!value || typeof value !== "object") return null;
  if (!isString(value.message_id) || !isString(value.chat_id)) return null;
  const occurredAt = event.occurred_at;
  const ids = { message_id: value.message_id, chat_id: value.chat_id };
  switch (event.type) {
    case "request.assigned":
      return {
        type: event.type,
        occurredAt,
        data: { ...ids, due_at: isString(value.due_at) ? value.due_at : null },
      };
    case "request.updated":
      if (
        (value.status !== "open" && value.status !== "closed") ||
        !isCount(value.answered_count) ||
        !isCount(value.waiting_count) ||
        !isCount(value.version)
      )
        return null;
      return {
        type: event.type,
        occurredAt,
        data: {
          ...ids,
          status: value.status,
          closed_reason: isString(value.closed_reason)
            ? (value.closed_reason as RequestUpdatedEvent["closed_reason"])
            : null,
          answered_count: value.answered_count,
          waiting_count: value.waiting_count,
          version: value.version,
        },
      };
    case "request.tally.updated":
      if (
        !Array.isArray(value.tally) ||
        !value.tally.every(isCount) ||
        !isCount(value.waiting_count) ||
        !isCount(value.version)
      )
        return null;
      return {
        type: event.type,
        occurredAt,
        data: {
          ...ids,
          tally: [...(value.tally as number[])],
          waiting_count: value.waiting_count,
          version: value.version,
        },
      };
    case "request.answer.updated":
      if (
        !isCount(value.option) ||
        typeof value.has_comment !== "boolean" ||
        typeof value.late !== "boolean" ||
        !isCount(value.version)
      )
        return null;
      return {
        type: event.type,
        occurredAt,
        data: {
          ...ids,
          option: value.option,
          has_comment: value.has_comment,
          late: value.late,
          version: value.version,
        },
      };
    case "request.reminded":
      if (value.kind !== "manual" && value.kind !== "auto") return null;
      return {
        type: event.type,
        occurredAt,
        data: { ...ids, kind: value.kind },
      };
    case "request.auto_reminded":
      if (
        !isCount(value.reminded) ||
        !isCount(value.answered_count) ||
        !isCount(value.waiting_count)
      )
        return null;
      return {
        type: event.type,
        occurredAt,
        data: {
          ...ids,
          reminded: value.reminded,
          answered_count: value.answered_count,
          waiting_count: value.waiting_count,
        },
      };
  }
  return null;
}

export type RequestCacheEntry = {
  /** Message.request of the cached message; null when it is not loaded. */
  request: MessageRequest | null;
  viewer: RequestViewerEntry | null;
};

export type RequestReduction = RequestCacheEntry & {
  changed: boolean;
  /**
   * The reader's state must be read again with getRequest: the event says a
   * comment exists but carries no text.
   */
  refetch: boolean;
};

function dueOpen(request: MessageRequest | null, now: Date): boolean {
  if (!request) return true;
  if (request.status !== "open") return false;
  return !request.due_at || Date.parse(request.due_at) > now.getTime();
}

function closedViewer(viewer: MessageRequestViewer): MessageRequestViewer {
  return {
    ...viewer,
    can_answer: false,
    can_change: false,
    can_close: false,
    can_remind: false,
    next_remind_at: null,
  };
}

/**
 * Applies one request.* event to the cached request of a message and the
 * reader's viewer. Versions guard both: an event older than the cache is
 * ignored, so events replayed or arriving out of order do no harm.
 *
 * - request.updated — counts and status for everyone, by MessageRequest.version.
 * - request.tally.updated — the author's tally, by the same version.
 * - request.answer.updated — the reader's own answer from any of their
 *   devices, by MessageRequestViewerAnswer.version.
 * - request.assigned — a provisional recipient viewer when none is known.
 * - request.reminded / request.auto_reminded — nothing to cache.
 */
export function reduceRequest(
  entry: RequestCacheEntry,
  event: RequestEvent,
  now: Date,
): RequestReduction {
  const same: RequestReduction = { ...entry, changed: false, refetch: false };
  switch (event.type) {
    case "request.assigned": {
      if (entry.viewer) return same;
      return {
        request: entry.request,
        viewer: {
          viewer: provisionalRecipient(),
          version: 0,
          provisional: true,
        },
        changed: true,
        refetch: false,
      };
    }
    case "request.updated": {
      const data = event.data;
      let request = entry.request;
      let changed = false;
      if (request && data.version > request.version) {
        request = {
          ...request,
          status: data.status,
          closed_reason: data.closed_reason,
          answered_count: data.answered_count,
          waiting_count: data.waiting_count,
          audience: {
            ...request.audience,
            count: data.answered_count + data.waiting_count,
          },
          version: data.version,
        };
        changed = true;
      }
      let viewer = entry.viewer;
      if (viewer && data.version >= viewer.version) {
        let next = viewer.viewer;
        if (data.status === "closed") next = closedViewer(next);
        else if (data.waiting_count === 0)
          next = { ...next, can_remind: false, next_remind_at: null };
        if (next !== viewer.viewer || data.version > viewer.version) {
          viewer = { ...viewer, viewer: next, version: data.version };
          changed = true;
        }
      }
      return { request, viewer, changed, refetch: false };
    }
    case "request.tally.updated": {
      const data = event.data;
      const viewer = entry.viewer;
      if (!viewer || data.version < viewer.version) return same;
      if (!viewer.viewer.can_view_answers && viewer.viewer.role !== "author")
        return same;
      return {
        request: entry.request,
        viewer: {
          ...viewer,
          version: data.version,
          viewer: {
            ...viewer.viewer,
            tally: [...data.tally],
            ...(data.waiting_count === 0
              ? { can_remind: false, next_remind_at: null }
              : {}),
          },
        },
        changed: true,
        refetch: false,
      };
    }
    case "request.answer.updated": {
      const data = event.data;
      const current = entry.viewer;
      const previous = current?.viewer.answer ?? null;
      if (previous && previous.version >= data.version) return same;
      const base = current?.viewer ?? provisionalRecipient();
      const answer: MessageRequestViewerAnswer = {
        option: data.option,
        // The event carries no text: keep what is known and read it again.
        comment: data.has_comment ? (previous?.comment ?? "") : "",
        answered_at: previous?.answered_at ?? event.occurredAt,
        late: data.late,
        version: data.version,
      };
      const open = dueOpen(entry.request, now);
      return {
        request: entry.request,
        viewer: {
          version: current?.version ?? 0,
          provisional: current?.provisional ?? true,
          viewer: {
            ...base,
            role: base.role === "observer" ? "recipient" : base.role,
            answer,
            can_change: open && (current ? base.can_answer : true),
          },
        },
        changed: true,
        // A comment exists, and its text may have changed with the version.
        refetch: data.has_comment,
      };
    }
    case "request.reminded":
    case "request.auto_reminded":
      return same;
  }
}

/**
 * The cache right after the reader taps an answer, before the server
 * replies: the answer, and the count when it is the first one. Keep the
 * previous entry to roll back on an error.
 */
export function optimisticAnswer(
  entry: RequestCacheEntry,
  option: number,
  comment: string | undefined,
  now: Date,
): RequestCacheEntry {
  const viewer = entry.viewer?.viewer ?? provisionalRecipient();
  const previous = viewer.answer;
  const late =
    previous?.late ??
    Boolean(
      entry.request?.due_at &&
        Date.parse(entry.request.due_at) <= now.getTime(),
    );
  const answer: MessageRequestViewerAnswer = {
    option,
    comment: comment ?? previous?.comment ?? "",
    answered_at: previous?.answered_at ?? now.toISOString(),
    late,
    version: (previous?.version ?? 0) + 1,
  };
  const request =
    entry.request && !previous
      ? {
          ...entry.request,
          answered_count: entry.request.answered_count + 1,
          waiting_count: Math.max(0, entry.request.waiting_count - 1),
        }
      : entry.request;
  return {
    request,
    viewer: {
      version: entry.viewer?.version ?? 0,
      provisional: entry.viewer?.provisional ?? true,
      viewer: { ...viewer, answer, can_change: dueOpen(request, now) },
    },
  };
}

/** The author's viewer after remindRequest: the button waits until next_remind_at. */
export function afterRemind(
  viewer: MessageRequestViewer,
  result: RequestRemindResult,
): MessageRequestViewer {
  return {
    ...viewer,
    can_remind: false,
    next_remind_at: result.next_remind_at,
  };
}

// ---------------------------------------------------------------------------
// The card

export type RequestPill =
  | { kind: "due"; at: Date; overdue: boolean }
  /** «Закрыт»; yellow when it closed overdue. */
  | { kind: "closed"; warning: boolean };

export type RequestRemindState =
  | { kind: "hidden" }
  /** «Напомнить · k». */
  | { kind: "ready"; count: number }
  /** «Напомнили · повторно через …». */
  | { kind: "cooldown"; until: Date; count: number }
  /** «Все ответили». */
  | { kind: "allAnswered" };

export type RequestView = {
  role: MessageRequestViewer["role"];
  /**
   * No viewer is known yet (the message came by realtime): the card guesses
   * the role and the client should read getRequest when it is on screen.
   */
  viewerMissing: boolean;
  open: boolean;
  closedReason: MessageRequest["closed_reason"];
  dueAt: Date | null;
  /** The due date passed. */
  overdue: boolean;
  pill: RequestPill | null;
  /** «Ответили N из M». */
  answered: number;
  total: number;
  waiting: number;
  audience: RequestAudience;
  /** «Ответа ждут не от вас — кнопок нет». */
  notForYou: boolean;
  options: string[];
  /** One button: the big «✓ Ознакомлен(а)». */
  singleOption: boolean;
  /** Buttons to answer are shown. */
  showButtons: boolean;
  answer: {
    option: number;
    label: string;
    comment: string;
    /** «после срока». */
    late: boolean;
    answeredAt: Date;
  } | null;
  /** «Изменить». */
  canChange: boolean;
  /** Until when the answer may change: «изменить можно до …». */
  changeUntil: Date | null;
  /** «+ Комментарий» or editing it. */
  canComment: boolean;
  /** The author's bars, in option order; null for others. */
  tally: { label: string; count: number }[] | null;
  canViewAnswers: boolean;
  canClose: boolean;
  remind: RequestRemindState;
  /** «Автонапоминание не ответившим — чт, 18:00», while it is ahead. */
  autoRemindAt: Date | null;
  /** «изм.»: the author edited the text after sending. */
  edited: boolean;
};

/**
 * The manual reminder button of the author: ready, waiting 2 hours after the
 * last one, hidden after five, «Все ответили» when nobody is left.
 */
export function requestRemindState(
  request: Pick<MessageRequest, "status" | "waiting_count">,
  viewer: Pick<
    MessageRequestViewer,
    "role" | "can_remind" | "next_remind_at"
  > | null,
  now: Date,
): RequestRemindState {
  if (!viewer || viewer.role !== "author" || request.status !== "open")
    return { kind: "hidden" };
  if (request.waiting_count === 0) return { kind: "allAnswered" };
  if (viewer.can_remind) return { kind: "ready", count: request.waiting_count };
  const until = viewer.next_remind_at ? Date.parse(viewer.next_remind_at) : NaN;
  if (Number.isFinite(until) && until > now.getTime())
    return {
      kind: "cooldown",
      until: new Date(until),
      count: request.waiting_count,
    };
  return { kind: "hidden" };
}

/**
 * Everything the request card shows, for the three kinds of reader: the
 * recipient (buttons, then «Ваш ответ»), the author (bars, «Ответили N из M»,
 * «Напомнить») and the rest («Ответа ждут не от вас»). Null for a message
 * that is not a request.
 */
export function requestView(
  message: Pick<Message, "actor_id" | "edited_at" | "request">,
  viewer: MessageRequestViewer | null | undefined,
  context: { selfID: string; now: Date; t: Translate },
): RequestView | null {
  const request = message.request;
  if (!request) return null;
  const { now, t } = context;
  const role: MessageRequestViewer["role"] =
    viewer?.role ??
    (message.actor_id === context.selfID ? "author" : "observer");
  const open = request.status === "open";
  const dueAt = request.due_at ? new Date(request.due_at) : null;
  const overdue = dueAt !== null && dueAt.getTime() <= now.getTime();
  const options = requestOptionLabels(request, t);
  const answer = viewer?.answer ?? null;
  const total = request.audience.count;
  const pill: RequestPill | null = !open
    ? {
        kind: "closed",
        warning: request.closed_reason === "expired" || overdue,
      }
    : dueAt
      ? { kind: "due", at: dueAt, overdue }
      : null;
  const canChange = Boolean(answer && viewer?.can_change);
  const autoRemind = request.auto_remind_at
    ? new Date(request.auto_remind_at)
    : null;
  return {
    role,
    viewerMissing: !viewer,
    open,
    closedReason: request.closed_reason ?? null,
    dueAt,
    overdue,
    pill,
    answered: request.answered_count,
    total,
    waiting: request.waiting_count,
    audience: request.audience,
    notForYou: role === "observer",
    options,
    singleOption: options.length === 1,
    showButtons: role === "recipient" && !answer && Boolean(viewer?.can_answer),
    answer: answer
      ? {
          option: answer.option,
          label: options[answer.option] ?? "",
          comment: answer.comment,
          late: answer.late,
          answeredAt: new Date(answer.answered_at),
        }
      : null,
    canChange,
    changeUntil: canChange ? dueAt : null,
    canComment: canChange && request.allow_comment,
    tally:
      viewer?.tally && viewer.can_view_answers
        ? options.map((label, index) => ({
            label,
            count: viewer.tally?.[index] ?? 0,
          }))
        : null,
    canViewAnswers: Boolean(viewer?.can_view_answers),
    canClose: Boolean(viewer?.can_close),
    remind: requestRemindState(request, viewer ?? null, now),
    autoRemindAt:
      open && autoRemind && autoRemind.getTime() > now.getTime()
        ? autoRemind
        : null,
    edited: Boolean(message.edited_at),
  };
}

// ---------------------------------------------------------------------------
// «Ответы»: who answered what

export type RequestAnswerFilter = "waiting" | `option:${0 | 1 | 2 | 3}`;

export type RequestAnswerTab = {
  filter: RequestAnswerFilter;
  /** The button label; null for «Нет ответа». */
  label: string | null;
  count: number;
};

/** Tabs of the answers screen: «Нет ответа» first, then one per button. */
export function requestAnswerTabs(
  counts: RequestAnswerCounts,
  options: readonly string[],
): RequestAnswerTab[] {
  return [
    { filter: "waiting", label: null, count: counts.waiting },
    ...options.slice(0, 4).map((label, index) => ({
      filter: `option:${index}` as RequestAnswerFilter,
      label,
      count: counts.options[index] ?? 0,
    })),
  ];
}

export type RequestAnswerNote =
  /** The comment in quotes. */
  | "comment"
  /** Answered, no comment. */
  | "answered"
  /** «прочитал(а), не ответил(а)». */
  | "readNotAnswered"
  /** «не открывал(а) чат». */
  | "notOpened"
  /** Answered and left the chat since. */
  | "left";

/** The second line of a row on the answers screen. */
export function requestAnswerNote(
  item: Pick<RequestAnswer, "state" | "comment" | "read">,
): RequestAnswerNote {
  if (item.state === "left") return "left";
  if (item.state === "waiting")
    return item.read ? "readNotAnswered" : "notOpened";
  return item.comment ? "comment" : "answered";
}

// ---------------------------------------------------------------------------
// Cache keys and errors

/** TanStack Query keys; they always carry the reader's id. */
export const requestKeys = {
  all: (userID: string) => ["requests", userID] as const,
  state: (userID: string, messageID: string) =>
    ["requests", userID, "state", messageID] as const,
  answers: (userID: string, messageID: string, filter: RequestAnswerFilter) =>
    ["requests", userID, "answers", messageID, filter] as const,
  inbox: (userID: string, state: "waiting" | "answered") =>
    ["requests", userID, "inbox", state] as const,
};

export type RequestErrorKind =
  | "closed"
  /** The due date passed: the answer can no longer change. */
  | "tooLate"
  | "archived"
  /** Not a member of the chat any more. */
  | "notMember"
  | "audienceEmpty"
  | "tooManyRecipients"
  /** Departments and positions before wave 2. */
  | "audienceUnavailable"
  /** A department or position without requests.address_groups. */
  | "audienceForbidden"
  /** The department or position was deleted meanwhile. */
  | "audienceGone"
  | "limit"
  /** A manual reminder too soon; see APIError.retryAfterSeconds. */
  | "remindTooSoon"
  | "invalid"
  /** The answer changed on another device: read it again. */
  | "conflict"
  | "gone"
  | "forbidden"
  | "rateLimited"
  /** The server has no requests yet. */
  | "unavailable"
  | "network"
  | "other";

/** What went wrong with a request call, for the toast. */
export function requestErrorKind(error: unknown): RequestErrorKind {
  if (!(error instanceof APIError)) return "network";
  switch (error.code) {
    case "request_closed":
      return "closed";
    case "request_change_too_late":
      return "tooLate";
    case "chat_archived":
      return "archived";
    case "not_member":
      return "notMember";
    case "request_audience_empty":
      return "audienceEmpty";
    case "request_too_many_recipients":
      return "tooManyRecipients";
    case "request_audience_unavailable":
      return "audienceUnavailable";
    case "request_audience_forbidden":
      return "audienceForbidden";
    case "department_not_found":
    case "position_not_found":
      return "audienceGone";
    case "request_limit_reached":
      return "limit";
    case "request_remind_too_soon":
      return "remindTooSoon";
    case "request_invalid":
    case "validation_failed":
      return "invalid";
    case "version_conflict":
      return "conflict";
    case "request_not_found":
    case "message_not_found":
      return "gone";
    case "rate_limited":
      return "rateLimited";
    case "not_implemented":
      return "unavailable";
  }
  if (error.status === 404) return "gone";
  if (error.status === 403) return "forbidden";
  if (error.status === 422) return "invalid";
  if (error.status === 429) return "rateLimited";
  if (error.status === 501) return "unavailable";
  return "other";
}

/** The field the server named in 422 request_invalid (`details.field`). */
export function requestInvalidField(error: unknown): string | null {
  if (!(error instanceof APIError) || error.code !== "request_invalid")
    return null;
  return typeof error.details.field === "string" ? error.details.field : null;
}
