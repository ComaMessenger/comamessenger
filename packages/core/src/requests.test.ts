import { afterAll, describe, expect, it } from "vitest";
import { APIError } from "./api";
import {
  afterRemind,
  autoRemindAt,
  autoRemindAvailable,
  emptyRequestDraft,
  formatRequestDue,
  formatRequestDueDay,
  mergeRequestViewer,
  optimisticAnswer,
  parseRequestEvent,
  reduceRequest,
  requestAnswerNote,
  requestAnswerTabs,
  requestAudienceText,
  requestCustomOptions,
  requestDraftProblem,
  requestDuePresets,
  requestDueProblem,
  requestErrorKind,
  requestInvalidField,
  requestOptionLabels,
  requestRecipientIDs,
  requestRemindState,
  requestSignature,
  requestView,
  toCreateRequestInput,
  type RequestCacheEntry,
  type RequestDraft,
  type RequestEvent,
} from "./requests";
import { fromLocalInputValue, toLocalInputValue } from "./scheduled";
import type {
  DurableEvent,
  Message,
  MessageRequest,
  MessageRequestViewer,
} from "./types";

// Berlin time: daylight saving changes on 29 March 2026 (02:00 → 03:00) and
// 25 October 2026 (03:00 → 02:00). 13 November 2026 is a Friday.
// Set before the tests are collected: describe blocks build dates at once.
const previousTZ = process.env.TZ;
process.env.TZ = "Europe/Berlin";
afterAll(() => {
  process.env.TZ = previousTZ;
});

const local = (value: string) => fromLocalInputValue(value)!;
const t = (key: string) => `«${key}»`;

function request(overrides: Partial<MessageRequest> = {}): MessageRequest {
  return {
    status: "open",
    closed_reason: null,
    answer: { preset: "attend" },
    allow_comment: true,
    due_at: null,
    auto_remind_at: null,
    audience: { kind: "chat", label: "", count: 12 },
    answered_count: 5,
    waiting_count: 7,
    version: 4,
    ...overrides,
  };
}

function viewer(
  overrides: Partial<MessageRequestViewer> = {},
): MessageRequestViewer {
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
    ...overrides,
  };
}

function event(type: string, data: Record<string, unknown>): RequestEvent {
  const parsed = parseRequestEvent({
    op: "event",
    seq: 1,
    type,
    occurred_at: "2026-11-17T09:00:00Z",
    actor_id: "a",
    chat_id: "c1",
    subject_id: "m1",
    data: { message_id: "m1", chat_id: "c1", ...data },
  });
  if (!parsed) throw new Error(`unparsed ${type}`);
  return parsed;
}

describe("answer types", () => {
  it("words ready-made types by key and keeps custom buttons as text", () => {
    expect(requestOptionLabels({ answer: { preset: "ack" } }, t)).toEqual([
      "«requestOptionAck»",
    ]);
    expect(requestOptionLabels({ answer: { preset: "yes_no" } }, t)).toEqual([
      "«requestOptionYes»",
      "«requestOptionNo»",
    ]);
    expect(requestOptionLabels({ answer: { preset: "attend" } }, t)).toEqual([
      "«requestOptionAttend»",
      "«requestOptionNotAttend»",
    ]);
    expect(
      requestOptionLabels(
        { answer: { preset: "custom", options: ["Утро", "Вечер"] } },
        t,
      ),
    ).toEqual(["Утро", "Вечер"]);
  });

  it("falls back to the sent options for a type from a newer server", () => {
    expect(
      requestOptionLabels(
        { answer: { preset: "rate" as never, options: ["1", "2"] } },
        t,
      ),
    ).toEqual(["1", "2"]);
  });
});

