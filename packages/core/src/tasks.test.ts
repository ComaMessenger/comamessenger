import { afterAll, describe, expect, it } from "vitest";
import { APIError } from "./api";
import permissionCases from "./fixtures/taskPermissions.json";
import {
  L,
  INSTRUCTOR,
  boris,
  cyril,
  nina,
  oleg,
  structure,
} from "./orgFixture";
import { createMessengerStore, storeTaskCache } from "./store";
import { makeItem, makeTask, makeTaskMessage } from "./taskFixtures";
import {
  absorbEarlyTasks,
  canSetTaskStatus,
  chatTaskBadge,
  emptyTaskDraft,
  groupMyTasks,
  isTaskHot,
  isTaskOnMe,
  isTaskOverdue,
  mergeTaskItems,
  optimisticTakeTask,
  optimisticTaskItemDone,
  optimisticTaskNudge,
  optimisticTaskStatus,
  optimisticTaskUpdate,
  parseTaskEvent,
  performTaskAction,
  reduceTask,
  reduceTaskList,
  rememberTaskUpdate,
  remindBeforeDueAvailable,
  taskAssigneeSegments,
  taskCandidateIDs,
  taskCardView,
  taskDraftFromMessage,
  taskDraftFromTask,
  taskDraftProblem,
  taskDuePresets,
  taskErrorKind,
  taskFromError,
  taskInvalidField,
  taskNudgeState,
  taskPermissions,
  taskRole,
  taskSignature,
  taskTitleFromMessage,
  taskTransitionAllowed,
  taskUpdateInput,
  taskUpdateRefreshesUnread,
  toCreateTaskInput,
  type TaskDraft,
} from "./tasks";
import type {
  ClientMessage,
  DurableEvent,
  MessageTask,
  MyTaskItem,
  TaskStatus,
  User,
} from "./types";

import updatedFixture from "../../protocol/fixtures/realtime/v1/event-task-updated.json";
import notifiedFixture from "../../protocol/fixtures/realtime/v1/event-task-notified.json";

// Berlin time: daylight saving ends on 25 October 2026 (03:00 → 02:00) and
// starts on 29 March 2026.
const previousTZ = process.env.TZ;
process.env.TZ = "Europe/Berlin";
afterAll(() => {
  process.env.TZ = previousTZ;
});

const local = (value: string) => new Date(value);
const iso = (date: Date) => date.toISOString();

describe("taskPermissions: the table shared with the server", () => {
  for (const entry of permissionCases.cases) {
    it(entry.name, () => {
      const task = makeTask({
        status: entry.task.status as TaskStatus,
        assignee: {
          kind: entry.task.assignee.kind as "person",
          actor_id: entry.task.assignee.actor_id,
          label: entry.task.assignee.kind === "person" ? "" : "Отдел",
          candidate_ids: entry.task.assignee.candidate_ids,
          in_chat: true,
        },
        items: entry.task.items.map((item) =>
          makeItem(item.id, { assignee_id: item.assignee_id }),
        ),
        nudge_count: entry.task.nudge_count,
      });
      const result = taskPermissions(task, entry.author_id, {
        actorID: entry.viewer.actor_id,
        chatRole: entry.viewer.chat_role,
        moderator: entry.viewer.moderator,
      });
      expect({
        edit: result.edit,
        reassign: result.reassign,
        start: result.start,
        stop: result.stop,
        complete: result.complete,
        reopen: result.reopen,
        cancel: result.cancel,
        restore: result.restore,
        manage_items: result.manageItems,
        check_items: result.checkItems,
        nudge: result.nudge,
        take: result.take,
      }).toEqual(entry.expect);
    });
  }

  it("a member who left has no rights at all", () => {
    const task = makeTask();
    const result = taskPermissions(task, "author", {
      actorID: "author",
      chatRole: "owner",
      member: false,
    });
    expect(Object.values(result).some((value) => value === true)).toBe(false);
  });
});

