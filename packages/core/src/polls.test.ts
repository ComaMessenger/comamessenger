import { afterAll, describe, expect, it } from "vitest";
import { APIError } from "./api";
import {
  addPollOption,
  afterPollRemind,
  anonChoiceKey,
  canAddPollOption,
  createAnonChoiceStore,
  emptyPollDraft,
  isPollHot,
  isPollWaiting,
  memoryPollChoiceStorage,
  movePollOption,
  optimisticPollRetract,
  optimisticPollVote,
  parsePollDraft,
  parsePollEvent,
  performPollAction,
  pollDraftProblem,
  pollDuePresets,
  pollErrorKind,
  pollInvalidField,
  pollKeys,
  pollPercents,
  pollRemindState,
  pollResultText,
  pollSignature,
  pollView,
  pollVoterTabs,
  pollVotesText,
  pollWinner,
  reducePoll,
  removePollOption,
  serializePollDraft,
  toCreatePollInput,
  togglePollChoice,
  type PollCacheEntry,
  type PollDraft,
  type PollEvent,
} from "./polls";
import { makePoll, makePollMessage, makePollViewer } from "./pollFixtures";
import type { DurableEvent, PollState } from "./types";

const previousTZ = process.env.TZ;
process.env.TZ = "Europe/Berlin";
afterAll(() => {
  process.env.TZ = previousTZ;
});

// Tuesday 17 November 2026, 10:00 in Berlin.
const now = new Date("2026-11-17T09:00:00Z");
const ctx = { selfID: "me", now, locale: "ru" as const };

function draft(overrides: Partial<PollDraft> = {}): PollDraft {
  return {
    ...emptyPollDraft(),
    question: "Когда удобнее субботник?",
    options: ["Среда", "Четверг"],
    ...overrides,
  };
}

function event(type: string, data: Record<string, unknown>): PollEvent {
  const parsed = parsePollEvent({
    op: "event",
    seq: 1,
    type,
    occurred_at: "2026-11-17T09:00:00Z",
    actor_id: null,
    subject_id: String(data.message_id),
    data,
  } as DurableEvent);
  if (!parsed) throw new Error(`bad event ${type}`);
  return parsed;
}

const updated = (overrides: Record<string, unknown> = {}) =>
  event("poll.updated", {
    message_id: "p1",
    chat_id: "c1",
    status: "open",
    closed_reason: null,
    voter_count: 1,
    member_count: 9,
    final_counts: null,
    version: 2,
    ...overrides,
  });