describe("the form", () => {
  const now = local("2026-11-10T10:00");
  const members = [
    { actor_id: "me", type: "user" as const },
    { actor_id: "u1", type: "user" as const },
    { actor_id: "u2", type: "user" as const },
    { actor_id: "bot", type: "agent" as const },
  ];
  const draft = (overrides: Partial<RequestDraft> = {}): RequestDraft => ({
    ...emptyRequestDraft(),
    body: "Планёрка в понедельник. Будете?",
    ...overrides,
  });

  it("asks everyone but the author and agents", () => {
    expect(requestRecipientIDs({ kind: "chat" }, members, "me")).toEqual([
      "u1",
      "u2",
    ]);
    expect(
      requestRecipientIDs(
        { kind: "people", actorIDs: ["u2", "bot", "me", "gone"] },
        members,
        "me",
      ),
    ).toEqual(["u2"]);
  });

  it("names the first problem in the order of the fields", () => {
    expect(requestDraftProblem(draft({ body: "  " }), now, 2)).toEqual({
      field: "body",
      reason: "empty",
    });
    expect(requestDraftProblem(draft(), now, 0)).toEqual({
      field: "audience",
      reason: "empty",
    });
    expect(requestDraftProblem(draft(), now, 501)).toEqual({
      field: "audience",
      reason: "tooMany",
    });
    expect(requestDraftProblem(draft(), now, 500)).toBeNull();
  });

  it("checks custom buttons: 2–4, up to 32 characters, no repeats", () => {
    const custom = (options: string[]) =>
      requestDraftProblem(
        draft({ preset: "custom", customOptions: options }),
        now,
        2,
      );
    expect(custom(["Да", "  "])).toEqual({
      field: "options",
      reason: "tooFew",
    });
    expect(custom(["1", "2", "3", "4", "5"])).toEqual({
      field: "options",
      reason: "tooMany",
    });
    expect(custom(["Да", "x".repeat(33)])).toEqual({
      field: "options",
      reason: "tooLong",
      index: 1,
    });
    expect(custom(["Приду", "приду"])).toEqual({
      field: "options",
      reason: "duplicate",
      index: 1,
    });
    expect(custom([" Утро ", "", "Вечер"])).toBeNull();
    expect(
      requestCustomOptions({ customOptions: [" Утро ", "", "Вечер"] }),
    ).toEqual(["Утро", "Вечер"]);
  });

  it("keeps due dates between 10 minutes and 90 days ahead", () => {
    expect(requestDueProblem(local("2026-11-10T10:09"), now)).toBe("past");
    expect(requestDueProblem(local("2026-11-10T10:10"), now)).toBeNull();
    expect(
      requestDueProblem(new Date(now.getTime() + 91 * 86_400_000), now),
    ).toBe("tooFar");
    expect(
      requestDraftProblem(draft({ dueAt: local("2026-11-10T10:05") }), now, 2),
    ).toEqual({ field: "dueAt", reason: "past" });
  });

  it("sends the automatic reminder only with a due date an hour ahead", () => {
    expect(autoRemindAvailable(null, now)).toBe(false);
    expect(autoRemindAvailable(local("2026-11-10T10:59"), now)).toBe(false);
    expect(autoRemindAvailable(local("2026-11-10T11:00"), now)).toBe(true);
    const soon = toCreateRequestInput(
      draft({ dueAt: local("2026-11-10T10:30") }),
      "id-1",
      now,
    );
    expect(soon.auto_remind).toBe(false);
    const friday = toCreateRequestInput(
      draft({
        dueAt: local("2026-11-13T18:00"),
        audience: { kind: "people", actorIDs: ["u1"] },
        preset: "custom",
        customOptions: [" Утро", "Вечер ", ""],
      }),
      "id-2",
      now,
      { bodyFormat: "markdown", mentionedActorIDs: ["u1"] },
    );
    expect(friday).toEqual({
      client_msg_id: "id-2",
      body: "Планёрка в понедельник. Будете?",
      body_format: "markdown",
      audience: { kind: "people", actor_ids: ["u1"] },
      answer: { preset: "custom", options: ["Утро", "Вечер"] },
      allow_comment: true,
      auto_remind: true,
      due_at: local("2026-11-13T18:00").toISOString(),
      mentioned_actor_ids: ["u1"],
    });
  });

  it("gives a retry the same signature and a change another one", () => {
    const input = toCreateRequestInput(draft(), "a", now);
    const retry = toCreateRequestInput(draft(), "b", now);
    const changed = toCreateRequestInput(
      draft({ allowComment: false }),
      "a",
      now,
    );
    expect(requestSignature(input)).toBe(requestSignature(retry));
    expect(requestSignature(input)).not.toBe(requestSignature(changed));
  });
});

