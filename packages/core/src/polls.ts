import { APIError } from "./api";
import type { CalendarLocale } from "./calendar";
import { pluralCategory } from "./presenceText";
import { hasServerFeature, serverFeature } from "./realtime";
import { formatRequestDue, requestDuePresets } from "./requests";
import type {
  CreatePollRequest,
  DurableEvent,
  Message,
  MessagePoll,
  PollNotifiedEvent,
  PollRemindResult,
  PollState,
  PollUpdatedEvent,
  PollViewer,
} from "./types";

/**
 * Polls («Опрос»), phase 6.7 wave 4: a message of type `poll` whose card
 * lives in the chat feed. Shared by the phone and the web: the form and its
 * checks, the due dates offered, what the card shows to whom (results only
 * after one's own vote, to the author always and to everyone once closed),
 * percentages that add up to 100, the winner, keeping the poll current from
 * realtime events by version, the optimistic vote with a rollback, and the
 * on-device memory of one's choice in an anonymous poll.
 *
 * `Message.poll` is the same for every reader (feed pages, getPoll,
 * `message.*` frames) and never carries the counts of an open poll. What
 * the reader may see and do is `PollViewer`: REST only (`poll_viewer` of
 * feed pages, getPoll, votePoll, closePoll). The author is the message's
 * `actor_id`.
 */

/** The server limits, mirrored for the form. */
export const pollLimits = {
  questionMaxLength: 300,
  optionsMin: 2,
  optionsMax: 10,
  optionMaxLength: 100,
  /** A due date at least 10 minutes ahead … */
  dueMinLeadMs: 10 * 60_000,
  /** … and at most 90 days ahead. */
  dueHorizonMs: 90 * 24 * 60 * 60_000,
  /** «Напомнить не ответившим»: once in 2 hours, at most 5 times. */
  remindCooldownMs: 2 * 60 * 60_000,
  remindMax: 5,
} as const;

/** «Горит» in «Ждут вас» and the badge: due within 24 hours (wave 3 rule). */
export const pollHotWindowMs = 24 * 60 * 60_000;

/** After poll.updated a card that shows results reads getPoll this much later. */
export const pollReloadDelayMs = 1000;

/** True when the server announced polls (`message_polls`). */
export function pollsAvailable(
  features: Iterable<string> | null | undefined,
): boolean {
  return hasServerFeature(features, serverFeature.polls);
}

// ---------------------------------------------------------------------------
// The form

export type PollDraft = {
  question: string;
  /** Rows as typed, blank ones included; the form starts with two. */
  options: string[];
  /** «Несколько ответов». */
  multiple: boolean;
  /** «Анонимно»: nobody, the author included, learns who chose what. */
  anonymous: boolean;
  /** «Принимать ответы»: null — «без срока». */
  dueAt: Date | null;
};

/** A fresh form, as prototype A opens it: two empty options, no due date. */
export function emptyPollDraft(): PollDraft {
  return {
    question: "",
    options: ["", ""],
    multiple: false,
    anonymous: false,
    dueAt: null,
  };
}

/** «+ Добавить вариант» is offered while there are fewer than 10 rows. */
export function canAddPollOption(draft: Pick<PollDraft, "options">): boolean {
  return draft.options.length < pollLimits.optionsMax;
}

/** A blank row at the end; the same draft when the form is full. */
export function addPollOption(draft: PollDraft): PollDraft {
  if (!canAddPollOption(draft)) return draft;
  return { ...draft, options: [...draft.options, ""] };
}

/** «×» on a row; at least two rows stay (an emptied one instead). */
export function removePollOption(draft: PollDraft, index: number): PollDraft {
  if (index < 0 || index >= draft.options.length) return draft;
  if (draft.options.length <= pollLimits.optionsMin) {
    const options = [...draft.options];
    options[index] = "";
    return { ...draft, options };
  }
  return { ...draft, options: draft.options.filter((_, i) => i !== index) };
}

/** The drag handle: the row at `from` moves to `to`. */
export function movePollOption(
  draft: PollDraft,
  from: number,
  to: number,
): PollDraft {
  const count = draft.options.length;
  if (from < 0 || from >= count || to < 0 || to >= count || from === to)
    return draft;
  const options = [...draft.options];
  const [row] = options.splice(from, 1);
  options.splice(to, 0, row!);
  return { ...draft, options };
}

/** Options that will be sent: trimmed, blank rows left out. */
export function pollDraftOptions(draft: Pick<PollDraft, "options">): string[] {
  return draft.options.map((option) => option.trim()).filter(Boolean);
}

export type PollDueProblem = "past" | "tooFar";

/** Why the server would refuse this due date; null when it is fine. */
export function pollDueProblem(at: Date, now: Date): PollDueProblem | null {
  const lead = at.getTime() - now.getTime();
  if (!Number.isFinite(lead) || lead < pollLimits.dueMinLeadMs) return "past";
  if (lead > pollLimits.dueHorizonMs) return "tooFar";
  return null;
}

export type PollDraftProblem =
  | { field: "question"; reason: "empty" | "tooLong" }
  | {
      field: "options";
      reason: "tooFew" | "tooMany" | "tooLong" | "duplicate";
      /** The offending row of PollDraft.options (blank rows counted). */
      index?: number;
    }
  | { field: "dueAt"; reason: PollDueProblem };

