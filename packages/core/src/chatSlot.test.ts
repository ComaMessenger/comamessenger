import { afterAll, describe, expect, it } from "vitest";
import {
  buildChatSlot,
  chatTaskSections,
  nextPinIndex,
  selectSlotItem,
  slotChips,
  type ChatSlotInput,
} from "./chatSlot";
import { makeTask, makeTaskMessage } from "./taskFixtures";
import type {
  MessageRequest,
  MessageRequestViewer,
  MessageTask,
  ScheduledMessage,
} from "./types";

const previousTZ = process.env.TZ;
process.env.TZ = "Europe/Berlin";
afterAll(() => {
  process.env.TZ = previousTZ;
});

const now = new Date("2026-11-17T09:00:00Z"); // 10:00 in Berlin
const hours = (value: number) =>
  new Date(now.getTime() + value * 3600_000).toISOString();
const features = ["message_requests", "message_tasks"];

const onMe = (overrides: Partial<MessageTask> = {}) =>
  makeTask({
    assignee: { ...makeTask().assignee, actor_id: "me" },
    ...overrides,
  });

function request(due: string | null): MessageRequest {
  return {
    status: "open",
    closed_reason: null,
    answer: { preset: "yes_no" },
    allow_comment: true,
    due_at: due,
    auto_remind_at: null,
    audience: { kind: "chat", label: "", count: 3 },
    answered_count: 0,
    waiting_count: 3,
    version: 1,
  };
}