describe("the poll form", () => {
  it("starts with two empty options and grows to ten", () => {
    let value = emptyPollDraft();
    expect(value.options).toEqual(["", ""]);
    for (let i = 0; i < 12; i += 1) value = addPollOption(value);
    expect(value.options).toHaveLength(10);
    expect(canAddPollOption(value)).toBe(false);
  });

  it("keeps two rows when one is removed and moves rows by the handle", () => {
    expect(removePollOption(draft(), 0).options).toEqual(["", "Четверг"]);
    const three = draft({ options: ["А", "Б", "В"] });
    expect(removePollOption(three, 1).options).toEqual(["А", "В"]);
    expect(movePollOption(three, 0, 2).options).toEqual(["Б", "В", "А"]);
    expect(movePollOption(three, 0, 5)).toBe(three);
  });

  it("names the first problem in the order of the fields", () => {
    expect(pollDraftProblem(draft({ question: "  " }), now)).toEqual({
      field: "question",
      reason: "empty",
    });
    expect(pollDraftProblem(draft({ question: "в".repeat(301) }), now)).toEqual(
      { field: "question", reason: "tooLong" },
    );
    expect(pollDraftProblem(draft({ options: ["Среда", " "] }), now)).toEqual({
      field: "options",
      reason: "tooFew",
    });
    expect(
      pollDraftProblem(draft({ options: ["Среда", "", "среда"] }), now),
    ).toEqual({ field: "options", reason: "duplicate", index: 2 });
    expect(
      pollDraftProblem(draft({ options: ["Среда", "ч".repeat(101)] }), now),
    ).toEqual({ field: "options", reason: "tooLong", index: 1 });
    expect(
      pollDraftProblem(
        draft({ dueAt: new Date(now.getTime() + 5 * 60_000) }),
        now,
      ),
    ).toEqual({ field: "dueAt", reason: "past" });
    expect(
      pollDraftProblem(
        draft({ dueAt: new Date(now.getTime() + 91 * 86_400_000) }),
        now,
      ),
    ).toEqual({ field: "dueAt", reason: "tooFar" });
    expect(pollDraftProblem(draft(), now)).toBeNull();
  });

  it("sends trimmed options without blanks and a stable signature", () => {
    const value = draft({
      question: " Когда? ",
      options: [" Среда ", "", "Четверг"],
      multiple: true,
      dueAt: new Date("2026-11-20T17:00:00Z"),
    });
    const input = toCreatePollInput(value, "cm1");
    expect(input).toEqual({
      client_msg_id: "cm1",
      question: "Когда?",
      options: ["Среда", "Четверг"],
      multiple: true,
      anonymous: false,
      due_at: "2026-11-20T17:00:00.000Z",
    });
    expect(pollSignature(input)).toBe(
      pollSignature({ ...input, client_msg_id: "other" }),
    );
    expect("due_at" in toCreatePollInput(draft(), "x")).toBe(false);
  });

  it("keeps a draft on the device and drops a due date that passed", () => {
    const value = draft({ dueAt: new Date("2026-11-17T09:30:00Z") });
    const raw = serializePollDraft(value);
    expect(parsePollDraft(raw, now)).toEqual(value);
    expect(parsePollDraft(raw, new Date("2026-11-18T00:00:00Z"))?.dueAt).toBe(
      null,
    );
    expect(parsePollDraft("{", now)).toBeNull();
    expect(parsePollDraft(null, now)).toBeNull();
  });

  it("offers the request chips within the poll limits", () => {
    const ids = pollDuePresets(now).map((preset) => preset.id);
    expect(ids).toEqual(["today", "tomorrow", "friday"]);
    // At 17:55 «сегодня, 18:00» is too close.
    expect(
      pollDuePresets(new Date("2026-11-17T16:55:00Z")).map((p) => p.id),
    ).not.toContain("today");
  });
});