/**
 * The first reason the form cannot be sent, in the order of its fields;
 * null when it can. The server's rules: a question of 1–300 characters,
 * 2–10 options of 1–100 characters without repeats ignoring case.
 */
export function pollDraftProblem(
  draft: PollDraft,
  now: Date,
): PollDraftProblem | null {
  const question = draft.question.trim();
  if (!question) return { field: "question", reason: "empty" };
  if ([...question].length > pollLimits.questionMaxLength)
    return { field: "question", reason: "tooLong" };
  const seen = new Set<string>();
  let filled = 0;
  for (const [index, row] of draft.options.entries()) {
    const option = row.trim();
    if (!option) continue;
    filled += 1;
    if ([...option].length > pollLimits.optionMaxLength)
      return { field: "options", reason: "tooLong", index };
    const folded = option.toLocaleLowerCase();
    if (seen.has(folded))
      return { field: "options", reason: "duplicate", index };
    seen.add(folded);
  }
  if (filled < pollLimits.optionsMin)
    return { field: "options", reason: "tooFew" };
  if (filled > pollLimits.optionsMax)
    return { field: "options", reason: "tooMany" };
  if (draft.dueAt) {
    const reason = pollDueProblem(draft.dueAt, now);
    if (reason) return { field: "dueAt", reason };
  }
  return null;
}

/** The body of createPoll. */
export function toCreatePollInput(
  draft: PollDraft,
  clientMsgID: string,
): CreatePollRequest {
  return {
    client_msg_id: clientMsgID,
    question: draft.question.trim(),
    options: pollDraftOptions(draft),
    multiple: draft.multiple,
    anonymous: draft.anonymous,
    ...(draft.dueAt ? { due_at: draft.dueAt.toISOString() } : {}),
  };
}

/**
 * Everything a createPoll depends on but its client_msg_id. A retry with the
 * same signature reuses the id, so the server returns the poll it already
 * made instead of a second one.
 */
export function pollSignature(input: CreatePollRequest): string {
  return JSON.stringify([
    input.question,
    input.options,
    input.multiple,
    input.anonymous,
    input.due_at ?? null,
  ]);
}

/** The draft kept on the device, as JSON (dueAt as an ISO string). */
export function serializePollDraft(draft: PollDraft): string {
  return JSON.stringify({
    ...draft,
    dueAt: draft.dueAt?.toISOString() ?? null,
  });
}

/** A kept draft back; null when it is broken. A due date in the past is dropped. */
export function parsePollDraft(
  raw: string | null,
  now: Date,
): PollDraft | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    if (
      typeof value.question !== "string" ||
      !Array.isArray(value.options) ||
      !value.options.every((option) => typeof option === "string")
    )
      return null;
    const due = typeof value.dueAt === "string" ? new Date(value.dueAt) : null;
    const options = (value.options as string[]).slice(0, pollLimits.optionsMax);
    while (options.length < pollLimits.optionsMin) options.push("");
    return {
      question: value.question,
      options,
      multiple: value.multiple === true,
      anonymous: value.anonymous === true,
      dueAt: due && !pollDueProblem(due, now) ? due : null,
    };
  } catch {
    return null;
  }
}

/** The draft is worth keeping: something was typed. */
export function pollDraftTouched(draft: PollDraft): boolean {
  return Boolean(
    draft.question.trim() || draft.options.some((option) => option.trim()),
  );
}

// ---------------------------------------------------------------------------
// Due dates

export type PollDuePresetID = "today" | "tomorrow" | "friday";
export type PollDuePreset = { id: PollDuePresetID; at: Date };

/** Translation keys of the chips: «до 18:00», «до завтра, 12:00», «до пт, 18:00». */
export const pollDuePresetLabelKeys: Record<PollDuePresetID, string> = {
  today: "pollDueToday",
  tomorrow: "pollDueTomorrow",
  friday: "pollDueFriday",
};

/**
 * Chips of «Принимать ответы» (decision 10): the request chips «сегодня,
 * 18:00», «завтра, 12:00», «до пт, 18:00» with the poll's limits. «Без
 * срока» and «Другая дата» are the form's own.
 */
export function pollDuePresets(now: Date): PollDuePreset[] {
  return requestDuePresets(now).filter(
    (preset) => !pollDueProblem(preset.at, now),
  );
}

/** A due date as the card says it: «сегодня, 18:00», «пт, 18:00». */
export function formatPollDue(
  due: Date,
  now: Date,
  locale: CalendarLocale,
): string {
  return formatRequestDue(due, now, locale);
}

// ---------------------------------------------------------------------------
// Results

/**
 * Whole percentages of the counts that add up to exactly 100 (largest
 * remainder). Equal remainders go to the earlier option, so equal counts
 * differ by at most one point and the same counts always give the same
 * numbers. All zero (nobody voted) — all zero.
 *
 * In a poll with «несколько ответов» the base is the sum of the counts, not
 * the voters: the bars then still add up to the whole.
 */
export function pollPercents(counts: readonly number[]): number[] {
  const safe = counts.map((count) =>
    Number.isFinite(count) && count > 0 ? Math.floor(count) : 0,
  );
  const total = safe.reduce((sum, count) => sum + count, 0);
  if (total === 0) return safe.map(() => 0);
  const exact = safe.map((count) => (count * 100) / total);
  const result = exact.map(Math.floor);
  let left = 100 - result.reduce((sum, value) => sum + value, 0);
  const order = exact
    .map((value, index) => ({ index, rest: value - Math.floor(value) }))
    .sort((a, b) => b.rest - a.rest || a.index - b.index);
  for (const { index } of order) {
    if (left <= 0) break;
    result[index]! += 1;
    left -= 1;
  }
  return result;
}