const recipient: MessageRequestViewer = {
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

function scheduled(sendAt: string): ScheduledMessage {
  return {
    id: "s1",
    chat_id: "c1",
    thread_root_id: null,
    reply_to_id: null,
    client_msg_id: "s1",
    body: "Напоминаю: в среду мой слот в большом зале",
    body_format: "plain",
    mentioned_actor_ids: [],
    files: [],
    silent: false,
    send_at: sendAt,
    status: "pending",
    failure_reason: null,
    message_id: null,
    version: 1,
  } as unknown as ScheduledMessage;
}

const base = (overrides: Partial<ChatSlotInput> = {}): ChatSlotInput => ({
  viewer: { actorID: "me", chatRole: "member" },
  features,
  locale: "ru",
  tasks: [],
  pins: [],
  scheduled: { count: 0, next: null },
  ...overrides,
});

describe("buildChatSlot", () => {
  it("is empty and hidden when nothing is there", () => {
    expect(buildChatSlot(base(), now)).toEqual({
      items: [],
      initial: null,
      complete: true,
    });
  });

  it("orders the kinds: hot, pinned, requests, tasks, scheduled", () => {
    const slot = buildChatSlot(
      base({
        tasks: [
          makeTaskMessage("t1", onMe({ title: "Аптечка", due_at: hours(2) })),
          makeTaskMessage("t2", makeTask({ title: "График" })),
        ],
        pins: [
          { messageID: "p1", text: "Правила зала" },
          { messageID: "p2", text: "Расписание" },
        ],
        unread: { requests_waiting: 1, requests_next_due_at: hours(72) },
        messages: [
          {
            id: "r1",
            request: request(hours(72)),
            created_seq: 3,
            body: "Кто дежурит?",
          },
        ],
        requestViewers: {
          r1: { viewer: recipient, version: 1, provisional: false },
        },
        scheduled: { count: 2, next: scheduled(hours(23)) },
      }),
      now,
    );
    expect(slot.items.map((item) => [item.kind, item.count])).toEqual([
      ["hot", 1],
      ["pinned", 2],
      ["requests", 1],
      ["tasks", 2],
      ["scheduled", 2],
    ]);
    expect(slot.initial).toBe("hot");
    const [hot, pinned, requests, tasks, later] = slot.items;
    expect(hot).toMatchObject({
      title: "Аптечка",
      caption: "На вас · сегодня, 12:00",
      tone: "danger",
      targetMessageId: "t1",
      targetType: "task",
      canComplete: true,
    });
    expect(pinned).toMatchObject({
      title: "Правила зала",
      caption: "Закреплённое 1 из 2",
      position: { index: 0, total: 2 },
      targetMessageId: "p1",
    });
    expect(requests).toMatchObject({
      tone: "warning",
      targetMessageId: "r1",
      title: "Кто дежурит?",
    });
    expect(requests!.caption.startsWith("Ждут вашего ответа · ")).toBe(true);
    expect(tasks).toMatchObject({
      caption: "Задачи · 2 · на вас 1",
      tone: "accent",
      dot: true,
      mine: 1,
      title: "Аптечка",
    });
    expect(later).toMatchObject({
      caption: "Отложено · завтра, 9:00",
      title: "Напоминаю: в среду мой слот в большом зале",
    });
  });

  it("starts with the first non-empty kind", () => {
    const slot = buildChatSlot(
      base({
        tasks: [makeTaskMessage("t1", makeTask())],
        scheduled: { count: 1, next: scheduled(hours(30)) },
      }),
      now,
    );
    expect(slot.initial).toBe("tasks");
    expect(slot.items[0]).toMatchObject({
      caption: "Задачи · 1",
      tone: "neutral",
      dot: false,
      mine: 0,
    });
  });

  it("puts a burning request into «hot» and out of «requests»", () => {
    const slot = buildChatSlot(
      base({
        unread: { requests_waiting: 2, requests_next_due_at: hours(1) },
        messages: [
          {
            id: "r1",
            request: request(hours(1)),
            created_seq: 1,
            body: "Срочно?",
          },
          { id: "r2", request: request(null), created_seq: 2, body: "Потом" },
        ],
        requestViewers: {
          r1: { viewer: recipient, version: 1, provisional: false },
          r2: { viewer: recipient, version: 1, provisional: false },
        },
      }),
      now,
    );
    expect(slot.items.map((item) => [item.kind, item.count])).toEqual([
      ["hot", 1],
      ["requests", 1],
    ]);
    expect(slot.items[0]).toMatchObject({
      targetMessageId: "r1",
      targetType: "request",
      canComplete: false,
      caption: "Ждут вашего ответа · сегодня, 11:00",
    });
    expect(slot.items[1]).toMatchObject({
      targetMessageId: "r2",
      caption: "Ждут вашего ответа · 1",
    });
  });

  it("knows a burning request outside the loaded feed from /unread", () => {
    const slot = buildChatSlot(
      base({
        unread: { requests_waiting: 1, requests_next_due_at: hours(-1) },
      }),
      now,
    );
    expect(slot.items.map((item) => item.kind)).toEqual(["hot"]);
    expect(slot.items[0]).toMatchObject({
      caption: "Ждут вашего ответа · срок прошёл",
    });
    expect(slot.items[0]!.targetMessageId).toBeUndefined();
  });

  it("orders burning things by due date and counts them together", () => {
    const slot = buildChatSlot(
      base({
        tasks: [
          makeTaskMessage("late", onMe({ due_at: hours(-2) })),
          makeTaskMessage("soon", onMe({ due_at: hours(5) })),
          makeTaskMessage("calm", onMe({ due_at: hours(48) })),
        ],
        unread: { requests_waiting: 1, requests_next_due_at: hours(1) },
        messages: [
          { id: "r1", request: request(hours(1)), created_seq: 1, body: "?" },
        ],
        requestViewers: {
          r1: { viewer: recipient, version: 1, provisional: false },
        },
      }),
      now,
    );
    expect(slot.items[0]).toMatchObject({
      kind: "hot",
      count: 3,
      targetMessageId: "late",
      caption: "На вас · просрочено",
    });
  });

  it("burns tasks of items and queues on the reader, not others' tasks", () => {
    const queue = makeTask({
      due_at: hours(3),
      assignee: {
        kind: "department",
        actor_id: null,
        label: "Зал",
        candidate_ids: ["me", "x"],
        in_chat: false,
      },
    });
    const others = makeTask({ due_at: hours(1) });
    const slot = buildChatSlot(
      base({
        tasks: [makeTaskMessage("q", queue), makeTaskMessage("o", others)],
      }),
      now,
    );
    expect(slot.items[0]).toMatchObject({
      kind: "hot",
      count: 1,
      targetMessageId: "q",
      canComplete: false,
    });
    expect(slot.items[1]).toMatchObject({ kind: "tasks", count: 2, mine: 1 });
  });

  it("uses the server's counts when the page holds only some tasks", () => {
    const slot = buildChatSlot(
      base({
        tasks: [makeTaskMessage("t1", makeTask())],
        taskCounts: { open: 12, mine: 3, mine_hot: 0 },
      }),
      now,
    );
    expect(slot.items[0]).toMatchObject({
      kind: "tasks",
      count: 12,
      mine: 3,
      caption: "Задачи · 12 · на вас 3",
    });
  });

  it("has no task kinds without message_tasks", () => {
    const slot = buildChatSlot(
      base({
        features: ["message_requests"],
        tasks: [makeTaskMessage("t1", onMe({ due_at: hours(1) }))],
      }),
      now,
    );
    expect(slot.items).toEqual([]);
    expect(slot.complete).toBe(true);
  });

  it("leaves closed tasks out", () => {
    const slot = buildChatSlot(
      base({
        tasks: [
          makeTaskMessage("t1", onMe({ status: "done", due_at: hours(1) })),
        ],
      }),
      now,
    );
    expect(slot.items).toEqual([]);
  });

  it("is incomplete until its sources are loaded", () => {
    expect(buildChatSlot(base({ tasks: undefined }), now).complete).toBe(false);
    expect(buildChatSlot(base({ pins: undefined }), now).complete).toBe(false);
    expect(
      buildChatSlot(base({ features: [], tasks: undefined }), now).complete,
    ).toBe(true);
  });

  it("speaks English", () => {
    const slot = buildChatSlot(
      base({
        locale: "en",
        tasks: [makeTaskMessage("t1", onMe({ due_at: hours(-1) }))],
        pins: [{ messageID: "p1", text: "Rules" }],
      }),
      now,
    );
    expect(slot.items.map((item) => item.caption)).toEqual([
      "On you · overdue",
      "Pinned",
      "Tasks · 1 · on you 1",
    ]);
  });

  it("puts «Отсутствует» after the burning ones (wave 4)", () => {
    const slot = buildChatSlot(
      base({
        away: { title: "Анна в отпуске", caption: "до 30 ноября" },
        pins: [{ messageID: "p1", text: "Правила" }],
      }),
      now,
    );
    expect(slot.items.map((item) => item.kind)).toEqual(["away", "pinned"]);
  });
});

describe("slot switching", () => {
  const slot = buildChatSlot(
    base({
      tasks: [makeTaskMessage("t1", makeTask())],
      pins: [
        { messageID: "p1", text: "1" },
        { messageID: "p2", text: "2" },
        { messageID: "p3", text: "3" },
      ],
      pinIndex: 4,
      scheduled: { count: 1, next: scheduled(hours(30)) },
      unread: { requests_waiting: 1, requests_next_due_at: null },
      away: { title: "a", caption: "b" },
      messages: [],
    }),
    now,
  );

  it("keeps the chosen kind while it is there", () => {
    expect(selectSlotItem(slot, "scheduled")?.kind).toBe("scheduled");
    expect(selectSlotItem(slot, "hot")?.kind).toBe("away");
    expect(selectSlotItem(slot, null)?.kind).toBe("away");
  });

  it("shows four icons and hides the rest behind «⋯»", () => {
    const { chips, overflow } = slotChips(slot);
    expect(chips.map((item) => item.kind)).toEqual([
      "away",
      "pinned",
      "requests",
      "tasks",
    ]);
    expect(overflow.map((item) => item.kind)).toEqual(["scheduled"]);
    const single = buildChatSlot(
      base({ pins: [{ messageID: "p", text: "x" }] }),
      now,
    );
    expect(slotChips(single)).toEqual({ chips: [], overflow: [] });
  });

  it("walks the pinned messages", () => {
    expect(slot.items[1]).toMatchObject({
      caption: "Закреплённое 2 из 3",
      targetMessageId: "p2",
    });
    expect(nextPinIndex(1, 3)).toBe(2);
    expect(nextPinIndex(2, 3)).toBe(0);
    expect(nextPinIndex(0, 0)).toBe(0);
  });
});

describe("chatTaskSections", () => {
  it("puts tasks on the reader first, each in due order", () => {
    const sections = chatTaskSections(
      [
        makeTaskMessage("a", makeTask({ due_at: hours(5) })),
        makeTaskMessage("b", onMe({ due_at: hours(30) })),
        makeTaskMessage("c", onMe({ due_at: hours(-1) })),
        makeTaskMessage("d", makeTask({ status: "canceled" })),
        makeTaskMessage("e", makeTask(), { actor_id: "me" }),
      ],
      { actorID: "me", chatRole: "member" },
      now,
    );
    expect(
      sections.mine.map((row) => [
        row.message.id,
        row.hot,
        row.overdue,
        row.canComplete,
      ]),
    ).toEqual([
      ["c", true, true, true],
      ["b", false, false, true],
    ]);
    expect(
      sections.others.map((row) => [row.message.id, row.canComplete]),
    ).toEqual([
      ["a", false],
      ["e", true],
    ]);
  });
});