describe("due dates", () => {
  const presets = (now: string) =>
    Object.fromEntries(
      requestDuePresets(local(now)).map((preset) => [
        preset.id,
        toLocalInputValue(preset.at),
      ]),
    );

  it("offers today 18:00, tomorrow 12:00 and Friday 18:00", () => {
    expect(presets("2026-11-10T10:00")).toEqual({
      today: "2026-11-10T18:00",
      tomorrow: "2026-11-11T12:00",
      friday: "2026-11-13T18:00",
    });
  });

  it("hides today when less than an hour is left before 18:00", () => {
    expect(presets("2026-11-10T17:00")).toHaveProperty("today");
    expect(presets("2026-11-10T17:01")).not.toHaveProperty("today");
  });

  it("means the next Friday on a Friday after 17:00", () => {
    expect(presets("2026-11-13T17:30")).toEqual({
      tomorrow: "2026-11-14T12:00",
      friday: "2026-11-20T18:00",
    });
  });

  it("does not repeat today as Friday before 17:00 on a Friday", () => {
    expect(presets("2026-11-13T09:00")).toEqual({
      today: "2026-11-13T18:00",
      tomorrow: "2026-11-14T12:00",
    });
  });

  it("keeps local hours across the spring change", () => {
    expect(presets("2026-03-28T10:00")).toEqual({
      today: "2026-03-28T18:00",
      tomorrow: "2026-03-29T12:00",
      friday: "2026-04-03T18:00",
    });
    const tomorrow = requestDuePresets(local("2026-03-28T10:00"))[1]!.at;
    // 26 hours apart on the clock, 25 in real time.
    expect(tomorrow.getTime() - local("2026-03-28T10:00").getTime()).toBe(
      25 * 3_600_000,
    );
  });

  it("words due dates the way people say them", () => {
    const now = local("2026-11-10T10:00");
    expect(formatRequestDue(local("2026-11-10T18:00"), now, "ru")).toBe(
      "сегодня, 18:00",
    );
    expect(formatRequestDue(local("2026-11-11T12:00"), now, "ru")).toBe(
      "завтра, 12:00",
    );
    expect(formatRequestDue(local("2026-11-13T18:00"), now, "ru")).toBe(
      "пт, 18:00",
    );
    expect(formatRequestDue(local("2026-11-20T18:00"), now, "ru")).toBe(
      "20 ноября, 18:00",
    );
    expect(formatRequestDue(local("2026-11-13T18:00"), now, "en")).toBe(
      "Fri, 6:00 PM",
    );
    expect(formatRequestDueDay(local("2026-11-13T18:00"), now, "ru")).toBe(
      "пт",
    );
  });
});

describe("autoRemindAt", () => {
  it("is the day before for a due date days ahead", () => {
    // Set on Tuesday 10:00 for «до пт, 18:00» — Thursday 18:00.
    expect(
      toLocalInputValue(
        autoRemindAt(local("2026-11-10T10:00"), local("2026-11-13T18:00")),
      ),
    ).toBe("2026-11-12T18:00");
  });

  it("is halfway for a due date the same day", () => {
    expect(
      toLocalInputValue(
        autoRemindAt(local("2026-11-10T10:00"), local("2026-11-10T18:00")),
      ),
    ).toBe("2026-11-10T14:00");
  });

  it("works on instants, as the server does, across a time change", () => {
    const created = local("2026-03-28T10:00");
    const due = local("2026-03-29T12:00");
    const expected = Math.max(
      due.getTime() - 24 * 3_600_000,
      created.getTime() + (due.getTime() - created.getTime()) / 2,
    );
    expect(autoRemindAt(created, due).getTime()).toBe(expected);
  });
});