export type PollWinner = {
  /** Options with the most votes, in option order; several on a tie. */
  indexes: number[];
  votes: number;
};

/** The leading options; null when nobody voted. */
export function pollWinner(
  counts: readonly number[] | null | undefined,
): PollWinner | null {
  if (!counts?.length) return null;
  const votes = Math.max(...counts);
  if (!Number.isFinite(votes) || votes <= 0) return null;
  return {
    indexes: counts.flatMap((count, index) => (count === votes ? [index] : [])),
    votes,
  };
}

const quote = (locale: CalendarLocale, text: string) =>
  locale === "ru" ? `«${text}»` : `“${text}”`;

/**
 * «Итог: «Среда» — 5 из 9» under a closed poll: the winner's votes of all
 * who voted. A tie names every leader («Итог: «Среда», «Пятница» — по 3 из
 * 9»). Null when nobody voted.
 */
export function pollResultText(
  poll: Pick<MessagePoll, "options" | "voter_count">,
  counts: readonly number[] | null | undefined,
  locale: CalendarLocale,
): string | null {
  const winner = pollWinner(counts);
  if (!winner) return null;
  const names = winner.indexes
    .map((index) => quote(locale, poll.options[index] ?? ""))
    .join(", ");
  const tie = winner.indexes.length > 1;
  if (locale === "ru")
    return `Итог: ${names} — ${tie ? "по " : ""}${winner.votes} из ${poll.voter_count}`;
  return `Result: ${names} — ${winner.votes} of ${poll.voter_count}${tie ? " each" : ""}`;
}

/** «5 из 9 ответили» / «5 of 9 voted». */
export function pollAnsweredText(
  voted: number,
  members: number,
  locale: CalendarLocale,
): string {
  return locale === "ru"
    ? `${voted} из ${members} ответили`
    : `${voted} of ${members} voted`;
}

/** «Не ответили · 4» / «No vote · 4». */
export function pollWaitingText(count: number, locale: CalendarLocale): string {
  return locale === "ru" ? `Не ответили · ${count}` : `No vote · ${count}`;
}

/** «12 голосов» / «12 votes», for the bars. */
export function pollVotesText(count: number, locale: CalendarLocale): string {
  if (locale === "en") return `${count} ${count === 1 ? "vote" : "votes"}`;
  const forms = { one: "голос", few: "голоса", many: "голосов" };
  return `${count} ${forms[pluralCategory(count, "ru")]}`;
}

// ---------------------------------------------------------------------------
// The card

/** What the reader is assumed to see before getPoll answered. */
export function pollViewerGuess(
  poll: Pick<MessagePoll, "status" | "final_counts" | "anonymous">,
  isAuthor: boolean,
): PollViewer {
  const open = poll.status === "open";
  return {
    voted: false,
    my_options: null,
    can_vote: open,
    can_change: false,
    can_view_results: isAuthor || !open,
    can_view_voters: (isAuthor || !open) && !poll.anonymous,
    can_view_waiting: isAuthor && !poll.anonymous,
    can_close: open && isAuthor,
    can_remind: false,
    next_remind_at: null,
    counts: open ? null : (poll.final_counts ?? null),
  };
}

export type PollPill =
  /** «до пт, 18:00»; `overdue` while the server has not closed it yet. */
  | { kind: "due"; at: Date; overdue: boolean }
  /** «Закрыт». */
  | { kind: "closed" };

export type PollRemindState =
  | { kind: "hidden" }
  /** «Напомнить · k». */
  | { kind: "ready"; count: number }
  /** «Напомнили · повторно через …». */
  | { kind: "cooldown"; until: Date; count: number }
  /** «Все ответили». */
  | { kind: "allAnswered" };

export type PollOptionView = {
  index: number;
  label: string;
  /** The reader's choice: the check mark (the device's memory in an anonymous poll). */
  chosen: boolean;
  /** With results only. */
  count: number | null;
  percent: number | null;
  /** A closed poll's leader, highlighted. */
  winner: boolean;
};

/**
 * How a tap on an option works: «instant» votes at once (one answer, or a
 * change in an ordinary poll with several answers — an empty choice
 * retracts); «select» ticks locally and «Голосовать» sends (several answers
 * before the first vote); «none» — no voting.
 */
export type PollVoteMode = "instant" | "select" | "none";