describe("status transitions", () => {
  it("follows decision 4", () => {
    const allowed: [TaskStatus, TaskStatus][] = [
      ["open", "in_progress"],
      ["in_progress", "open"],
      ["open", "done"],
      ["in_progress", "done"],
      ["done", "open"],
      ["open", "canceled"],
      ["in_progress", "canceled"],
      ["canceled", "open"],
    ];
    const all: TaskStatus[] = ["open", "in_progress", "done", "canceled"];
    for (const from of all)
      for (const to of all)
        expect([from, to, taskTransitionAllowed(from, to)]).toEqual([
          from,
          to,
          allowed.some(([a, b]) => a === from && b === to),
        ]);
  });

  it("maps buttons to permissions", () => {
    const task = makeTask({ status: "in_progress" });
    const responsible = taskPermissions(task, "author", {
      actorID: "resp",
      chatRole: "member",
    });
    expect(canSetTaskStatus(task, responsible, "open")).toBe(true);
    expect(canSetTaskStatus(task, responsible, "done")).toBe(true);
    expect(canSetTaskStatus(task, responsible, "canceled")).toBe(false);
    expect(canSetTaskStatus(task, responsible, "in_progress")).toBe(false);
  });
});

describe("«горит»", () => {
  const now = new Date("2026-11-15T10:00:00Z");
  it("is overdue or due within 24 hours", () => {
    const at = (ms: number) =>
      makeTask({ due_at: new Date(now.getTime() + ms).toISOString() });
    expect(isTaskHot(at(24 * 3600_000 - 1), now)).toBe(true);
    expect(isTaskHot(at(24 * 3600_000), now)).toBe(false);
    expect(isTaskHot(at(-3600_000), now)).toBe(true);
    expect(isTaskOverdue(at(-1), now)).toBe(true);
    expect(isTaskOverdue(at(0), now)).toBe(true);
    expect(isTaskOverdue(at(60_000), now)).toBe(false);
    expect(isTaskHot(makeTask(), now)).toBe(false);
  });

  it("never burns a closed task", () => {
    const due = new Date(now.getTime() - 60_000).toISOString();
    for (const status of ["done", "canceled"] as const) {
      expect(isTaskHot(makeTask({ due_at: due, status }), now)).toBe(false);
      expect(isTaskOverdue(makeTask({ due_at: due, status }), now)).toBe(false);
    }
    expect(
      isTaskHot(makeTask({ due_at: due, status: "in_progress" }), now),
    ).toBe(true);
  });
});

describe("roles", () => {
  it("prefers responsible, then item, candidate, author", () => {
    const task = makeTask({
      items: [makeItem("i1", { assignee_id: "worker" })],
    });
    expect(taskRole(task, "author", "resp")).toBe("responsible");
    expect(taskRole(task, "author", "worker")).toBe("item");
    expect(taskRole(task, "author", "author")).toBe("author");
    expect(taskRole(task, "author", "other")).toBe(null);
    const done = makeTask({
      items: [
        makeItem("i1", {
          assignee_id: "worker",
          done_at: "x",
          done_by: "worker",
        }),
      ],
    });
    expect(taskRole(done, "author", "worker")).toBe(null);
    const queue = makeTask({
      assignee: {
        kind: "position",
        actor_id: null,
        label: "Инструктор",
        candidate_ids: ["c1", "c2"],
        in_chat: false,
      },
    });
    expect(taskRole(queue, "author", "c2")).toBe("candidate");
    expect(isTaskOnMe(queue, "c2")).toBe(true);
    expect(isTaskOnMe({ ...queue, status: "done" }, "c2")).toBe(false);
    expect(
      isTaskOnMe(
        { ...queue, assignee: { ...queue.assignee, actor_id: "c1" } },
        "c2",
      ),
    ).toBe(false);
  });
});

