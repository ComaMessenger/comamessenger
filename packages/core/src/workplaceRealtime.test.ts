import { describe, expect, it, vi } from "vitest";
import type { MessengerAPI } from "./api";
import {
  createUnreadRefresher,
  hasServerFeature,
  RealtimeCoordinator,
  refreshesUnread,
  workplaceFeatures,
  type CheckpointStorage,
} from "./realtime";
import { optimisticAnswer, requestView } from "./requests";
import { createMessengerStore } from "./store";
import { makeTask } from "./taskFixtures";
import type {
  ClientMessage,
  DurableEvent,
  MessageRequest,
  MessageRequestViewer,
} from "./types";

function request(overrides: Partial<MessageRequest> = {}): MessageRequest {
  return {
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
    ...overrides,
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

function message(overrides: Partial<ClientMessage> = {}): ClientMessage {
  return {
    id: "m1",
    chat_id: "c1",
    actor_id: "author",
    client_msg_id: "cm1",
    type: "request",
    body: "Планёрка в понедельник. Будете?",
    body_format: "plain",
    version: 1,
    created_seq: 10,
    created_at: "2026-11-12T08:00:00Z",
    mentioned_actor_ids: [],
    thread_reply_count: 0,
    files: [],
    request: request(),
    ...overrides,
  };
}

let seq = 100;
function durable(type: string, data: Record<string, unknown>): DurableEvent {
  seq += 1;
  return {
    op: "event",
    seq,
    type,
    occurred_at: "2026-11-12T09:00:00Z",
    actor_id: "x",
    chat_id: "c1",
    subject_id: "m1",
    data,
  };
}

const t = (key: string) => key;

describe("features", () => {
  it("knows what the server announced", () => {
    expect(hasServerFeature(undefined, "message_requests")).toBe(false);
    expect(workplaceFeatures(["message_requests"])).toEqual({
      requests: true,
      reminders: false,
      tasks: false,
      polls: false,
      away: false,
    });
    expect(
      workplaceFeatures(
        new Set(["message_requests", "message_reminders", "message_tasks"]),
      ),
    ).toEqual({
      requests: true,
      reminders: true,
      tasks: true,
      polls: false,
      away: false,
    });
  });

  it("reports hello features to the client after every connect", async () => {
    const socket = {
      readyState: 1,
      send: () => undefined,
      close: () => undefined,
      onopen: null as ((event: unknown) => void) | null,
      onmessage: null as ((event: { data: string }) => void) | null,
      onclose: null as ((event: unknown) => void) | null,
    };
    const storage: CheckpointStorage = {
      get: async () => 0,
      set: async () => undefined,
      clear: async () => undefined,
    };
    const api = {
      token: () => "token",
      refresh: async () => undefined,
      websocketURL: () => "ws://test",
    } as unknown as MessengerAPI;
    const seen: (readonly string[])[] = [];
    const coordinator = new RealtimeCoordinator(api, storage, () => socket, {
      state: () => undefined,
      event: () => true,
      resync: async () => undefined,
      features: (value) => seen.push(value),
    });
    coordinator.start();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(coordinator.hasFeature("message_requests")).toBe(false);
    socket.onmessage?.({
      data: JSON.stringify({
        op: "hello",
        current_seq: 0,
        features: ["typing_actions", "message_requests"],
      }),
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(seen).toEqual([["typing_actions", "message_requests"]]);
    expect(coordinator.hasFeature("message_requests")).toBe(true);
    expect(coordinator.serverFeatures()).toEqual([
      "typing_actions",
      "message_requests",
    ]);
    coordinator.stop();
  });
});

describe("unread refresh", () => {
  it("follows the events that change what waits for the reader", () => {
    expect(refreshesUnread({ type: "request.assigned", data: {} })).toBe(true);
    expect(refreshesUnread({ type: "request.answer.updated", data: {} })).toBe(
      true,
    );
    expect(refreshesUnread({ type: "reminder.fired", data: {} })).toBe(true);
    expect(
      refreshesUnread({ type: "request.updated", data: { status: "closed" } }),
    ).toBe(true);
    expect(
      refreshesUnread({ type: "request.updated", data: { status: "open" } }),
    ).toBe(false);
    expect(refreshesUnread({ type: "request.tally.updated", data: {} })).toBe(
      false,
    );
    expect(refreshesUnread({ type: "message.created", data: {} })).toBe(false);
  });

  it("glues a burst into one read 500 ms after the last event", () => {
    vi.useFakeTimers();
    try {
      const load = vi.fn();
      const refresher = createUnreadRefresher(load);
      refresher.request();
      vi.advanceTimersByTime(300);
      refresher.request();
      vi.advanceTimersByTime(499);
      expect(load).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(load).toHaveBeenCalledTimes(1);
      refresher.request();
      refresher.cancel();
      vi.advanceTimersByTime(1000);
      expect(load).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("messenger store: requests", () => {
  it("moves request_viewer of feed pages into the viewer map", () => {
    const store = createMessengerStore();
    store.getState().replaceMessages("c1", [
      message({ request_viewer: { ...recipient, can_close: true } }),
      message({
        id: "plain",
        client_msg_id: "p",
        type: "text",
        request: null,
        created_seq: 11,
      }),
    ]);
    const state = store.getState();
    expect(state.messages.c1?.[0]).not.toHaveProperty("request_viewer");
    expect(state.requestViewers.m1).toMatchObject({
      version: 1,
      provisional: false,
      viewer: { can_close: true },
    });
    expect(state.requestViewers).not.toHaveProperty("plain");
  });

  it("shows buttons when request.assigned comes before the message", () => {
    const store = createMessengerStore(100);
    store.getState().apply(
      durable("request.assigned", {
        message_id: "m1",
        chat_id: "c1",
        due_at: null,
      }),
    );
    store
      .getState()
      .apply(
        durable(
          "message.created",
          message() as unknown as Record<string, unknown>,
        ),
      );
    const state = store.getState();
    const view = requestView(
      state.messages.c1![0]!,
      state.requestViewers.m1?.viewer,
      {
        selfID: "me",
        now: new Date("2026-11-12T09:00:00Z"),
        t,
      },
    );
    expect(view?.showButtons).toBe(true);
    expect(view?.notForYou).toBe(false);
  });

  it("applies counts by version, even out of order, and saves the checkpoint", () => {
    const store = createMessengerStore(100);
    store.getState().replaceMessages("c1", [message()]);
    const v3 = durable("request.updated", {
      message_id: "m1",
      chat_id: "c1",
      status: "open",
      closed_reason: null,
      answered_count: 2,
      waiting_count: 1,
      version: 3,
    });
    const v2 = durable("request.updated", {
      message_id: "m1",
      chat_id: "c1",
      status: "open",
      closed_reason: null,
      answered_count: 1,
      waiting_count: 2,
      version: 2,
    });
    expect(store.getState().apply(v3)).toBe(true);
    expect(store.getState().apply(v2)).toBe(true);
    expect(store.getState().checkpoint).toBe(v2.seq);
    expect(store.getState().messages.c1![0]!.request).toMatchObject({
      answered_count: 2,
      version: 3,
    });
    // A REST copy older than what events brought does not undo them.
    store
      .getState()
      .reconcile(
        message({ request: request({ version: 2, answered_count: 1 }) }),
      );
    expect(store.getState().messages.c1![0]!.request?.version).toBe(3);
    // A malformed event is skipped but its seq is kept.
    const bad = durable("request.updated", { message_id: "m1" });
    expect(store.getState().apply(bad)).toBe(true);
    expect(store.getState().checkpoint).toBe(bad.seq);
  });

  it("reads the request again when an answer with a comment came from another device", async () => {
    const store = createMessengerStore(100);
    store
      .getState()
      .replaceMessages("c1", [message({ request_viewer: recipient })]);
    const loader = vi.fn(async () => ({
      request: request({ version: 2, answered_count: 1, waiting_count: 2 }),
      viewer: {
        ...recipient,
        can_change: true,
        answer: {
          option: 0,
          comment: "буду к 9",
          answered_at: "2026-11-12T09:00:00Z",
          late: false,
          version: 1,
        },
      },
    }));
    store.getState().setRequestLoader(loader);
    store.getState().apply(
      durable("request.answer.updated", {
        message_id: "m1",
        chat_id: "c1",
        option: 0,
        has_comment: true,
        late: false,
        version: 1,
      }),
    );
    expect(store.getState().requestViewers.m1?.viewer.answer?.option).toBe(0);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(loader).toHaveBeenCalledWith("m1");
    expect(store.getState().requestViewers.m1?.viewer.answer?.comment).toBe(
      "буду к 9",
    );
    expect(store.getState().messages.c1![0]!.request?.answered_count).toBe(1);
  });

  it("answers optimistically and rolls back", () => {
    const store = createMessengerStore();
    store
      .getState()
      .replaceMessages("c1", [message({ request_viewer: recipient })]);
    const before = store.getState().requestEntry("m1");
    store
      .getState()
      .setRequestEntry(
        "m1",
        optimisticAnswer(
          before,
          1,
          undefined,
          new Date("2026-11-12T09:00:00Z"),
        ),
      );
    expect(store.getState().requestViewers.m1?.viewer.answer?.option).toBe(1);
    expect(store.getState().messages.c1![0]!.request?.answered_count).toBe(1);
    store.getState().setRequestEntry("m1", before);
    expect(store.getState().requestViewers.m1?.viewer.answer).toBeNull();
    expect(store.getState().messages.c1![0]!.request?.answered_count).toBe(0);
  });

  it("keeps a viewer whose message is not loaded, and forgets them on resync", () => {
    const store = createMessengerStore();
    store.getState().setRequestState("elsewhere", {
      request: request({ version: 5 }),
      viewer: { ...recipient, role: "author" },
    });
    expect(store.getState().requestViewers.elsewhere?.viewer.role).toBe(
      "author",
    );
    store.getState().setFeatures(["message_requests"]);
    expect(store.getState().features).toEqual(["message_requests"]);
    store.getState().resetDurable(0);
    expect(store.getState().requestViewers).toEqual({});
  });
});

describe("tasks and /unread", () => {
  const task = (actor: string) =>
    makeTask({
      assignee: { ...makeTask().assignee, actor_id: actor },
    });
  it("re-reads after task.notified and task.updated that concern the reader", () => {
    expect(
      refreshesUnread({ type: "task.notified", data: { kind: "assigned" } }),
    ).toBe(true);
    const updated = { type: "task.updated", data: { task: task("me") } };
    expect(refreshesUnread(updated)).toBe(true);
    expect(refreshesUnread(updated, { me: "me", previous: null })).toBe(true);
    const others = { type: "task.updated", data: { task: task("x") } };
    expect(refreshesUnread(others, { me: "me", previous: null })).toBe(false);
    expect(refreshesUnread(others, { me: "me", previous: task("me") })).toBe(
      true,
    );
    expect(
      refreshesUnread(
        { type: "task.updated", data: { task: { broken: true } } },
        { me: "me", previous: null },
      ),
    ).toBe(false);
  });
});