export type PollView = {
  question: string;
  anonymous: boolean;
  multiple: boolean;
  open: boolean;
  closedReason: MessagePoll["closed_reason"];
  dueAt: Date | null;
  pill: PollPill | null;
  /** The reader wrote the poll. */
  isAuthor: boolean;
  /**
   * No viewer is known yet (the message came by realtime): the card shows a
   * guess and the client should read getPoll while it is on screen.
   */
  viewerMissing: boolean;
  voted: boolean;
  /** Circles (one answer) or squares (several) before the vote. */
  input: "radio" | "checkbox";
  voteMode: PollVoteMode;
  /**
   * Bars and percentages instead of circles: after the reader's vote, for
   * the author always, for everyone once closed. Never before one's vote.
   */
  showResults: boolean;
  /** Results are allowed but the counts are not here yet: read getPoll. */
  resultsLoading: boolean;
  options: PollOptionView[];
  /** «N из M ответили». */
  voterCount: number;
  memberCount: number;
  waitingCount: number;
  /** «Анонимно · голос нельзя изменить» before the vote. */
  finalVoteHint: boolean;
  /** «Отменить голос»: an ordinary open poll the reader voted in. */
  canRetract: boolean;
  /** Avatars at the options and «Кто голосовал» by option. */
  canViewVoters: boolean;
  /** «Не ответили» with names: the author or a chat admin, not anonymous. */
  canViewWaiting: boolean;
  canClose: boolean;
  remind: PollRemindState;
  /** «Итог: «Среда» — 5 из 9» of a closed poll; null before or without votes. */
  result: string | null;
  /** «изм.»: the author edited the question after sending. */
  edited: boolean;
};

/**
 * «Напомнить не ответившим» of the author: ready, waiting 2 hours after the
 * last one, hidden after five, «Все ответили» when everyone voted.
 */
export function pollRemindState(
  poll: Pick<MessagePoll, "status" | "voter_count" | "member_count">,
  viewer: Pick<PollViewer, "can_remind" | "next_remind_at"> | null,
  isAuthor: boolean,
  now: Date,
): PollRemindState {
  if (!isAuthor || !viewer || poll.status !== "open") return { kind: "hidden" };
  const waiting = Math.max(0, poll.member_count - poll.voter_count);
  if (waiting === 0) return { kind: "allAnswered" };
  if (viewer.can_remind) return { kind: "ready", count: waiting };
  const until = viewer.next_remind_at ? Date.parse(viewer.next_remind_at) : NaN;
  if (Number.isFinite(until) && until > now.getTime())
    return { kind: "cooldown", until: new Date(until), count: waiting };
  return { kind: "hidden" };
}

/**
 * Everything the poll card shows. `anonChoice` is the reader's own choice
 * in an anonymous poll as this device remembers it (anonChoiceStore); the
 * server never has it. Null for a message that is not a poll.
 */
export function pollView(
  message: Pick<Message, "actor_id" | "edited_at" | "poll">,
  viewer: PollViewer | null | undefined,
  context: {
    selfID: string;
    now: Date;
    locale: CalendarLocale;
    anonChoice?: readonly number[] | null;
  },
): PollView | null {
  const poll = message.poll;
  if (!poll) return null;
  const { now, locale } = context;
  const isAuthor = message.actor_id === context.selfID;
  const current = viewer ?? pollViewerGuess(poll, isAuthor);
  const open = poll.status === "open";
  const dueAt = poll.due_at ? new Date(poll.due_at) : null;
  const counts = open
    ? current.can_view_results
      ? current.counts
      : null
    : (poll.final_counts ?? current.counts);
  const showResults = current.can_view_results || !open;
  const percents = counts ? pollPercents(counts) : null;
  const winner = !open ? pollWinner(counts) : null;
  const chosen = new Set(
    poll.anonymous
      ? current.voted
        ? (context.anonChoice ?? [])
        : []
      : (current.my_options ?? []),
  );
  const voteMode: PollVoteMode = !current.can_vote
    ? "none"
    : !poll.multiple
      ? "instant"
      : current.voted && !poll.anonymous
        ? "instant"
        : "select";
  return {
    question: poll.question,
    anonymous: poll.anonymous,
    multiple: poll.multiple,
    open,
    closedReason: poll.closed_reason ?? null,
    dueAt,
    pill: !open
      ? { kind: "closed" }
      : dueAt
        ? { kind: "due", at: dueAt, overdue: dueAt.getTime() <= now.getTime() }
        : null,
    isAuthor,
    viewerMissing: !viewer,
    voted: current.voted,
    input: poll.multiple ? "checkbox" : "radio",
    voteMode,
    showResults,
    resultsLoading: showResults && !counts,
    options: poll.options.map((label, index) => ({
      index,
      label,
      chosen: chosen.has(index),
      count: counts ? (counts[index] ?? 0) : null,
      percent: percents ? (percents[index] ?? 0) : null,
      winner: Boolean(winner?.indexes.includes(index)),
    })),
    voterCount: poll.voter_count,
    memberCount: poll.member_count,
    waitingCount: Math.max(0, poll.member_count - poll.voter_count),
    finalVoteHint: poll.anonymous && open && !current.voted && current.can_vote,
    canRetract: open && !poll.anonymous && current.voted && current.can_change,
    canViewVoters: !poll.anonymous && (current.can_view_voters || !open),
    canViewWaiting: !poll.anonymous && current.can_view_waiting,
    canClose: open && current.can_close,
    remind: pollRemindState(poll, current, isAuthor, now),
    result: !open ? pollResultText(poll, counts, locale) : null,
    edited: Boolean(message.edited_at),
  };
}

/**
 * A tap on an option in «select» mode or in an ordinary poll with several
 * answers: the option is added or removed. One answer: only that option.
 */
export function togglePollChoice(
  selection: readonly number[],
  index: number,
  multiple: boolean,
): number[] {
  if (!multiple) return [index];
  const next = selection.includes(index)
    ? selection.filter((item) => item !== index)
    : [...selection, index];
  return next.sort((a, b) => a - b);
}