describe("taskDuePresets", () => {
  it("offers today 18:00, tomorrow 12:00 and the next workday 9:00", () => {
    // Tuesday 17 November, 10:00.
    const presets = taskDuePresets(local("2026-11-17T10:00:00"));
    expect(presets.map((preset) => [preset.id, iso(preset.at)])).toEqual([
      ["today", iso(local("2026-11-17T18:00:00"))],
      ["tomorrow", iso(local("2026-11-18T12:00:00"))],
      ["nextWorkday", iso(local("2026-11-18T09:00:00"))],
    ]);
  });

  it("drops today in the evening", () => {
    const presets = taskDuePresets(local("2026-11-17T17:10:00"));
    expect(presets.map((preset) => preset.id)).toEqual([
      "tomorrow",
      "nextWorkday",
    ]);
  });

  it("skips the weekend on a Friday", () => {
    // Friday 20 November, evening.
    const presets = taskDuePresets(local("2026-11-20T19:00:00"));
    expect(presets.map((preset) => [preset.id, iso(preset.at)])).toEqual([
      ["tomorrow", iso(local("2026-11-21T12:00:00"))],
      ["nextWorkday", iso(local("2026-11-23T09:00:00"))],
    ]);
  });

  it("keeps 9:00 across the change to summer time", () => {
    // Saturday 28 March 2026; the clocks go forward on Sunday night.
    const presets = taskDuePresets(local("2026-03-28T10:00:00"));
    const workday = presets.find((preset) => preset.id === "nextWorkday")!;
    expect(workday.at.getDate()).toBe(30);
    expect(workday.at.getHours()).toBe(9);
    expect(iso(workday.at)).toBe("2026-03-30T07:00:00.000Z");
  });

  it("offers the reminder only with an hour left", () => {
    const now = local("2026-11-17T10:00:00");
    expect(remindBeforeDueAvailable(null, now)).toBe(false);
    expect(
      remindBeforeDueAvailable(new Date(now.getTime() + 59 * 60_000), now),
    ).toBe(false);
    expect(
      remindBeforeDueAvailable(new Date(now.getTime() + 60 * 60_000), now),
    ).toBe(true);
  });
});