describe("audience", () => {
  it("never lists names", () => {
    expect(
      requestAudienceText({ kind: "chat", label: "", count: 9 }, "ru"),
    ).toBe("весь чат");
    expect(
      requestAudienceText({ kind: "people", label: "", count: 3 }, "ru"),
    ).toBe("3 человека");
    expect(
      requestAudienceText({ kind: "people", label: "", count: 5 }, "ru"),
    ).toBe("5 человек");
    expect(
      requestAudienceText(
        { kind: "people", label: "Олег Чернов", count: 1 },
        "ru",
      ),
    ).toBe("Олег Чернов");
    expect(
      requestAudienceText(
        { kind: "department", label: "Зал ЛФК", count: 6 },
        "ru",
      ),
    ).toBe("отдел «Зал ЛФК»");
  });
});

describe("the card", () => {
  const now = local("2026-11-12T10:00");
  const message = (
    overrides: Partial<Message> = {},
  ): Pick<Message, "actor_id" | "edited_at" | "request"> => ({
    actor_id: "author",
    edited_at: null,
    request: request({ due_at: local("2026-11-13T18:00").toISOString() }),
    ...overrides,
  });
  const context = { selfID: "me", now, t };

  it("shows buttons to a recipient who has not answered", () => {
    const view = requestView(message(), viewer(), context)!;
    expect(view).toMatchObject({
      role: "recipient",
      showButtons: true,
      notForYou: false,
      answered: 5,
      total: 12,
      waiting: 7,
      singleOption: false,
      pill: { kind: "due", overdue: false },
    });
    expect(view.options).toEqual([
      "«requestOptionAttend»",
      "«requestOptionNotAttend»",
    ]);
  });

  it("shows «Ваш ответ», «после срока» and until when it may change", () => {
    const view = requestView(
      message(),
      viewer({
        can_change: true,
        answer: {
          option: 1,
          comment: "на выезде до 13",
          answered_at: "2026-11-12T08:00:00Z",
          late: true,
          version: 2,
        },
      }),
      context,
    )!;
    expect(view.showButtons).toBe(false);
    expect(view.answer).toMatchObject({
      option: 1,
      label: "«requestOptionNotAttend»",
      comment: "на выезде до 13",
      late: true,
    });
    expect(view.canChange).toBe(true);
    expect(view.canComment).toBe(true);
    expect(view.changeUntil?.toISOString()).toBe(
      local("2026-11-13T18:00").toISOString(),
    );
  });

  it("tells everyone else the answers are not theirs to give", () => {
    const view = requestView(
      message(),
      viewer({ role: "observer", can_answer: false }),
      context,
    )!;
    expect(view.notForYou).toBe(true);
    expect(view.showButtons).toBe(false);
    expect(view.tally).toBeNull();
  });

  it("guesses the role while the viewer is unknown", () => {
    expect(requestView(message(), null, context)).toMatchObject({
      role: "observer",
      viewerMissing: true,
      notForYou: true,
    });
    expect(
      requestView(message({ actor_id: "me" }), undefined, context),
    ).toMatchObject({ role: "author", viewerMissing: true });
  });

  it("gives the author bars, the reminder button and «изм.»", () => {
    const view = requestView(
      message({ actor_id: "me", edited_at: "2026-11-12T09:00:00Z" }),
      viewer({
        role: "author",
        can_answer: false,
        can_view_answers: true,
        can_close: true,
        can_remind: true,
        tally: [4, 1],
      }),
      context,
    )!;
    expect(view.tally).toEqual([
      { label: "«requestOptionAttend»", count: 4 },
      { label: "«requestOptionNotAttend»", count: 1 },
    ]);
    expect(view.remind).toEqual({ kind: "ready", count: 7 });
    expect(view.edited).toBe(true);
    expect(view.canClose).toBe(true);
  });

  it("marks an overdue request and a closed one", () => {
    const later = { ...context, now: local("2026-11-14T10:00") };
    expect(requestView(message(), viewer(), later)!.pill).toMatchObject({
      kind: "due",
      overdue: true,
    });
    expect(
      requestView(
        message({
          request: request({
            status: "closed",
            closed_reason: "expired",
            due_at: local("2026-11-13T18:00").toISOString(),
          }),
        }),
        viewer({ can_answer: false }),
        later,
      )!.pill,
    ).toEqual({ kind: "closed", warning: true });
    expect(
      requestView(
        message({
          request: request({ status: "closed", closed_reason: "author" }),
        }),
        viewer({ can_answer: false }),
        context,
      )!.pill,
    ).toEqual({ kind: "closed", warning: false });
  });

  it("shows the automatic reminder only while it is ahead", () => {
    const at = local("2026-11-12T18:00").toISOString();
    const withAuto = message({ request: request({ auto_remind_at: at }) });
    expect(
      requestView(withAuto, viewer(), context)!.autoRemindAt,
    ).not.toBeNull();
    expect(
      requestView(withAuto, viewer(), {
        ...context,
        now: local("2026-11-12T19:00"),
      })!.autoRemindAt,
    ).toBeNull();
  });

  it("is null for an ordinary message", () => {
    expect(
      requestView({ actor_id: "a", edited_at: null }, null, context),
    ).toBeNull();
  });
});