export type PollVoterTab = {
  filter: `option:${number}` | "waiting";
  label: string;
  count: number;
};

/**
 * Tabs of «Кто голосовал»: one per option (when names may be seen), then
 * «Не ответили · k» for the author and chat admins. Empty in an anonymous
 * poll: nobody sees names there.
 */
export function pollVoterTabs(
  poll: Pick<
    MessagePoll,
    "options" | "anonymous" | "voter_count" | "member_count"
  >,
  viewer: Pick<
    PollViewer,
    "can_view_voters" | "can_view_waiting" | "counts"
  > | null,
  locale: CalendarLocale,
): PollVoterTab[] {
  if (!viewer || poll.anonymous) return [];
  const tabs: PollVoterTab[] = [];
  if (viewer.can_view_voters)
    poll.options.forEach((label, index) =>
      tabs.push({
        filter: `option:${index}`,
        label,
        count: viewer.counts?.[index] ?? 0,
      }),
    );
  if (viewer.can_view_waiting) {
    const count = Math.max(0, poll.member_count - poll.voter_count);
    tabs.push({
      filter: "waiting",
      label: pollWaitingText(count, locale),
      count,
    });
  }
  return tabs;
}

/** The author's viewer after remindPoll: the button waits until next_remind_at. */
export function afterPollRemind(
  viewer: PollViewer,
  result: PollRemindResult,
): PollViewer {
  return {
    ...viewer,
    can_remind: false,
    next_remind_at: result.next_remind_at,
  };
}

// ---------------------------------------------------------------------------
// The cache and realtime

/** The reader's state of one poll and the poll version it is as of. */
export type PollViewerEntry = { viewer: PollViewer; version: number };

export type PollViewers = Record<string, PollViewerEntry>;

export type PollCacheEntry = {
  poll: MessagePoll | null;
  viewer: PollViewerEntry | null;
};

/** Puts a viewer read by REST into the map; the fresher one wins. */
export function mergePollViewer(
  current: PollViewerEntry | undefined,
  viewer: PollViewer,
  version: number,
): PollViewerEntry {
  if (current && current.version > version) return current;
  return { viewer, version };
}

/** The fresher of two polls by version; the first on a tie. */
export function newerPoll(
  current: MessagePoll | null | undefined,
  incoming: MessagePoll | null | undefined,
): MessagePoll | null {
  if (!current) return incoming ?? null;
  if (!incoming) return current;
  return incoming.version > current.version ? incoming : current;
}

export type PollEventType =
  | "poll.updated"
  | "poll.vote.updated"
  | "poll.notified";

export function isPollEvent(type: string): type is PollEventType {
  return (
    type === "poll.updated" ||
    type === "poll.vote.updated" ||
    type === "poll.notified"
  );
}

/** The reader's own vote: options (empty — retracted), or only «voted» when anonymous. */
export type PollVoteUpdate = {
  message_id: string;
  chat_id: string;
  version: number;
  options: number[] | null;
};

export type PollEvent =
  | { type: "poll.updated"; data: PollUpdatedEvent; occurredAt: string }
  | { type: "poll.vote.updated"; data: PollVoteUpdate; occurredAt: string }
  | { type: "poll.notified"; data: PollNotifiedEvent; occurredAt: string };

const isString = (value: unknown): value is string => typeof value === "string";
const isCount = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 0;
const isCounts = (value: unknown): value is number[] =>
  Array.isArray(value) && value.every(isCount);

/** A MessagePoll as the client needs it; anything else is null. */
export function parseMessagePoll(value: unknown): MessagePoll | null {
  if (!value || typeof value !== "object") return null;
  const poll = value as Record<string, unknown>;
  if (
    !isString(poll.question) ||
    !Array.isArray(poll.options) ||
    !poll.options.every(isString) ||
    typeof poll.multiple !== "boolean" ||
    typeof poll.anonymous !== "boolean" ||
    (poll.status !== "open" && poll.status !== "closed") ||
    !isCount(poll.voter_count) ||
    !isCount(poll.member_count) ||
    !isCount(poll.version) ||
    !(poll.final_counts == null || isCounts(poll.final_counts))
  )
    return null;
  return value as MessagePoll;
}

const closedReasons: ReadonlySet<unknown> = new Set([
  "author",
  "moderator",
  "expired",
  "message_deleted",
  null,
]);

/**
 * A poll.* event when its data has the expected shape, null otherwise: the
 * log is replayed to new devices and may come from a newer server, so it is
 * checked rather than trusted.
 */