describe("the form", () => {
  const now = new Date("2026-11-17T09:00:00Z");
  const draft = (overrides: Partial<TaskDraft> = {}): TaskDraft => ({
    ...emptyTaskDraft(),
    title: "Проверить аптечку",
    assignee: { kind: "person", actorID: "resp" },
    ...overrides,
  });

  it("checks fields in order", () => {
    expect(taskDraftProblem(draft({ title: "  " }), now)).toEqual({
      field: "title",
      reason: "empty",
    });
    expect(taskDraftProblem(draft({ title: "я".repeat(201) }), now)).toEqual({
      field: "title",
      reason: "tooLong",
    });
    expect(
      taskDraftProblem(draft({ description: "a".repeat(4001) }), now),
    ).toEqual({ field: "description", reason: "tooLong" });
    expect(
      taskDraftProblem(
        draft({ assignee: { kind: "person", actorID: null } }),
        now,
      ),
    ).toEqual({ field: "assignee", reason: "empty" });
    const queue = draft({
      assignee: { kind: "department", departmentID: "d1" },
    });
    expect(taskDraftProblem(queue, now, 0)).toEqual({
      field: "assignee",
      reason: "audienceEmpty",
    });
    expect(taskDraftProblem(queue, now, 101)).toEqual({
      field: "assignee",
      reason: "tooMany",
    });
    expect(taskDraftProblem(queue, now, 3)).toBe(null);
    expect(
      taskDraftProblem(
        draft({ dueAt: new Date(now.getTime() + 4 * 60_000) }),
        now,
      ),
    ).toEqual({ field: "dueAt", reason: "past" });
    expect(
      taskDraftProblem(
        draft({ dueAt: new Date(now.getTime() + 366 * 86_400_000) }),
        now,
      ),
    ).toEqual({ field: "dueAt", reason: "tooFar" });
    const items = Array.from({ length: 31 }, (_, index) => ({
      key: String(index),
      text: `п${index}`,
      assigneeID: null,
    }));
    expect(taskDraftProblem(draft({ items }), now)).toEqual({
      field: "items",
      reason: "tooMany",
    });
    expect(
      taskDraftProblem(
        draft({
          items: [
            { key: "a", text: "   ", assigneeID: null },
            { key: "b", text: "ok", assigneeID: null },
            { key: "c", text: "x".repeat(201), assigneeID: null },
          ],
        }),
        now,
      ),
    ).toEqual({ field: "items", reason: "tooLong", index: 1 });
    expect(taskDraftProblem(draft(), now)).toBe(null);
  });

  it("builds createTask, dropping the reminder it cannot have", () => {
    const due = new Date(now.getTime() + 30 * 60_000);
    const input = toCreateTaskInput(
      draft({
        title: "  Проверить аптечку ",
        description: " в большом зале ",
        dueAt: due,
        items: [
          { key: "a", text: " бинты ", assigneeID: "w1" },
          { key: "b", text: "", assigneeID: null },
          { key: "c", text: "пластырь", assigneeID: null },
        ],
        sourceMessageID: "m0",
      }),
      "client-1",
      now,
    );
    expect(input).toEqual({
      client_msg_id: "client-1",
      title: "Проверить аптечку",
      description: "в большом зале",
      assignee: { kind: "person", actor_id: "resp" },
      due_at: due.toISOString(),
      remind_before_due: false,
      items: [{ text: "бинты", assignee_id: "w1" }, { text: "пластырь" }],
      source_message_id: "m0",
    });
    const later = toCreateTaskInput(
      draft({ dueAt: new Date(now.getTime() + 3 * 3600_000) }),
      "client-2",
      now,
    );
    expect(later.remind_before_due).toBe(true);
    expect(toCreateTaskInput(draft(), "c", now).remind_before_due).toBe(false);
    const position = toCreateTaskInput(
      draft({ assignee: { kind: "position", positionID: "p1" } }),
      "c",
      now,
    );
    expect(position.assignee).toEqual({ kind: "position", position_id: "p1" });
    expect(taskSignature(later)).toBe(
      taskSignature({ ...later, client_msg_id: "other" }),
    );
    expect(taskSignature(later)).not.toBe(taskSignature(input));
  });

  it("turns a message into a title", () => {
    expect(taskTitleFromMessage("**Срочно:** проверьте\n\n_аптечку_  ")).toBe(
      "Срочно: проверьте аптечку",
    );
    const long = `${"слово ".repeat(40)}конец`;
    const title = taskTitleFromMessage(long);
    expect([...title].length).toBeLessThanOrEqual(200);
    expect(title.endsWith("слово")).toBe(true);
    const solid = "я".repeat(250);
    expect(taskTitleFromMessage(solid)).toBe("я".repeat(200));
    const draftFrom = taskDraftFromMessage({ id: "m1", body: "Купить бинты" });
    expect(draftFrom.title).toBe("Купить бинты");
    expect(draftFrom.sourceMessageID).toBe("m1");
    expect(draftFrom.dueAt).toBe(null);
    expect(draftFrom.assignee).toEqual({ kind: "person", actorID: null });
  });

  it("offers departments and positions to those who may address groups", () => {
    const owner = { role: "owner", permissions: [] } as unknown as User;
    const member = { role: "member", permissions: [] } as unknown as User;
    const all = ["message_tasks", "org_structure"];
    expect(taskAssigneeSegments(owner, all)).toEqual([
      "person",
      "department",
      "position",
    ]);
    expect(taskAssigneeSegments(member, all)).toEqual(["person"]);
    expect(taskAssigneeSegments(owner, ["message_tasks"])).toEqual(["person"]);
  });

  it("expands a queue to the people of the chat", () => {
    const org = structure();
    const members = [oleg, cyril, nina, "author"].map((actor_id) => ({
      actor_id,
      type: "user" as const,
    }));
    // Зал ЛФК: Олег, Борис (not in the chat), Кирилл as an additional member.
    expect(
      taskCandidateIDs(
        { kind: "department", departmentID: L },
        members,
        org,
      ).sort(),
    ).toEqual([cyril, oleg].sort());
    expect(
      taskCandidateIDs(
        { kind: "position", positionID: INSTRUCTOR },
        [...members, { actor_id: boris, type: "user" as const }],
        org,
      ).sort(),
    ).toEqual([cyril, oleg].sort());
    expect(
      taskCandidateIDs({ kind: "department", departmentID: L }, members, null),
    ).toEqual([]);
    expect(
      taskCandidateIDs({ kind: "person", actorID: "x" }, members, org),
    ).toEqual([]);
  });
});

describe("the edit screen", () => {
  const now = new Date("2026-11-17T09:00:00Z");
  const task = makeTask({
    due_at: "2026-11-18T12:00:00.000Z",
    remind_before_due: true,
    version: 4,
  });

  it("sends only what changed", () => {
    const draft = taskDraftFromTask(task);
    expect(taskUpdateInput(task, draft, now)).toBe(null);
    expect(taskUpdateInput(task, { ...draft, title: "Новое" }, now)).toEqual({
      expected_version: 4,
      title: "Новое",
    });
    expect(taskUpdateInput(task, { ...draft, dueAt: null }, now)).toEqual({
      expected_version: 4,
      due_at: null,
      remind_before_due: false,
    });
    expect(
      taskUpdateInput(
        task,
        { ...draft, assignee: { kind: "person", actorID: "other" } },
        now,
      ),
    ).toEqual({
      expected_version: 4,
      assignee: { kind: "person", actor_id: "other" },
    });
  });

  it("shows a taken queue as its person", () => {
    const taken = makeTask({
      assignee: {
        kind: "department",
        actor_id: "c1",
        label: "Соцслужба",
        candidate_ids: ["c1"],
        in_chat: true,
        department_id: "d1",
      },
    });
    expect(taskDraftFromTask(taken).assignee).toEqual({
      kind: "person",
      actorID: "c1",
    });
    const queue = makeTask({
      assignee: { ...taken.assignee, actor_id: null },
    });
    expect(taskDraftFromTask(queue).assignee).toEqual({
      kind: "department",
      departmentID: "d1",
    });
  });
});