describe("pollPercents", () => {
  it("adds up to 100 by the largest remainder", () => {
    expect(pollPercents([1, 1, 1])).toEqual([34, 33, 33]);
    expect(pollPercents([2, 1])).toEqual([67, 33]);
    expect(pollPercents([5, 3, 1])).toEqual([56, 33, 11]);
    for (const counts of [
      [1, 1, 1, 1, 1, 1, 1],
      [7, 3, 3, 3],
      [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
    ])
      expect(pollPercents(counts).reduce((a, b) => a + b, 0)).toBe(100);
  });

  it("gives ties the same share but for one point, earlier first", () => {
    expect(pollPercents([1, 1, 1, 0])).toEqual([34, 33, 33, 0]);
    expect(pollPercents([0, 3, 3])).toEqual([0, 50, 50]);
  });

  it("is all zero without votes and ignores broken values", () => {
    expect(pollPercents([0, 0])).toEqual([0, 0]);
    expect(pollPercents([])).toEqual([]);
    expect(pollPercents([Number.NaN, -1, 2])).toEqual([0, 0, 100]);
  });
});

describe("the winner and the result line", () => {
  it("names the leader, or several on a tie", () => {
    expect(pollWinner([5, 3, 1])).toEqual({ indexes: [0], votes: 5 });
    expect(pollWinner([3, 1, 3])).toEqual({ indexes: [0, 2], votes: 3 });
    expect(pollWinner([0, 0])).toBeNull();
    expect(pollWinner(null)).toBeNull();
  });

  it("says «Итог: «Среда» — 5 из 9»", () => {
    const poll = makePoll({ voter_count: 9 });
    expect(pollResultText(poll, [5, 3, 1], "ru")).toBe(
      "Итог: «Среда» — 5 из 9",
    );
    expect(pollResultText(poll, [3, 3, 3], "ru")).toBe(
      "Итог: «Среда», «Четверг», «Пятница» — по 3 из 9",
    );
    expect(pollResultText(poll, [5, 3, 1], "en")).toBe(
      "Result: “Среда” — 5 of 9",
    );
    expect(pollResultText(poll, [0, 0, 0], "ru")).toBeNull();
    expect(pollVotesText(1, "ru")).toBe("1 голос");
    expect(pollVotesText(3, "ru")).toBe("3 голоса");
    expect(pollVotesText(11, "ru")).toBe("11 голосов");
  });
});

describe("pollView", () => {
  const message = (overrides = {}, poll = makePoll(overrides)) =>
    makePollMessage("p1", poll);

  it("hides results before the vote: only «N из M»", () => {
    const view = pollView(
      message({ voter_count: 4 }),
      makePollViewer({ counts: [3, 1, 0] }),
      ctx,
    )!;
    expect(view.showResults).toBe(false);
    expect(view.options.every((option) => option.percent === null)).toBe(true);
    expect([view.voterCount, view.memberCount, view.waitingCount]).toEqual([
      4, 9, 5,
    ]);
    expect(view.voteMode).toBe("instant");
    expect(view.input).toBe("radio");
  });

  it("shows bars, percentages and the reader's choice after the vote", () => {
    const view = pollView(
      message({ voter_count: 4 }),
      makePollViewer({
        voted: true,
        my_options: [1],
        can_change: true,
        can_view_results: true,
        can_view_voters: true,
        counts: [3, 1, 0],
      }),
      ctx,
    )!;
    expect(view.showResults).toBe(true);
    expect(view.options.map((o) => [o.count, o.percent, o.chosen])).toEqual([
      [3, 75, false],
      [1, 25, true],
      [0, 0, false],
    ]);
    expect(view.canRetract).toBe(true);
    expect(view.canViewVoters).toBe(true);
  });

  it("shows the author the results always and «Напомнить»", () => {
    const view = pollView(
      makePollMessage("p1", makePoll({ voter_count: 2 }), { actor_id: "me" }),
      makePollViewer({
        can_view_results: true,
        can_view_voters: true,
        can_view_waiting: true,
        can_close: true,
        can_remind: true,
        counts: [2, 0, 0],
      }),
      ctx,
    )!;
    expect(view.isAuthor).toBe(true);
    expect(view.showResults).toBe(true);
    expect(view.canClose).toBe(true);
    expect(view.remind).toEqual({ kind: "ready", count: 6 }); // the author has not voted and is never reminded;
    expect(view.canViewWaiting).toBe(true);
  });

  it("warns before an anonymous vote and marks the choice from the device", () => {
    const anonymous = message({ anonymous: true });
    const before = pollView(anonymous, makePollViewer(), ctx)!;
    expect(before.finalVoteHint).toBe(true);
    const after = pollView(
      anonymous,
      makePollViewer({
        voted: true,
        can_vote: false,
        can_view_results: true,
        counts: [1, 0, 0],
      }),
      { ...ctx, anonChoice: [0] },
    )!;
    expect(after.finalVoteHint).toBe(false);
    expect(after.canRetract).toBe(false);
    expect(after.canViewVoters).toBe(false);
    expect(after.voteMode).toBe("none");
    expect(after.options[0]!.chosen).toBe(true);
    // Another device: «Вы проголосовали» without a mark.
    const elsewhere = pollView(
      anonymous,
      makePollViewer({ voted: true, can_vote: false, can_view_results: true }),
      ctx,
    )!;
    expect(elsewhere.options.some((option) => option.chosen)).toBe(false);
    expect(elsewhere.resultsLoading).toBe(true);
  });

  it("shows everyone the result of a closed poll with the winner", () => {
    const view = pollView(
      message({
        status: "closed",
        closed_reason: "expired",
        voter_count: 9,
        final_counts: [5, 3, 1],
      }),
      makePollViewer({ can_vote: false }),
      ctx,
    )!;
    expect(view.pill).toEqual({ kind: "closed" });
    expect(view.showResults).toBe(true);
    expect(view.options.map((option) => option.winner)).toEqual([
      true,
      false,
      false,
    ]);
    expect(view.result).toBe("Итог: «Среда» — 5 из 9");
    expect(view.canViewVoters).toBe(true);
  });

  it("chooses how a tap votes", () => {
    const multiple = message({ multiple: true });
    expect(pollView(multiple, makePollViewer(), ctx)!.voteMode).toBe("select");
    expect(
      pollView(
        multiple,
        makePollViewer({ voted: true, can_change: true, my_options: [0] }),
        ctx,
      )!.voteMode,
    ).toBe("instant");
    expect(togglePollChoice([0], 2, true)).toEqual([0, 2]);
    expect(togglePollChoice([0, 2], 0, true)).toEqual([2]);
    expect(togglePollChoice([0], 2, false)).toEqual([2]);
  });

  it("guesses from the message until getPoll answers", () => {
    const view = pollView(
      makePollMessage("p1", makePoll(), { actor_id: "me" }),
      null,
      ctx,
    )!;
    expect(view.viewerMissing).toBe(true);
    expect(view.showResults).toBe(true);
    expect(view.resultsLoading).toBe(true);
  });

  it("shows a due pill and nothing for a message without a poll", () => {
    const due = "2026-11-20T17:00:00Z";
    expect(pollView(message({ due_at: due }), null, ctx)!.pill).toEqual({
      kind: "due",
      at: new Date(due),
      overdue: false,
    });
    expect(pollView({ actor_id: "a", edited_at: null }, null, ctx)).toBeNull();
  });
});

describe("«Напомнить» and «Кто голосовал»", () => {
  const poll = makePoll({ voter_count: 3 });

  it("waits out the cooldown, then hides after five", () => {
    const later = new Date(now.getTime() + 3600_000).toISOString();
    expect(
      pollRemindState(
        poll,
        makePollViewer({ next_remind_at: later }),
        true,
        now,
      ),
    ).toEqual({ kind: "cooldown", until: new Date(later), count: 5 });
    expect(
      pollRemindState(
        poll,
        makePollViewer({ next_remind_at: later, voted: true }),
        true,
        now,
      ),
    ).toEqual({ kind: "cooldown", until: new Date(later), count: 6 });
    // The author is the only one left: nobody to remind.
    expect(
      pollRemindState(
        makePoll({ voter_count: 8 }),
        makePollViewer({ can_remind: false }),
        true,
        now,
      ),
    ).toEqual({ kind: "allAnswered" });
    expect(pollRemindState(poll, makePollViewer(), true, now)).toEqual({
      kind: "hidden",
    });
    expect(
      pollRemindState(
        makePoll({ voter_count: 9 }),
        makePollViewer(),
        true,
        now,
      ),
    ).toEqual({ kind: "allAnswered" });
    expect(
      pollRemindState(poll, makePollViewer({ can_remind: true }), false, now),
    ).toEqual({ kind: "hidden" });
    const after = afterPollRemind(makePollViewer({ can_remind: true }), {
      reminded: 6,
      next_remind_at: later,
    });
    expect([after.can_remind, after.next_remind_at]).toEqual([false, later]);
  });

  it("lists options and «Не ответили», never in an anonymous poll", () => {
    const viewer = makePollViewer({
      can_view_voters: true,
      can_view_waiting: true,
      counts: [2, 1, 0],
    });
    expect(pollVoterTabs(poll, viewer, "ru")).toEqual([
      { filter: "option:0", label: "Среда", count: 2 },
      { filter: "option:1", label: "Четверг", count: 1 },
      { filter: "option:2", label: "Пятница", count: 0 },
      { filter: "waiting", label: "Не ответили · 6", count: 6 },
    ]);
    expect(pollVoterTabs(makePoll({ anonymous: true }), viewer, "ru")).toEqual(
      [],
    );
  });
});

describe("parsePollEvent", () => {
  it("drops counts of an open poll and broken frames", () => {
    const parsed = updated({ final_counts: [1, 0, 0] });
    expect(parsed.type === "poll.updated" && parsed.data.final_counts).toBe(
      null,
    );
    expect(
      parsePollEvent({
        op: "event",
        seq: 1,
        type: "poll.updated",
        occurred_at: "",
        actor_id: null,
        subject_id: "p1",
        data: { message_id: "p1", chat_id: "c1", status: "maybe" },
      }),
    ).toBeNull();
  });

  it("reads both shapes of poll.vote.updated", () => {
    const chosen = event("poll.vote.updated", {
      message_id: "p1",
      chat_id: "c1",
      options: [1],
      version: 3,
    });
    expect(chosen.data).toMatchObject({ options: [1], version: 3 });
    const anonymous = event("poll.vote.updated", {
      message_id: "p1",
      chat_id: "c1",
      voted: true,
      version: 3,
    });
    expect(anonymous.data).toMatchObject({ options: null });
  });
});

describe("reducePoll", () => {
  const entry = (
    poll = makePoll(),
    viewer = makePollViewer(),
    version = 1,
  ): PollCacheEntry => ({ poll, viewer: { viewer, version } });

  it("puts in newer counters and drops older events in any order", () => {
    const start = entry();
    const v3 = reducePoll(start, updated({ version: 3, voter_count: 2 }));
    expect(v3.poll!.voter_count).toBe(2);
    const late = reducePoll(v3, updated({ version: 2, voter_count: 1 }));
    expect(late.changed).toBe(false);
    expect(late.poll!.voter_count).toBe(2);
    expect(v3.reload).toBe(false);
  });

  it("asks a reader who sees results to read getPoll", () => {
    const voted = entry(
      makePoll(),
      makePollViewer({
        voted: true,
        can_view_results: true,
        counts: [1, 0, 0],
      }),
    );
    expect(reducePoll(voted, updated()).reload).toBe(true);
  });

  it("opens the final counts to everyone on closing", () => {
    const result = reducePoll(
      entry(),
      updated({
        status: "closed",
        closed_reason: "author",
        final_counts: [5, 3, 1],
        voter_count: 9,
      }),
    );
    expect(result.poll).toMatchObject({
      status: "closed",
      final_counts: [5, 3, 1],
      closed_at: "2026-11-17T09:00:00Z",
    });
    expect(result.viewer!.viewer).toMatchObject({
      can_vote: false,
      can_view_results: true,
      counts: [5, 3, 1],
    });
    expect(result.reload).toBe(false);
  });

  it("applies the reader's own vote from another device", () => {
    const result = reducePoll(
      entry(),
      event("poll.vote.updated", {
        message_id: "p1",
        chat_id: "c1",
        options: [2],
        version: 2,
      }),
    );
    expect(result.viewer).toMatchObject({
      version: 2,
      viewer: { voted: true, my_options: [2], can_change: true },
    });
    // MessagePoll.version waits for poll.updated of the same change.
    expect(result.poll!.version).toBe(1);
    expect(result.reload).toBe(true);
    expect(reducePoll(result, updated({ version: 2 })).poll!.voter_count).toBe(
      1,
    );
  });

  it("closes voting after an anonymous vote and hides results after a retraction", () => {
    const anonymous = reducePoll(
      entry(makePoll({ anonymous: true })),
      event("poll.vote.updated", {
        message_id: "p1",
        chat_id: "c1",
        voted: true,
        version: 2,
      }),
    );
    expect(anonymous.viewer!.viewer).toMatchObject({
      voted: true,
      my_options: null,
      can_vote: false,
      can_change: false,
    });
    const retracted = reducePoll(
      entry(
        makePoll(),
        makePollViewer({
          voted: true,
          my_options: [0],
          can_view_results: true,
          counts: [1, 0, 0],
        }),
      ),
      event("poll.vote.updated", {
        message_id: "p1",
        chat_id: "c1",
        options: [],
        version: 3,
      }),
    );
    expect(retracted.viewer!.viewer).toMatchObject({
      voted: false,
      can_view_results: false,
      counts: null,
    });
  });

  it("ignores poll.notified and stale votes", () => {
    const start = entry(makePoll(), makePollViewer(), 5);
    expect(
      reducePoll(
        start,
        event("poll.notified", {
          message_id: "p1",
          chat_id: "c1",
          kind: "reminded",
        }),
      ).changed,
    ).toBe(false);
    expect(
      reducePoll(
        start,
        event("poll.vote.updated", {
          message_id: "p1",
          chat_id: "c1",
          options: [0],
          version: 4,
        }),
      ).changed,
    ).toBe(false);
  });
});

describe("optimistic votes", () => {
  it("counts the first vote and opens the results", () => {
    const next = optimisticPollVote(
      { poll: makePoll(), viewer: { viewer: makePollViewer(), version: 1 } },
      [1],
    )!;
    expect(next.poll!.voter_count).toBe(1);
    expect(next.viewer!.viewer).toMatchObject({
      voted: true,
      my_options: [1],
      can_view_results: true,
      counts: [0, 1, 0],
    });
  });

  it("moves a changed vote between the counts", () => {
    const next = optimisticPollVote(
      {
        poll: makePoll({ voter_count: 3, multiple: true }),
        viewer: {
          version: 2,
          viewer: makePollViewer({
            voted: true,
            my_options: [0],
            can_change: true,
            can_view_results: true,
            counts: [2, 1, 0],
          }),
        },
      },
      [1, 2],
    )!;
    expect(next.poll!.voter_count).toBe(3);
    expect(next.viewer!.viewer.counts).toEqual([1, 2, 1]);
  });

  it("refuses what the server would refuse", () => {
    const entry = { poll: makePoll(), viewer: null };
    expect(optimisticPollVote(entry, [0, 1])).toBeNull();
    expect(optimisticPollVote(entry, [7])).toBeNull();
    expect(
      optimisticPollVote(
        { poll: makePoll({ status: "closed" }), viewer: null },
        [0],
      ),
    ).toBeNull();
    expect(
      optimisticPollRetract({
        poll: makePoll({ anonymous: true }),
        viewer: {
          version: 1,
          viewer: makePollViewer({ voted: true, can_change: true }),
        },
      }),
    ).toBeNull();
  });

  it("retracts and keeps the author's results", () => {
    const entry: PollCacheEntry = {
      poll: makePoll({ voter_count: 2 }),
      viewer: {
        version: 2,
        viewer: makePollViewer({
          voted: true,
          my_options: [0],
          can_change: true,
          can_view_results: true,
          counts: [2, 0, 0],
        }),
      },
    };
    const reader = optimisticPollRetract(entry)!;
    expect(reader.poll!.voter_count).toBe(1);
    expect(reader.viewer!.viewer).toMatchObject({
      voted: false,
      can_vote: true,
      can_view_results: false,
      counts: null,
    });
    const author = optimisticPollRetract(entry, { isAuthor: true })!;
    expect(author.viewer!.viewer.counts).toEqual([1, 0, 0]);
  });
});

describe("performPollAction", () => {
  function cache(initial: PollCacheEntry) {
    let value = initial;
    return {
      read: () => value,
      write: (entry: PollCacheEntry) => {
        value = entry;
      },
    };
  }
  const start: PollCacheEntry = {
    poll: makePoll(),
    viewer: { viewer: makePollViewer(), version: 1 },
  };
  const state = (version: number, voter_count = 1): PollState => ({
    poll: makePoll({ version, voter_count }),
    viewer: makePollViewer({
      voted: true,
      my_options: [0],
      can_view_results: true,
      counts: [1, 0, 0],
    }),
  });

  it("writes the optimistic vote, then the server's state", async () => {
    const store = cache(start);
    const optimistic = optimisticPollVote(start, [0])!;
    let seen: PollCacheEntry | null = null;
    await performPollAction(store, optimistic, async () => {
      seen = store.read();
      return state(2);
    });
    expect(seen).toBe(optimistic);
    expect(store.read().poll!.version).toBe(2);
    expect(store.read().viewer!.version).toBe(2);
  });

  it("rolls back on an error and reads the poll again after a conflict", async () => {
    const store = cache(start);
    const optimistic = optimisticPollVote(start, [0])!;
    await expect(
      performPollAction(
        store,
        optimistic,
        () => Promise.reject(new APIError(409, "poll_closed", "closed")),
        async () => ({
          poll: makePoll({
            status: "closed",
            version: 5,
            final_counts: [1, 1, 1],
          }),
          viewer: makePollViewer({ can_vote: false, can_view_results: true }),
        }),
      ),
    ).rejects.toBeInstanceOf(APIError);
    expect(store.read().poll!.status).toBe("closed");
    expect(store.read().viewer!.viewer.voted).toBe(false);
  });

  it("keeps something newer that arrived meanwhile", async () => {
    const store = cache(start);
    const optimistic = optimisticPollVote(start, [0])!;
    const newer: PollCacheEntry = {
      poll: makePoll({ version: 9 }),
      viewer: { viewer: makePollViewer(), version: 9 },
    };
    await expect(
      performPollAction(store, optimistic, async () => {
        store.write(newer);
        throw new Error("network");
      }),
    ).rejects.toThrow();
    expect(store.read()).toBe(newer);
  });
});

describe("«Ждут вас» rules", () => {
  it("waits only for a poll with a due date not voted in", () => {
    const due = new Date(now.getTime() + 3 * 3600_000).toISOString();
    const viewer = makePollViewer();
    expect(isPollWaiting(makePoll({ due_at: due }), viewer)).toBe(true);
    expect(isPollWaiting(makePoll(), viewer)).toBe(false);
    expect(
      isPollWaiting(makePoll({ due_at: due }), { ...viewer, voted: true }),
    ).toBe(false);
    expect(isPollHot(makePoll({ due_at: due }), viewer, now)).toBe(true);
    const far = new Date(now.getTime() + 48 * 3600_000).toISOString();
    expect(isPollHot(makePoll({ due_at: far }), viewer, now)).toBe(false);
  });
});

describe("anonChoiceStore", () => {
  it("remembers the choice per person and poll", async () => {
    const storage = memoryPollChoiceStorage();
    const store = createAnonChoiceStore(storage);
    expect(await store.get("u1", "p1")).toBeNull();
    await store.set("u1", "p1", [2, 0, 2]);
    expect(await store.get("u1", "p1")).toEqual([0, 2]);
    expect(store.peek("u1", "p1")).toEqual([0, 2]);
    expect(await store.get("u2", "p1")).toBeNull();
    // A new store over the same storage: the choice survives a restart.
    expect(await createAnonChoiceStore(storage).get("u1", "p1")).toEqual([
      0, 2,
    ]);
    await store.remove("u1", "p1");
    expect(await createAnonChoiceStore(storage).get("u1", "p1")).toBeNull();
  });

  it("survives broken values and failing storage", async () => {
    const storage = memoryPollChoiceStorage();
    await storage.setItem(anonChoiceKey("u1", "p1"), "not json");
    expect(await createAnonChoiceStore(storage).get("u1", "p1")).toBeNull();
    const failing = createAnonChoiceStore({
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("full");
      },
      removeItem: () => undefined,
    });
    await failing.set("u1", "p1", [1]);
    expect(await failing.get("u1", "p1")).toEqual([1]);
  });
});

describe("keys and errors", () => {
  it("carries the reader's id in every key", () => {
    expect(pollKeys.poll("u1", "p1")).toEqual(["polls", "u1", "poll", "p1"]);
    expect(pollKeys.voters("u1", "p1", "waiting")[1]).toBe("u1");
  });

  it("maps the server's codes", () => {
    expect(pollErrorKind(new APIError(409, "poll_vote_final", ""))).toBe(
      "voteFinal",
    );
    expect(pollErrorKind(new APIError(409, "version_conflict", ""))).toBe(
      "conflict",
    );
    expect(
      pollErrorKind(new APIError(429, "poll_remind_too_soon", "", {}, 60)),
    ).toBe("remindTooSoon");
    expect(pollErrorKind(new Error("offline"))).toBe("network");
    expect(
      pollInvalidField(
        new APIError(422, "poll_invalid", "", { field: "options" }),
      ),
    ).toBe("options");
  });
});