export function parsePollEvent(event: DurableEvent): PollEvent | null {
  const value = event.data as Record<string, unknown> | null;
  if (!value || typeof value !== "object") return null;
  if (!isString(value.message_id) || !isString(value.chat_id)) return null;
  const ids = { message_id: value.message_id, chat_id: value.chat_id };
  const occurredAt = event.occurred_at;
  if (event.type === "poll.updated") {
    if (
      (value.status !== "open" && value.status !== "closed") ||
      !closedReasons.has(value.closed_reason ?? null) ||
      !isCount(value.voter_count) ||
      !isCount(value.member_count) ||
      !isCount(value.version) ||
      !(value.final_counts == null || isCounts(value.final_counts))
    )
      return null;
    return {
      type: event.type,
      occurredAt,
      data: {
        ...ids,
        status: value.status,
        closed_reason: (value.closed_reason ??
          null) as PollUpdatedEvent["closed_reason"],
        voter_count: value.voter_count,
        member_count: value.member_count,
        // An open poll never shows counts, whatever a server sent.
        final_counts:
          value.status === "closed" && isCounts(value.final_counts)
            ? value.final_counts
            : null,
        version: value.version,
      },
    };
  }
  if (event.type === "poll.vote.updated") {
    if (!isCount(value.version)) return null;
    if (isCounts(value.options))
      return {
        type: event.type,
        occurredAt,
        data: { ...ids, version: value.version, options: value.options },
      };
    if (value.voted === true)
      return {
        type: event.type,
        occurredAt,
        data: { ...ids, version: value.version, options: null },
      };
    return null;
  }
  if (event.type === "poll.notified") {
    if (value.kind !== "reminded" && value.kind !== "closed_expired")
      return null;
    return { type: event.type, occurredAt, data: { ...ids, kind: value.kind } };
  }
  return null;
}

/** The viewer of a poll once it is closed: no voting, results for all. */
function closedViewer(
  viewer: PollViewer,
  poll: Pick<MessagePoll, "anonymous" | "final_counts">,
): PollViewer {
  return {
    ...viewer,
    can_vote: false,
    can_change: false,
    can_close: false,
    can_remind: false,
    next_remind_at: null,
    can_view_results: true,
    can_view_voters: !poll.anonymous,
    counts: poll.final_counts ?? viewer.counts,
  };
}

export type PollReduction = PollCacheEntry & {
  changed: boolean;
  /**
   * The counts the reader may see are behind: read getPoll (after
   * pollReloadDelayMs, only while the card is on screen).
   */
  reload: boolean;
};

/**
 * Applies a poll event to the cache. Events older than what is cached are
 * dropped, so they may come in any order:
 *
 * - poll.updated puts in the counters every member sees (N, M, status, the
 *   final counts of a closed poll). A reader who sees results gets `reload`:
 *   the counts per option are never in frames.
 * - poll.vote.updated is the reader's own vote from any device: the viewer
 *   says voted (or not, after «Отменить голос»); the counts come by reload.
 *   It does not move MessagePoll.version — poll.updated of the same change
 *   does.
 * - poll.notified changes nothing in the card (push, toast, «Ждут вас»).
 *
 * `isAuthor` tells whether results stay visible after retracting a vote.
 */
export function reducePoll(
  entry: PollCacheEntry,
  event: PollEvent,
  context: { isAuthor?: boolean } = {},
): PollReduction {
  const same: PollReduction = { ...entry, changed: false, reload: false };
  const poll = entry.poll;
  if (event.type === "poll.notified") return same;
  if (event.type === "poll.updated") {
    const data = event.data;
    if (!poll || data.version <= poll.version) return same;
    const closed = data.status === "closed";
    const next: MessagePoll = {
      ...poll,
      status: data.status,
      closed_reason: closed ? (data.closed_reason ?? poll.closed_reason) : null,
      closed_at: closed ? (poll.closed_at ?? event.occurredAt) : null,
      voter_count: data.voter_count,
      member_count: data.member_count,
      final_counts: closed ? (data.final_counts ?? poll.final_counts) : null,
      version: data.version,
    };
    let viewer = entry.viewer;
    let reload = false;
    if (viewer && viewer.version < data.version) {
      if (closed) {
        viewer = {
          viewer: closedViewer(viewer.viewer, next),
          version: data.version,
        };
        reload = !next.final_counts;
      } else reload = viewer.viewer.can_view_results;
    }
    return { poll: next, viewer, changed: true, reload };
  }
  const data = event.data;
  const current = entry.viewer;
  if (current && current.version >= data.version) return same;
  const base =
    current?.viewer ??
    (poll ? pollViewerGuess(poll, Boolean(context.isAuthor)) : null);
  if (!base) return same;
  const open = poll ? poll.status === "open" : true;
  const anonymous = poll?.anonymous ?? data.options === null;
  const retracted = data.options !== null && data.options.length === 0;
  let viewer: PollViewer;
  if (retracted) {
    const results = !open || Boolean(context.isAuthor);
    viewer = {
      ...base,
      voted: false,
      my_options: null,
      can_vote: open,
      can_change: false,
      can_view_results: results,
      can_view_voters: results && !anonymous,
      counts: results ? base.counts : null,
    };
  } else {
    viewer = {
      ...base,
      voted: true,
      my_options: anonymous ? null : data.options,
      can_vote: open && !anonymous,
      can_change: open && !anonymous,
      can_view_results: true,
      can_view_voters: !anonymous,
    };
  }
  return {
    poll,
    viewer: { viewer, version: data.version },
    changed: true,
    reload: viewer.can_view_results,
  };
}

/** Where one poll is read and written: the store or a list cache. */
export type PollCacheAccess = {
  read(): PollCacheEntry;
  /** Writes as it is, older or not: an optimistic entry or a rollback. */
  write(entry: PollCacheEntry): void;
};

/**
 * The cache right after a tap on «Голосовать», before the server replies:
 * the vote counted (N + 1 when it is the first), the counts moved when the
 * reader already saw them, results open. The versions stay: the server's
 * reply comes with higher ones. Null when the reader may not vote.
 */