describe("the card", () => {
  const now = new Date("2026-11-17T09:00:00Z");

  it("says overdue, suggests closing and the nudge state", () => {
    const task = makeTask({
      due_at: "2026-11-17T08:00:00Z",
      items: [makeItem("i1", { done_at: "x", done_by: "resp" })],
      last_nudge_at: "2026-11-17T08:30:00Z",
      nudge_count: 1,
    });
    const message = makeTaskMessage("m1", task);
    const responsible = taskCardView(
      message,
      { actorID: "resp", chatRole: "member" },
      now,
    );
    expect(responsible.pill).toEqual({ kind: "overdue" });
    expect(responsible.hot).toBe(true);
    expect(responsible.suggestComplete).toBe(true);
    expect(responsible.nudge).toEqual({ kind: "hidden" });
    const author = taskCardView(
      message,
      { actorID: "author", chatRole: "member" },
      now,
    );
    expect(author.nudge).toEqual({
      kind: "cooldown",
      until: new Date("2026-11-17T10:30:00Z"),
      left: 4,
    });
    expect(
      taskNudgeState(
        task,
        author.permissions,
        new Date("2026-11-17T10:30:00Z"),
      ),
    ).toEqual({ kind: "ready", left: 4 });
    const other = taskCardView(
      message,
      { actorID: "other", chatRole: "member" },
      now,
    );
    expect(other.suggestComplete).toBe(false);
    expect(other.permissions.complete).toBe(false);
  });

  it("tells an empty queue and an absent assignee", () => {
    const queue = makeTask({
      assignee: {
        kind: "department",
        actor_id: null,
        label: "Соцслужба",
        candidate_ids: ["c1"],
        in_chat: false,
      },
    });
    const view = taskCardView(
      makeTaskMessage("m1", queue),
      { actorID: "author", chatRole: "member" },
      now,
      new Set(["author"]),
    );
    expect(view.queue).toBe(true);
    expect(view.queueEmpty).toBe(true);
    expect(view.assigneeAway).toBe(false);
    const away = makeTask({
      assignee: { ...makeTask().assignee, in_chat: false },
    });
    expect(
      taskCardView(
        makeTaskMessage("m2", away),
        { actorID: "author", chatRole: "member" },
        now,
      ).assigneeAway,
    ).toBe(true);
  });
});

function event(type: string, data: unknown, seq = 10): DurableEvent {
  return {
    op: "event",
    seq,
    type,
    occurred_at: "2026-11-17T09:00:00Z",
    actor_id: "x",
    chat_id: "c1",
    subject_id: "m1",
    data: data as Record<string, unknown>,
  } as DurableEvent;
}

