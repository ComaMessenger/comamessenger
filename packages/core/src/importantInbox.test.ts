import { describe, expect, it } from "vitest";
import {
  chatRequestBadge,
  defaultImportantTab,
  importantCounts,
  importantHref,
  importantTabs,
  parseImportantTab,
  reduceRequestInbox,
  waitingSections,
  waitingStrip,
} from "./importantInbox";
import { parseRequestEvent, type RequestEvent } from "./requests";
import type {
  Message,
  MessageRequest,
  MessageRequestViewer,
  RequestInboxItem,
} from "./types";

const both = ["message_requests", "message_reminders"];
const now = new Date("2026-11-12T10:00:00Z");

function item(
  id: string,
  overrides: {
    request?: Partial<MessageRequest>;
    viewer?: Partial<MessageRequestViewer>;
    seq?: number;
  } = {},
): RequestInboxItem {
  const request: MessageRequest = {
    status: "open",
    closed_reason: null,
    answer: { preset: "yes_no" },
    allow_comment: true,
    due_at: null,
    auto_remind_at: null,
    audience: { kind: "chat", label: "", count: 3 },
    answered_count: 0,
    waiting_count: 3,
    version: 1,
    ...overrides.request,
  };
  return {
    message: {
      id,
      chat_id: "c1",
      actor_id: "author",
      client_msg_id: id,
      type: "request",
      body: "?",
      body_format: "plain",
      version: 1,
      created_seq: overrides.seq ?? 1,
      created_at: "2026-11-12T08:00:00Z",
      mentioned_actor_ids: [],
      thread_reply_count: 0,
      files: [],
      request,
    } as Message,
    chat_id: "c1",
    author: {
      actor_id: "author",
      display_name: "Марина",
      type: "user",
      avatar_version: 0,
    },
    chat: { id: "c1", kind: "group", display_name: "Инструкторы · зал" },
    request,
    viewer: {
      role: "recipient",
      answer: null,
      can_answer: true,
      can_change: false,
      can_view_answers: false,
      can_close: false,
      can_remind: false,
      next_remind_at: null,
      tally: null,
      ...overrides.viewer,
    },
  };
}

const answer = (version = 1) => ({
  option: 0,
  comment: "",
  answered_at: "2026-11-12T09:00:00Z",
  late: false,
  version,
});

function event(type: string, data: Record<string, unknown>): RequestEvent {
  return parseRequestEvent({
    op: "event",
    seq: 1,
    type,
    occurred_at: "2026-11-12T09:30:00Z",
    actor_id: "a",
    subject_id: "m1",
    data: { chat_id: "c1", ...data },
  })!;
}

describe("tabs and counts", () => {
  it("hides what the server cannot serve", () => {
    expect(importantTabs(both)).toEqual(["waiting", "saved", "reminders"]);
    expect(importantTabs(["message_reminders"])).toEqual([
      "saved",
      "reminders",
    ]);
    expect(importantTabs([])).toEqual(["saved"]);
    expect(importantTabs(undefined)).toEqual(["saved"]);
  });

  it("counts waiting requests and fired reminders for the badge", () => {
    expect(
      importantCounts(
        { requests_waiting_total: 3, reminders_fired_total: 2 },
        both,
      ),
    ).toEqual({ waiting: 3, reminders: 2, badge: 5 });
    expect(importantCounts({}, both)).toEqual({
      waiting: 0,
      reminders: 0,
      badge: 0,
    });
    // An old server's counts are not shown even if present.
    expect(
      importantCounts(
        { requests_waiting_total: 3, reminders_fired_total: 2 },
        [],
      ),
    ).toEqual({ waiting: 0, reminders: 0, badge: 0 });
  });

  it("opens «Ждут вас» when something waits, else the last tab", () => {
    const tabs = importantTabs(both);
    expect(
      defaultImportantTab({ tabs, counts: { waiting: 2 }, last: "reminders" }),
    ).toBe("waiting");
    expect(
      defaultImportantTab({ tabs, counts: { waiting: 0 }, last: "reminders" }),
    ).toBe("reminders");
    expect(defaultImportantTab({ tabs, counts: { waiting: 0 } })).toBe("saved");
    expect(
      defaultImportantTab({ tabs, counts: { waiting: 2 }, requested: "saved" }),
    ).toBe("saved");
    // A tab the server lost falls back.
    expect(
      defaultImportantTab({
        tabs: ["saved"],
        counts: { waiting: 2 },
        last: "reminders",
      }),
    ).toBe("saved");
  });

  it("reads and writes the tab of the address", () => {
    expect(parseImportantTab("waiting")).toBe("waiting");
    expect(parseImportantTab("tasks")).toBeNull();
    expect(importantHref("reminders")).toBe("/important?tab=reminders");
  });
});