describe("manual reminders", () => {
  const now = local("2026-11-12T10:00");
  const author = viewer({ role: "author", can_answer: false });

  it("waits two hours, stops after five, says when everyone answered", () => {
    expect(
      requestRemindState(request(), { ...author, can_remind: true }, now),
    ).toEqual({ kind: "ready", count: 7 });
    const next = local("2026-11-12T11:41").toISOString();
    expect(
      requestRemindState(request(), { ...author, next_remind_at: next }, now),
    ).toEqual({ kind: "cooldown", until: new Date(next), count: 7 });
    expect(requestRemindState(request(), author, now)).toEqual({
      kind: "hidden",
    });
    expect(
      requestRemindState(request({ waiting_count: 0 }), author, now),
    ).toEqual({ kind: "allAnswered" });
    expect(
      requestRemindState(request(), { ...viewer(), can_remind: true }, now),
    ).toEqual({ kind: "hidden" });
  });

  it("locks the button after a reminder", () => {
    expect(
      afterRemind(
        { ...author, can_remind: true },
        { reminded: 7, next_remind_at: "2026-11-12T12:00:00Z" },
      ),
    ).toMatchObject({
      can_remind: false,
      next_remind_at: "2026-11-12T12:00:00Z",
    });
  });
});

describe("answers screen", () => {
  it("puts «Нет ответа» first, then a tab per button", () => {
    expect(
      requestAnswerTabs({ waiting: 3, options: [6, 1, 2] }, [
        "Приду",
        "Не приду",
        "Пока не знаю",
      ]),
    ).toEqual([
      { filter: "waiting", label: null, count: 3 },
      { filter: "option:0", label: "Приду", count: 6 },
      { filter: "option:1", label: "Не приду", count: 1 },
      { filter: "option:2", label: "Пока не знаю", count: 2 },
    ]);
  });

  it("words the second line of a row", () => {
    expect(
      requestAnswerNote({ state: "waiting", comment: "", read: true }),
    ).toBe("readNotAnswered");
    expect(
      requestAnswerNote({ state: "waiting", comment: "", read: false }),
    ).toBe("notOpened");
    expect(
      requestAnswerNote({ state: "answered", comment: "x", read: true }),
    ).toBe("comment");
    expect(
      requestAnswerNote({ state: "answered", comment: "", read: true }),
    ).toBe("answered");
    expect(requestAnswerNote({ state: "left", comment: "", read: true })).toBe(
      "left",
    );
  });
});