describe("realtime", () => {
  it("parses the protocol fixtures", () => {
    const updated = parseTaskEvent(updatedFixture as unknown as DurableEvent);
    expect(updated?.type).toBe("task.updated");
    if (updated?.type === "task.updated")
      expect(updated.data.task.version).toBe(3);
    const notified = parseTaskEvent(notifiedFixture as unknown as DurableEvent);
    expect(notified?.type).toBe("task.notified");
    expect(
      parseTaskEvent(
        event("task.notified", { message_id: "m", chat_id: "c", kind: "boom" }),
      ),
    ).toBe(null);
    expect(
      parseTaskEvent(
        event("task.updated", {
          message_id: "m",
          chat_id: "c",
          task: { title: 1 },
        }),
      ),
    ).toBe(null);
  });

  it("applies task.updated by version, in any order", () => {
    const message = makeTaskMessage("m1", makeTask({ version: 2 }));
    const v3 = makeTask({ version: 3, status: "in_progress" });
    const v4 = makeTask({ version: 4, status: "done" });
    const after4 = reduceTask(message, { message_id: "m1", task: v4 });
    expect(after4.task?.status).toBe("done");
    expect(reduceTask(after4, { message_id: "m1", task: v3 })).toBe(after4);
    expect(
      reduceTask(message, { message_id: "m1", task: makeTask({ version: 2 }) }),
    ).toBe(message);
    expect(reduceTask(message, { message_id: "other", task: v4 })).toBe(
      message,
    );
  });

  it("keeps task.updated that came before message.created", () => {
    let early = rememberTaskUpdate(
      {},
      {
        message_id: "m1",
        task: makeTask({ version: 3 }),
      },
    );
    early = rememberTaskUpdate(early, {
      message_id: "m1",
      task: makeTask({ version: 2 }),
    });
    expect(early.m1?.version).toBe(3);
    const created = makeTaskMessage("m1", makeTask({ version: 1 }));
    const result = absorbEarlyTasks(early, [created]);
    expect(result.messages[0]!.task?.version).toBe(3);
    expect(result.early).toEqual({});
  });

  it("does it in the store too", () => {
    const store = createMessengerStore();
    store.getState().apply(
      event(
        "task.updated",
        {
          message_id: "m1",
          chat_id: "c1",
          task: makeTask({ version: 3, status: "in_progress" }),
        },
        1,
      ),
    );
    expect(store.getState().earlyTasks.m1?.version).toBe(3);
    store
      .getState()
      .apply(
        event(
          "message.created",
          makeTaskMessage("m1", makeTask({ version: 1 })),
          2,
        ),
      );
    expect(store.getState().taskOf("m1")?.status).toBe("in_progress");
    expect(store.getState().earlyTasks).toEqual({});
    // An older frame of the message does not take the task back.
    store
      .getState()
      .apply(
        event(
          "message.updated",
          { ...makeTaskMessage("m1", makeTask({ version: 2 })), version: 2 },
          3,
        ),
      );
    expect(store.getState().taskOf("m1")?.version).toBe(3);
    store.getState().apply(
      event(
        "task.updated",
        {
          message_id: "m1",
          chat_id: "c1",
          task: makeTask({ version: 4, status: "done" }),
        },
        4,
      ),
    );
    expect(store.getState().taskOf("m1")?.status).toBe("done");
    store.getState().apply(
      event(
        "task.notified",
        {
          message_id: "m1",
          chat_id: "c1",
          kind: "completed",
          by_actor_id: "resp",
          due_at: null,
        },
        5,
      ),
    );
    expect(store.getState().checkpoint).toBe(5);
    // A page read before the event but loaded after it keeps the newer task.
    store
      .getState()
      .replaceMessages("c1", [
        makeTaskMessage("m1", makeTask({ version: 3 })) as ClientMessage,
      ]);
    expect(store.getState().taskOf("m1")?.version).toBe(4);
  });

  it("tells when /unread is stale", () => {
    const mine = makeTask({
      assignee: { ...makeTask().assignee, actor_id: "me" },
    });
    const theirs = makeTask();
    expect(taskUpdateRefreshesUnread(null, mine, "me")).toBe(true);
    expect(taskUpdateRefreshesUnread(mine, theirs, "me")).toBe(true);
    expect(taskUpdateRefreshesUnread(theirs, theirs, "me")).toBe(false);
    expect(
      taskUpdateRefreshesUnread(mine, { ...mine, status: "done" }, "me"),
    ).toBe(true);
  });
});