export function optimisticPollVote(
  entry: PollCacheEntry,
  options: readonly number[],
  context: { isAuthor?: boolean } = {},
): PollCacheEntry | null {
  const poll = entry.poll;
  if (!poll || poll.status !== "open" || !options.length) return null;
  const viewer =
    entry.viewer?.viewer ?? pollViewerGuess(poll, Boolean(context.isAuthor));
  if (!viewer.can_vote) return null;
  if (!poll.multiple && options.length !== 1) return null;
  if (options.some((index) => index < 0 || index >= poll.options.length))
    return null;
  const chosen = [...new Set(options)].sort((a, b) => a - b);
  let counts = viewer.counts ? [...viewer.counts] : null;
  if (counts) {
    for (const index of viewer.my_options ?? [])
      counts[index] = Math.max(0, (counts[index] ?? 0) - 1);
    for (const index of chosen) counts[index] = (counts[index] ?? 0) + 1;
  } else if (!viewer.voted && poll.voter_count === 0)
    // The first vote: the counts are known without the server.
    counts = poll.options.map((_, index) => (chosen.includes(index) ? 1 : 0));
  return {
    poll: viewer.voted ? poll : { ...poll, voter_count: poll.voter_count + 1 },
    viewer: {
      version: entry.viewer?.version ?? poll.version,
      viewer: {
        ...viewer,
        voted: true,
        my_options: poll.anonymous ? null : chosen,
        can_vote: !poll.anonymous,
        can_change: !poll.anonymous,
        can_view_results: true,
        can_view_voters: !poll.anonymous,
        counts,
      },
    },
  };
}

/** «Отменить голос» before the server replies; null when not allowed. */
export function optimisticPollRetract(
  entry: PollCacheEntry,
  context: { isAuthor?: boolean } = {},
): PollCacheEntry | null {
  const poll = entry.poll;
  const viewer = entry.viewer?.viewer;
  if (!poll || !viewer || poll.anonymous || poll.status !== "open") return null;
  if (!viewer.voted || !viewer.can_change) return null;
  const results = Boolean(context.isAuthor);
  let counts = viewer.counts ? [...viewer.counts] : null;
  if (counts)
    for (const index of viewer.my_options ?? [])
      counts[index] = Math.max(0, (counts[index] ?? 0) - 1);
  return {
    poll: { ...poll, voter_count: Math.max(0, poll.voter_count - 1) },
    viewer: {
      version: entry.viewer!.version,
      viewer: {
        ...viewer,
        voted: false,
        my_options: null,
        can_vote: true,
        can_change: false,
        can_view_results: results,
        can_view_voters: results,
        counts: results ? counts : null,
      },
    },
  };
}

/** Writes a REST state (getPoll, votePoll, closePoll) when it is not older. */
export function writePollState(cache: PollCacheAccess, state: PollState): void {
  const current = cache.read();
  const poll = newerPoll(current.poll, state.poll);
  const viewer = mergePollViewer(
    current.viewer ?? undefined,
    state.viewer,
    state.poll.version,
  );
  cache.write({
    poll,
    viewer:
      poll && poll.status === "closed" && viewer.viewer.can_vote
        ? { ...viewer, viewer: closedViewer(viewer.viewer, poll) }
        : viewer,
  });
}

/** Codes after which the cached poll is surely behind: read it again. */
const reloadCodes: ReadonlySet<string> = new Set([
  "version_conflict",
  "poll_closed",
  "poll_vote_final",
  "chat_archived",
]);

/**
 * Runs a vote, a retraction or a closing optimistically: writes
 * `optimistic` at once, sends, then puts the server's state in (when not
 * older than the cache). On an error the previous entry comes back unless
 * something newer arrived meanwhile; a conflict, a closed poll or a final
 * vote reads the poll again with `reload` when given. The error is thrown
 * again for the toast (pollErrorKind).
 */
export async function performPollAction(
  cache: PollCacheAccess,
  optimistic: PollCacheEntry | null,
  send: () => Promise<PollState | void>,
  reload?: () => Promise<PollState>,
): Promise<PollState | null> {
  const previous = cache.read();
  if (optimistic) cache.write(optimistic);
  try {
    const result = await send();
    if (result) writePollState(cache, result);
    return result ?? null;
  } catch (error) {
    const current = cache.read();
    // Store reads build a new entry; the parts are the ones written.
    if (
      optimistic &&
      current.poll === optimistic.poll &&
      current.viewer === optimistic.viewer
    )
      cache.write(previous);
    if (
      reload &&
      error instanceof APIError &&
      error.code &&
      reloadCodes.has(error.code)
    )
      await reload()
        .then((state) => writePollState(cache, state))
        .catch(() => {
          // The rollback stands; the next load fixes it.
        });
    throw error;
  }
}

// ---------------------------------------------------------------------------
// «Ждут вас»

/**
 * A poll waits for the reader (decision 14): open, with a due date, the
 * reader may vote and has not. Polls without a due date never wait.
 */
export function isPollWaiting(
  poll: Pick<MessagePoll, "status" | "due_at"> | null | undefined,
  viewer: Pick<PollViewer, "voted" | "can_vote"> | null | undefined,
): boolean {
  return Boolean(
    poll &&
      poll.status === "open" &&
      poll.due_at &&
      viewer &&
      !viewer.voted &&
      viewer.can_vote,
  );
}

