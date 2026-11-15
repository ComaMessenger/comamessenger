import { describe, expect, it } from "vitest";
import {
  chatRequestBadge,
  chatWorkBadge,
  filterWaitingRows,
  reduceWaitingInbox,
  waitingFilterCounts,
  waitingFilters,
  waitingList,
  waitingRow,
  waitingSources,
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
import { makeTask, makeTaskMessage } from "./taskFixtures";
import type {
  Message,
  MessageRequest,
  MessageTask,
  WaitingInboxItem,
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

// ---------------------------------------------------------------------------
// Wave 3: tasks in «Ждут вас»

const withTasks = [...both, "message_tasks"];

function waitingTask(
  id: string,
  task: MessageTask,
  seq = 1,
  role: WaitingInboxItem["my_role"] = "responsible",
): WaitingInboxItem {
  return {
    kind: "task",
    message: makeTaskMessage(id, task, { created_seq: seq }),
    chat_id: "c1",
    author: {
      actor_id: "author",
      display_name: "Марина",
      type: "user",
      avatar_version: 0,
    } as WaitingInboxItem["author"],
    chat: { id: "c1", kind: "group", display_name: "Зал" },
    due_at: task.due_at,
    request: null,
    viewer: null,
    my_role: role,
  };
}

function waitingRequest(
  id: string,
  due: string | null,
  seq = 1,
): WaitingInboxItem {
  const source = item(id, { request: { due_at: due }, seq });
  return {
    kind: "request",
    message: source.message,
    chat_id: source.chat_id,
    author: source.author,
    chat: source.chat,
    due_at: due,
    request: source.request,
    viewer: source.viewer,
    my_role: null,
  };
}

const mine = (overrides: Partial<MessageTask> = {}) =>
  makeTask({
    assignee: { ...makeTask().assignee, actor_id: "me" },
    ...overrides,
  });

describe("«Ждут вас» with tasks", () => {
  it("counts open tasks in the chip and burning ones in the badge", () => {
    expect(
      importantCounts(
        {
          requests_waiting_total: 2,
          reminders_fired_total: 1,
          tasks_mine_open_total: 5,
          tasks_mine_hot_total: 2,
        },
        withTasks,
      ),
    ).toEqual({ waiting: 7, reminders: 1, badge: 5 });
    expect(
      importantCounts(
        {
          requests_waiting_total: 2,
          tasks_mine_open_total: 5,
          tasks_mine_hot_total: 2,
        },
        both,
      ),
    ).toEqual({ waiting: 2, reminders: 0, badge: 2 });
    expect(importantTabs(["message_tasks"])).toEqual(["waiting", "saved"]);
  });

  it("offers the chips with tasks only", () => {
    expect(waitingFilters(both)).toEqual([]);
    expect(waitingFilters(withTasks)).toEqual(["all", "requests", "tasks"]);
    expect(waitingFilters(["message_tasks"])).toEqual(["all", "tasks"]);
    expect(waitingFilters([...withTasks, "message_polls"])).toEqual([
      "all",
      "requests",
      "tasks",
      "polls",
    ]);
  });

  it("chooses the endpoint by the server's features", () => {
    expect(waitingSources(both)).toEqual([
      { source: "requestInbox", state: "waiting" },
      { source: "requestInbox", state: "answered" },
    ]);
    expect(waitingSources([])).toEqual([]);
    expect(waitingSources(withTasks)).toEqual([
      { source: "waitingInbox", kind: "all" },
      { source: "requestInbox", state: "answered" },
    ]);
    expect(waitingSources(withTasks, "requests")).toEqual([
      { source: "waitingInbox", kind: "requests" },
      { source: "requestInbox", state: "answered" },
    ]);
    expect(waitingSources(withTasks, "tasks")).toEqual([
      { source: "waitingInbox", kind: "tasks" },
      { source: "myTasks", role: "assigned", state: "done" },
    ]);
    expect(waitingSources(withTasks, "tasks", "authored")).toEqual([
      { source: "myTasks", role: "authored", state: "open" },
      { source: "myTasks", role: "authored", state: "done" },
    ]);
    expect(waitingSources(withTasks, "polls")).toEqual([]);
  });

  it("merges requests and tasks in one order and filters them", () => {
    const list = waitingList(
      [
        waitingTask("t-none", mine(), 9),
        waitingRequest("r-late", "2026-11-12T09:00:00Z", 2),
        waitingTask("t-soon", mine({ due_at: "2026-11-12T12:00:00Z" }), 3),
        waitingRequest("r-none", null, 4),
        waitingTask("t-closed", mine({ status: "done" }), 5),
        waitingTask("t-taken", makeTask(), 6, "candidate"),
        { ...waitingRequest("poll", null, 7), kind: "poll" as "request" },
      ],
      [],
      "me",
    );
    expect(list.waiting.map((row) => row.item.message.id)).toEqual([
      "r-late",
      "t-soon",
      "t-none",
      "r-none",
    ]);
    expect(
      filterWaitingRows(list.waiting, "tasks").map(
        (row) => row.item.message.id,
      ),
    ).toEqual(["t-soon", "t-none"]);
    expect(filterWaitingRows(list.waiting, "requests")).toHaveLength(2);
    expect(waitingFilterCounts(list.waiting)).toEqual({
      all: 4,
      requests: 2,
      tasks: 2,
      polls: 0,
    });
  });

  it("takes fresher tasks from the store", () => {
    const list = waitingList(
      [waitingTask("t1", mine({ version: 1 }))],
      [],
      "me",
      { tasks: { t1: mine({ version: 2, status: "done" }) } },
    );
    expect(list.waiting).toEqual([]);
    expect(waitingRow(waitingTask("t2", mine()))).toMatchObject({
      kind: "task",
      item: { my_role: "responsible" },
    });
  });

  it("applies task and request events to the list", () => {
    const items = [
      waitingTask("t1", mine({ version: 1 })),
      waitingRequest("m1", null),
    ];
    const taken = reduceWaitingInbox(
      items,
      {
        type: "task.updated",
        occurredAt: "",
        data: {
          message_id: "t1",
          chat_id: "c1",
          task: makeTask({ version: 2 }),
        },
      },
      "me",
      now,
    );
    expect(taken.items.map((entry) => entry.message.id)).toEqual(["m1"]);
    const moved = reduceWaitingInbox(
      items,
      {
        type: "task.updated",
        occurredAt: "",
        data: {
          message_id: "t1",
          chat_id: "c1",
          task: mine({ version: 2, due_at: "2026-11-13T10:00:00Z" }),
        },
      },
      "me",
      now,
    );
    expect(moved.items[0]!.due_at).toBe("2026-11-13T10:00:00Z");
    expect(
      reduceWaitingInbox(
        items,
        {
          type: "task.updated",
          occurredAt: "",
          data: { message_id: "t9", chat_id: "c1", task: mine() },
        },
        "me",
        now,
      ).stale,
    ).toBe(true);
    expect(
      reduceWaitingInbox(
        items,
        {
          type: "task.notified",
          occurredAt: "",
          data: {
            message_id: "t9",
            chat_id: "c1",
            kind: "offered",
            by_actor_id: "a",
            due_at: null,
          },
        },
        "me",
        now,
      ).stale,
    ).toBe(true);
    const closed = reduceWaitingInbox(
      items,
      event("request.updated", {
        message_id: "m1",
        status: "closed",
        closed_reason: "author",
        answered_count: 0,
        waiting_count: 3,
        version: 2,
      }),
      "me",
      now,
    );
    expect(closed.items.map((entry) => entry.message.id)).toEqual(["t1"]);
  });

  it("marks a chat with a burning task over a waiting request", () => {
    const chat = {
      requests_waiting: 1,
      requests_next_due_at: "2026-11-13T10:00:00Z",
      tasks_mine_open: 1,
      tasks_mine_next_due_at: "2026-11-12T12:00:00Z",
    };
    expect(chatWorkBadge(chat, now)).toEqual({
      kind: "task",
      badge: { kind: "due", at: new Date("2026-11-12T12:00:00Z") },
    });
    expect(
      chatWorkBadge({ ...chat, tasks_mine_next_due_at: null }, now),
    ).toMatchObject({ kind: "request" });
    expect(chatWorkBadge(undefined, now)).toBe(null);
  });
});