describe("lists", () => {
  const now = new Date("2026-11-17T10:00:00");
  const row = (id: string, task: MessageTask, seq = 1): MyTaskItem => ({
    message: makeTaskMessage(id, task, { created_seq: seq }),
    author: {
      actor_id: "author",
      display_name: "Марина",
      type: "user",
      avatar_version: 0,
    } as MyTaskItem["author"],
    chat: { id: "c1", kind: "group", display_name: "Зал" },
    my_role: "responsible",
  });

  it("groups «Мои задачи» as prototype E", () => {
    const groups = groupMyTasks(
      [
        row("later", makeTask({ due_at: iso(local("2026-11-19T12:00:00")) })),
        row("none-old", makeTask(), 1),
        row("none-new", makeTask(), 5),
        row("today", makeTask({ due_at: iso(local("2026-11-17T18:00:00")) })),
        row("late", makeTask({ due_at: iso(local("2026-11-16T18:00:00")) })),
        row(
          "done",
          makeTask({
            status: "done",
            status_changed_at: "2026-11-16T10:00:00Z",
          }),
        ),
        row(
          "done2",
          makeTask({
            status: "done",
            status_changed_at: "2026-11-17T08:00:00Z",
          }),
        ),
        row("canceled", makeTask({ status: "canceled" })),
      ],
      now,
    );
    expect(
      groups.map((group) => [
        group.kind,
        group.items.map((item) => item.message.id),
      ]),
    ).toEqual([
      ["overdue", ["late"]],
      ["today", ["today"]],
      ["later", ["later"]],
      ["noDue", ["none-new", "none-old"]],
      ["done", ["done2", "done"]],
    ]);
  });

  it("reduces list pages and keeps the fresher copy", () => {
    const items = [row("m1", makeTask({ version: 1 })), row("m2", makeTask())];
    const closed = reduceTaskList(
      items,
      { message_id: "m1", task: makeTask({ version: 2, status: "done" }) },
      { list: "authored" },
    );
    expect(closed.items.map((item) => item.message.id)).toEqual(["m2"]);
    const taken = reduceTaskList(
      items,
      {
        message_id: "m1",
        task: makeTask({
          version: 2,
          assignee: { ...makeTask().assignee, actor_id: "someone" },
        }),
      },
      { list: "assigned", me: "resp" },
    );
    expect(taken.items).toHaveLength(1);
    const unknown = reduceTaskList(
      items,
      { message_id: "m9", task: makeTask() },
      { list: "chatOpen" },
    );
    expect(unknown.stale).toBe(true);
    const messages = [makeTaskMessage("m1", makeTask({ version: 1 }))];
    const updated = reduceTaskList(
      messages,
      { message_id: "m1", task: makeTask({ version: 2, title: "Новое" }) },
      { list: "chatOpen" },
    );
    expect(updated.items[0]!.task.title).toBe("Новое");
    expect(
      mergeTaskItems(
        [row("m1", makeTask({ version: 1 }))],
        [row("m1", makeTask({ version: 3 }))],
      )[0]!.message.task?.version,
    ).toBe(3);
  });

  it("marks a chat only when a task on the reader burns", () => {
    const now = new Date("2026-11-17T09:00:00Z");
    expect(chatTaskBadge({ tasks_mine_open: 0 }, now)).toBe(null);
    expect(
      chatTaskBadge(
        { tasks_mine_open: 2, tasks_mine_next_due_at: "2026-11-19T09:00:00Z" },
        now,
      ),
    ).toBe(null);
    expect(
      chatTaskBadge(
        { tasks_mine_open: 1, tasks_mine_next_due_at: "2026-11-17T11:00:00Z" },
        now,
      ),
    ).toEqual({ kind: "due", at: new Date("2026-11-17T11:00:00Z") });
    expect(
      chatTaskBadge(
        { tasks_mine_open: 1, tasks_mine_next_due_at: "2026-11-17T08:00:00Z" },
        now,
      ),
    ).toEqual({ kind: "overdue" });
    expect(
      chatTaskBadge({ tasks_mine_open: 1, tasks_mine_next_due_at: null }, now),
    ).toBe(null);
  });
});