describe("«Ждут вас»", () => {
  it("puts due dates first, then the newest, and answered ones apart", () => {
    const sections = waitingSections(
      [
        item("plain-old", { seq: 1 }),
        item("plain-new", { seq: 5 }),
        item("due-late", { request: { due_at: "2026-11-14T17:00:00Z" } }),
        item("due-soon", { request: { due_at: "2026-11-12T17:00:00Z" } }),
      ],
      [
        item("a1", {
          viewer: {
            answer: { ...answer(), answered_at: "2026-11-12T08:00:00Z" },
          },
        }),
        item("a2", { viewer: { answer: answer() } }),
      ],
    );
    expect(sections.waiting.map((entry) => entry.message.id)).toEqual([
      "due-soon",
      "due-late",
      "plain-new",
      "plain-old",
    ]);
    expect(sections.answered.map((entry) => entry.message.id)).toEqual([
      "a2",
      "a1",
    ]);
  });

  it("moves an item answered elsewhere and drops closed ones", () => {
    const stale = item("m1");
    const fresh = item("m1", {
      request: { version: 2 },
      viewer: { answer: answer() },
    });
    const closed = item("m2", {
      request: { status: "closed", closed_reason: "author" },
    });
    const sections = waitingSections([stale, closed], [fresh]);
    expect(sections.waiting).toEqual([]);
    expect(sections.answered.map((entry) => entry.message.id)).toEqual(["m1"]);
  });

  it("takes an answer from the viewer map, set optimistically", () => {
    const sections = waitingSections([item("m1")], [], {
      m1: {
        viewer: { ...item("m1").viewer, answer: answer() },
        version: 1,
        provisional: true,
      },
    });
    expect(sections.answered).toHaveLength(1);
  });

  it("applies events to a list and asks for new items", () => {
    const list = [item("m1")];
    const assigned = reduceRequestInbox(
      list,
      event("request.assigned", { message_id: "new", due_at: null }),
      now,
    );
    expect(assigned.stale).toBe(true);
    const answered = reduceRequestInbox(
      list,
      event("request.answer.updated", {
        message_id: "m1",
        option: 1,
        has_comment: false,
        late: false,
        version: 1,
      }),
      now,
    );
    expect(answered.items[0]!.viewer.answer?.option).toBe(1);
    expect(waitingSections(answered.items, []).answered).toHaveLength(1);
    const counted = reduceRequestInbox(
      list,
      event("request.updated", {
        message_id: "m1",
        status: "open",
        closed_reason: null,
        answered_count: 1,
        waiting_count: 2,
        version: 2,
      }),
      now,
    );
    expect(counted.items[0]!.request.answered_count).toBe(1);
    expect(counted.items[0]!.message.request?.answered_count).toBe(1);
    const closed = reduceRequestInbox(
      list,
      event("request.updated", {
        message_id: "m1",
        status: "closed",
        closed_reason: "message_deleted",
        answered_count: 0,
        waiting_count: 3,
        version: 2,
      }),
      now,
    );
    expect(closed.items).toEqual([]);
  });
});

describe("chat list and chat", () => {
  it("marks a chat with a due date or just «ждут ответа»", () => {
    expect(chatRequestBadge(undefined)).toBeNull();
    expect(chatRequestBadge({ requests_waiting: 0 })).toBeNull();
    expect(
      chatRequestBadge({
        requests_waiting: 2,
        requests_next_due_at: "2026-11-13T17:00:00Z",
      }),
    ).toEqual({ kind: "due", at: new Date("2026-11-13T17:00:00Z"), count: 2 });
    expect(
      chatRequestBadge({ requests_waiting: 1, requests_next_due_at: null }),
    ).toEqual({
      kind: "waiting",
      count: 1,
    });
  });

  it("scrolls the strip to the earliest waiting request that is loaded", () => {
    const messages = [
      { id: "m1", created_seq: 1, request: item("m1").request },
      {
        id: "m2",
        created_seq: 2,
        request: item("m2", { request: { due_at: "2026-11-13T17:00:00Z" } })
          .request,
      },
      { id: "m3", created_seq: 3, request: item("m3").request },
      { id: "plain", created_seq: 4, request: null },
    ];
    const recipient = (answered = false) => ({
      viewer: { ...item("x").viewer, answer: answered ? answer() : null },
      version: 1,
      provisional: false,
    });
    const strip = waitingStrip(
      { requests_waiting: 2, requests_next_due_at: "2026-11-13T17:00:00Z" },
      messages,
      { m1: recipient(), m2: recipient(), m3: recipient(true) },
    );
    expect(strip).toEqual({
      count: 2,
      dueAt: new Date("2026-11-13T17:00:00Z"),
      messageID: "m2",
    });
    expect(waitingStrip({ requests_waiting: 0 }, messages, {})).toBeNull();
    expect(waitingStrip({ requests_waiting: 1 }, [], {})?.messageID).toBeNull();
  });
});