describe("realtime", () => {
  const now = local("2026-11-12T10:00");

  it("rejects malformed and unknown events", () => {
    const base: DurableEvent = {
      op: "event",
      seq: 1,
      type: "request.updated",
      occurred_at: "2026-11-17T09:00:00Z",
      actor_id: "a",
      subject_id: "m1",
      data: { message_id: "m1", chat_id: "c1", status: "open" },
    };
    expect(parseRequestEvent(base)).toBeNull();
    expect(
      parseRequestEvent({
        ...base,
        type: "request.voted",
        data: { message_id: "m1", chat_id: "c1" },
      }),
    ).toBeNull();
    expect(
      parseRequestEvent({
        ...base,
        type: "request.answer.updated",
        data: {
          message_id: "m1",
          chat_id: "c1",
          option: 0,
          has_comment: false,
          late: false,
          version: 1,
          comment: "leak",
        },
      })?.data,
    ).not.toHaveProperty("comment");
  });

  it("applies request.updated by version and ignores older ones", () => {
    const entry: RequestCacheEntry = { request: request(), viewer: null };
    const newer = reduceRequest(
      entry,
      event("request.updated", {
        status: "open",
        closed_reason: null,
        answered_count: 6,
        waiting_count: 6,
        version: 6,
      }),
      now,
    );
    expect(newer.changed).toBe(true);
    expect(newer.request).toMatchObject({
      answered_count: 6,
      waiting_count: 6,
      version: 6,
      audience: { count: 12 },
    });
    // Version 5 arrives late: it must not undo version 6.
    const stale = reduceRequest(
      newer,
      event("request.updated", {
        status: "open",
        closed_reason: null,
        answered_count: 5,
        waiting_count: 7,
        version: 5,
      }),
      now,
    );
    expect(stale.changed).toBe(false);
    expect(stale.request?.answered_count).toBe(6);
  });

  it("closing takes the buttons away", () => {
    const entry: RequestCacheEntry = {
      request: request(),
      viewer: {
        viewer: viewer({ can_change: true, can_close: true }),
        version: 4,
        provisional: false,
      },
    };
    const closed = reduceRequest(
      entry,
      event("request.updated", {
        status: "closed",
        closed_reason: "author",
        answered_count: 5,
        waiting_count: 7,
        version: 5,
      }),
      now,
    );
    expect(closed.request?.status).toBe("closed");
    expect(closed.viewer?.viewer).toMatchObject({
      can_answer: false,
      can_change: false,
      can_close: false,
    });
  });

  it("knows «this is mine» before the message arrives", () => {
    const assigned = reduceRequest(
      { request: null, viewer: null },
      event("request.assigned", { due_at: null }),
      now,
    );
    expect(assigned.viewer).toMatchObject({
      provisional: true,
      viewer: { role: "recipient", can_answer: true, answer: null },
    });
    // Then message.created brings the request: the card shows buttons.
    expect(
      requestView(
        { actor_id: "author", edited_at: null, request: request() },
        assigned.viewer!.viewer,
        { selfID: "me", now, t },
      )!.showButtons,
    ).toBe(true);
    // A replay changes nothing.
    expect(
      reduceRequest(assigned, event("request.assigned", { due_at: null }), now)
        .changed,
    ).toBe(false);
  });

  it("applies the tally to the author by version", () => {
    const entry: RequestCacheEntry = {
      request: request(),
      viewer: {
        viewer: viewer({
          role: "author",
          can_view_answers: true,
          tally: [3, 1],
          can_remind: true,
        }),
        version: 4,
        provisional: false,
      },
    };
    const fresh = reduceRequest(
      entry,
      event("request.tally.updated", {
        tally: [4, 1],
        waiting_count: 0,
        version: 5,
      }),
      now,
    );
    expect(fresh.viewer?.viewer.tally).toEqual([4, 1]);
    expect(fresh.viewer?.viewer.can_remind).toBe(false);
    const old = reduceRequest(
      fresh,
      event("request.tally.updated", {
        tally: [3, 1],
        waiting_count: 1,
        version: 4,
      }),
      now,
    );
    expect(old.changed).toBe(false);
    // request.updated of the same change still applies after the tally.
    const updated = reduceRequest(
      fresh,
      event("request.updated", {
        status: "open",
        closed_reason: null,
        answered_count: 5,
        waiting_count: 0,
        version: 5,
      }),
      now,
    );
    expect(updated.request?.version).toBe(5);
  });

  it("applies the reader's answer from another device and reads the comment", () => {
    const entry: RequestCacheEntry = {
      request: request(),
      viewer: { viewer: viewer(), version: 4, provisional: false },
    };
    const plain = reduceRequest(
      entry,
      event("request.answer.updated", {
        option: 0,
        has_comment: false,
        late: false,
        version: 1,
      }),
      now,
    );
    expect(plain.viewer?.viewer.answer).toMatchObject({
      option: 0,
      comment: "",
      version: 1,
    });
    expect(plain.viewer?.viewer.can_change).toBe(true);
    expect(plain.refetch).toBe(false);
    const commented = reduceRequest(
      plain,
      event("request.answer.updated", {
        option: 1,
        has_comment: true,
        late: false,
        version: 2,
      }),
      now,
    );
    expect(commented.refetch).toBe(true);
    expect(commented.viewer?.viewer.answer?.option).toBe(1);
    const replay = reduceRequest(
      commented,
      event("request.answer.updated", {
        option: 0,
        has_comment: false,
        late: false,
        version: 1,
      }),
      now,
    );
    expect(replay.changed).toBe(false);
  });

  it("does not let a late answer change after the due date", () => {
    const due = local("2026-11-11T18:00").toISOString();
    const result = reduceRequest(
      {
        request: request({ due_at: due }),
        viewer: { viewer: viewer(), version: 4, provisional: false },
      },
      event("request.answer.updated", {
        option: 0,
        has_comment: false,
        late: true,
        version: 1,
      }),
      now,
    );
    expect(result.viewer?.viewer.answer?.late).toBe(true);
    expect(result.viewer?.viewer.can_change).toBe(false);
  });
});