describe("optimistic actions", () => {
  const now = new Date("2026-11-17T09:00:00Z");

  it("changes status, takes, ticks and nudges", () => {
    const task = makeTask({
      items: [makeItem("i1"), makeItem("i2")],
      version: 5,
    });
    const done = optimisticTaskStatus(task, "done", "resp", "author", now)!;
    expect(done.status).toBe("done");
    expect(done.version).toBe(5);
    expect(done.status_changed_by).toBe("resp");
    expect(
      optimisticTaskStatus(done, "in_progress", "resp", "author", now),
    ).toBe(null);
    const canceled = optimisticTaskStatus(
      task,
      "canceled",
      "admin",
      "author",
      now,
    )!;
    expect(canceled.canceled_reason).toBe("moderator");
    expect(
      optimisticTaskStatus(task, "canceled", "author", "author", now)!
        .canceled_reason,
    ).toBe("author");
    expect(
      optimisticTaskStatus(canceled, "open", "author", "author", now)!
        .canceled_reason,
    ).toBe(null);
    const ticked = optimisticTaskItemDone(task, "i2", true, "resp", now)!;
    expect(ticked.items_done).toBe(1);
    expect(ticked.items[1]!.done_by).toBe("resp");
    expect(optimisticTaskItemDone(task, "nope", true, "resp", now)).toBe(null);
    const queue = makeTask({
      assignee: {
        kind: "department",
        actor_id: null,
        label: "Соцслужба",
        candidate_ids: ["c1"],
        in_chat: false,
      },
    });
    expect(optimisticTakeTask(queue, "c1")!.assignee.actor_id).toBe("c1");
    expect(optimisticTakeTask(queue, "c2")).toBe(null);
    expect(optimisticTaskNudge(task, now)).toMatchObject({
      nudge_count: 1,
      last_nudge_at: now.toISOString(),
    });
    expect(
      optimisticTaskUpdate(task, {
        expected_version: 5,
        title: "Новое",
        due_at: null,
      }),
    ).toMatchObject({ title: "Новое", due_at: null });
  });

  it("writes at once, keeps the server's reply, rolls back on an error", async () => {
    const store = createMessengerStore();
    const original = makeTask({ version: 2 });
    store
      .getState()
      .replaceMessages("c1", [
        makeTaskMessage("m1", original) as ClientMessage,
      ]);
    const cache = storeTaskCache(store, "m1", "c1");

    const optimistic = optimisticTaskStatus(
      original,
      "done",
      "resp",
      "author",
      now,
    );
    let seen: MessageTask | null = null;
    await performTaskAction(cache, optimistic, async () => {
      seen = cache.read();
      return makeTaskMessage("m1", makeTask({ version: 3, status: "done" }));
    });
    expect(seen!.status).toBe("done");
    expect(cache.read()).toMatchObject({ version: 3, status: "done" });

    const before = cache.read()!;
    await expect(
      performTaskAction(
        cache,
        optimisticTaskStatus(before, "open", "resp", "author", now),
        async () => {
          throw new APIError(403, "task_forbidden", "no");
        },
      ),
    ).rejects.toThrow();
    expect(cache.read()).toBe(before);
  });

  it("puts the current task of a conflict in and keeps newer events", async () => {
    const store = createMessengerStore();
    store
      .getState()
      .replaceMessages("c1", [
        makeTaskMessage("m1", makeTask({ version: 2 })) as ClientMessage,
      ]);
    const cache = storeTaskCache(store, "m1");
    const current = makeTask({
      version: 4,
      assignee: { ...makeTask().assignee, actor_id: "c2" },
    });
    const error = new APIError(409, "task_already_taken", "taken", {
      task: current,
    });
    expect(taskFromError(error)?.version).toBe(4);
    await expect(
      performTaskAction(
        cache,
        makeTask({ version: 2, title: "opt" }),
        async () => {
          throw error;
        },
      ),
    ).rejects.toBe(error);
    expect(cache.read()?.assignee.actor_id).toBe("c2");

    // A task.updated during the call wins over the rollback.
    await expect(
      performTaskAction(
        cache,
        makeTask({ version: 4, title: "opt" }),
        async () => {
          store.getState().apply(
            event(
              "task.updated",
              {
                message_id: "m1",
                chat_id: "c1",
                task: makeTask({ version: 6, title: "server" }),
              },
              50,
            ),
          );
          throw new APIError(500, "request_failed", "boom");
        },
      ),
    ).rejects.toThrow();
    expect(cache.read()?.title).toBe("server");
  });
});

describe("errors", () => {
  it("names them for the toast", () => {
    expect(taskErrorKind(new Error("offline"))).toBe("network");
    expect(taskErrorKind(new APIError(409, "task_version_conflict", ""))).toBe(
      "conflict",
    );
    expect(taskErrorKind(new APIError(409, "task_already_taken", ""))).toBe(
      "alreadyTaken",
    );
    expect(taskErrorKind(new APIError(429, "task_nudge_too_soon", ""))).toBe(
      "nudgeTooSoon",
    );
    expect(taskErrorKind(new APIError(501, "not_implemented", ""))).toBe(
      "unavailable",
    );
    expect(
      taskInvalidField(
        new APIError(422, "task_invalid", "", { field: "due_at" }),
      ),
    ).toBe("due_at");
    expect(taskFromError(new APIError(409, "task_status_invalid", ""))).toBe(
      null,
    );
  });
});