/** «Горит»: waiting and due within 24 hours or overdue — what the badge counts. */
export function isPollHot(
  poll: Pick<MessagePoll, "status" | "due_at"> | null | undefined,
  viewer: Pick<PollViewer, "voted" | "can_vote"> | null | undefined,
  now: Date,
): boolean {
  if (!isPollWaiting(poll, viewer)) return false;
  return Date.parse(poll!.due_at!) - now.getTime() < pollHotWindowMs;
}

// ---------------------------------------------------------------------------
// The device's memory of an anonymous choice

/** Key-value storage of the device: localStorage, AsyncStorage, MMKV. */
export type PollChoiceStorage = {
  getItem(key: string): string | null | Promise<string | null>;
  setItem(key: string, value: string): void | Promise<void>;
  removeItem(key: string): void | Promise<void>;
};

export type AnonChoiceStore = {
  /** The choice this device made in the poll; null when unknown. */
  get(userID: string, messageID: string): Promise<number[] | null>;
  /** The choice already read, without waiting; undefined when not read yet. */
  peek(userID: string, messageID: string): number[] | null | undefined;
  set(
    userID: string,
    messageID: string,
    options: readonly number[],
  ): Promise<void>;
  remove(userID: string, messageID: string): Promise<void>;
};

/** The storage key: the person and the poll, so accounts on one device stay apart. */
export function anonChoiceKey(userID: string, messageID: string): string {
  return `coma.poll.anon.${userID}.${messageID}`;
}

/**
 * Remembers the reader's choice in anonymous polls on this device only
 * (decision 5): the server stores counts and who voted, never who chose
 * what, so the check mark after a vote comes from here. Another device of
 * the same person shows «Вы проголосовали» without a mark.
 */
export function createAnonChoiceStore(
  storage: PollChoiceStorage,
): AnonChoiceStore {
  const cache = new Map<string, number[] | null>();
  const parse = (raw: string | null): number[] | null => {
    if (!raw) return null;
    try {
      const value: unknown = JSON.parse(raw);
      return isCounts(value) && value.length ? value : null;
    } catch {
      return null;
    }
  };
  return {
    async get(userID, messageID) {
      const key = anonChoiceKey(userID, messageID);
      if (cache.has(key)) return cache.get(key) ?? null;
      let value: number[] | null = null;
      try {
        value = parse(await storage.getItem(key));
      } catch {
        value = null;
      }
      cache.set(key, value);
      return value;
    },
    peek(userID, messageID) {
      return cache.get(anonChoiceKey(userID, messageID));
    },
    async set(userID, messageID, options) {
      const key = anonChoiceKey(userID, messageID);
      const value = [...new Set(options)].sort((a, b) => a - b);
      cache.set(key, value);
      try {
        await storage.setItem(key, JSON.stringify(value));
      } catch {
        // Private mode or a full disk: the mark lives until the app closes.
      }
    },
    async remove(userID, messageID) {
      const key = anonChoiceKey(userID, messageID);
      cache.set(key, null);
      try {
        await storage.removeItem(key);
      } catch {
        // Nothing to do.
      }
    },
  };
}

/** Storage in memory, for tests and devices without a disk. */
export function memoryPollChoiceStorage(): PollChoiceStorage {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => void values.set(key, value),
    removeItem: (key) => void values.delete(key),
  };
}

// ---------------------------------------------------------------------------
// Cache keys and errors

/** TanStack Query keys; they always carry the reader's id. */
export const pollKeys = {
  all: (userID: string) => ["polls", userID] as const,
  poll: (userID: string, messageID: string) =>
    ["polls", userID, "poll", messageID] as const,
  voters: (userID: string, messageID: string, filter: PollVoterTab["filter"]) =>
    ["polls", userID, "voters", messageID, filter] as const,
  waiting: (userID: string) => ["polls", userID, "waiting"] as const,
};

export type PollErrorKind =
  | "invalid"
  | "notMember"
  | "forbidden"
  | "gone"
  /** The poll closed meanwhile: the card is read again. */
  | "closed"
  /** A vote in an anonymous poll cannot be changed. */
  | "voteFinal"
  /** Someone voted meanwhile (expected_version): the card is read again. */
  | "conflict"
  /** 100 open polls in the chat or 200 of the author. */
  | "limit"
  | "archived"
  /** «Напомнить» too soon; see APIError.retryAfterSeconds. */
  | "remindTooSoon"
  | "rateLimited"
  /** The server has no polls yet. */
  | "unavailable"
  | "network"
  | "other";

/** What went wrong with a poll call, for the toast. */
export function pollErrorKind(error: unknown): PollErrorKind {
  if (!(error instanceof APIError)) return "network";
  switch (error.code) {
    case "poll_invalid":
    case "validation_failed":
      return "invalid";
    case "not_member":
      return "notMember";
    case "forbidden":
      return "forbidden";
    case "poll_not_found":
    case "message_not_found":
      return "gone";
    case "poll_closed":
      return "closed";
    case "poll_vote_final":
      return "voteFinal";
    case "version_conflict":
      return "conflict";
    case "poll_limit_reached":
      return "limit";
    case "chat_archived":
      return "archived";
    case "poll_remind_too_soon":
      return "remindTooSoon";
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

/** The field the server named in 422 poll_invalid (`details.field`). */
export function pollInvalidField(error: unknown): string | null {
  if (!(error instanceof APIError) || error.code !== "poll_invalid")
    return null;
  return typeof error.details.field === "string" ? error.details.field : null;
}