describe("optimistic answers and REST", () => {
  const now = local("2026-11-12T10:00");

  it("counts the first answer and keeps the comment", () => {
    const entry: RequestCacheEntry = {
      request: request(),
      viewer: { viewer: viewer(), version: 4, provisional: false },
    };
    const next = optimisticAnswer(entry, 0, "буду к 9", now);
    expect(next.request).toMatchObject({ answered_count: 6, waiting_count: 6 });
    expect(next.viewer?.viewer.answer).toMatchObject({
      option: 0,
      comment: "буду к 9",
      version: 1,
      late: false,
    });
    const changed = optimisticAnswer(next, 1, undefined, now);
    expect(changed.request?.answered_count).toBe(6);
    expect(changed.viewer?.viewer.answer).toMatchObject({
      option: 1,
      comment: "буду к 9",
      version: 2,
    });
  });

  it("merges REST viewers: fresher flags, never an older answer", () => {
    const answered = viewer({
      answer: {
        option: 1,
        comment: "",
        answered_at: "2026-11-12T08:00:00Z",
        late: false,
        version: 3,
      },
      can_change: true,
    });
    const current = { viewer: answered, version: 6, provisional: false };
    const olderPage = mergeRequestViewer(
      current,
      viewer({
        answer: {
          option: 0,
          comment: "",
          answered_at: "2026-11-12T07:00:00Z",
          late: false,
          version: 2,
        },
      }),
      5,
    );
    expect(olderPage.version).toBe(6);
    expect(olderPage.viewer.answer?.option).toBe(1);
    const provisional = { viewer: viewer(), version: 0, provisional: true };
    expect(
      mergeRequestViewer(provisional, viewer({ can_close: true }), 3),
    ).toMatchObject({
      provisional: false,
      version: 3,
      viewer: { can_close: true },
    });
  });
});

describe("errors", () => {
  it("maps server codes to what the toast says", () => {
    const error = (status: number, code: string, details = {}) =>
      new APIError(status, code as never, code, details);
    expect(requestErrorKind(error(409, "request_closed"))).toBe("closed");
    expect(requestErrorKind(error(409, "request_change_too_late"))).toBe(
      "tooLate",
    );
    expect(requestErrorKind(error(409, "chat_archived"))).toBe("archived");
    expect(requestErrorKind(error(403, "not_member"))).toBe("notMember");
    expect(requestErrorKind(error(429, "request_remind_too_soon"))).toBe(
      "remindTooSoon",
    );
    expect(requestErrorKind(error(422, "request_audience_unavailable"))).toBe(
      "audienceUnavailable",
    );
    expect(requestErrorKind(error(501, "not_implemented"))).toBe("unavailable");
    expect(requestErrorKind(error(409, "version_conflict"))).toBe("conflict");
    expect(requestErrorKind(new TypeError("offline"))).toBe("network");
    expect(
      requestInvalidField(
        error(422, "request_invalid", { field: "auto_remind" }),
      ),
    ).toBe("auto_remind");
  });
});
