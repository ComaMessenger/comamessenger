import { describe, expect, it } from "vitest";
import { createMessengerStore } from "./store";
import { parseMarkdown } from "./markdown";
import {
  decodeMentions,
  encodeMentions,
  insertMention,
  messagePlainText,
  mentionedActorIDs,
  updateMentionText,
} from "./mentions";
import { compactUUID, expandUUID } from "./links";
import { RealtimeCoordinator, type CheckpointStorage } from "./realtime";
import { Outbox, type OutboxItem, type OutboxStorage } from "./outbox";
import type { ClientMessage, Message, RealtimeState } from "./types";
import { APIError, type MessengerAPI } from "./api";

const message: ClientMessage = {
  id: "a",
  chat_id: "chat",
  actor_id: "actor",
  client_msg_id: "client",
  type: "text",
  body: "hello",
  body_format: "plain",
  version: 1,
  created_seq: 3,
  created_at: "2026-01-01T00:00:00Z",
  mentioned_actor_ids: [],
  thread_reply_count: 0,
};
describe("domain store", () => {
  it("applies durable events idempotently and reconciles client_msg_id", () => {
    const store = createMessengerStore();
    store.getState().optimistic({
      ...message,
      id: "client",
      created_seq: Number.MAX_SAFE_INTEGER,
      delivery: "sending",
    });
    const event = {
      op: "event" as const,
      seq: 3,
      type: "message.created",
      occurred_at: message.created_at,
      actor_id: message.actor_id,
      chat_id: message.chat_id,
      subject_id: message.id,
      data: message,
    };
    expect(store.getState().apply(event)).toBe(true);
    expect(store.getState().apply(event)).toBe(false);
    expect(store.getState().messages.chat).toHaveLength(1);
    expect(store.getState().messages.chat?.[0]?.delivery).toBe("sent");
  });
  it("reconciles a REST response even when the event checkpoint is newer", () => {
    const store = createMessengerStore(10);
    store.getState().optimistic({
      ...message,
      id: "client",
      created_seq: Number.MAX_SAFE_INTEGER,
      delivery: "sending",
    });
    store.getState().reconcile(message);
    expect(store.getState().messages.chat).toHaveLength(1);
    expect(store.getState().messages.chat?.[0]?.id).toBe("a");
    expect(store.getState().checkpoint).toBe(10);
  });
  it("tracks live thread reply counts and ignores non-message action payloads", () => {
    const store = createMessengerStore();
    store.getState().replaceMessages("chat", [message]);
    const reply = {
      ...message,
      id: "reply",
      client_msg_id: "reply-client",
      thread_root_id: message.id,
      created_seq: 4,
    };
    expect(
      store.getState().apply({
        op: "event",
        seq: 4,
        type: "message.created",
        occurred_at: message.created_at,
        actor_id: message.actor_id,
        chat_id: message.chat_id,
        subject_id: reply.id,
        data: reply,
      }),
    ).toBe(true);
    expect(store.getState().messages.chat?.[0]?.thread_reply_count).toBe(1);
    expect(
      store.getState().apply({
        op: "event",
        seq: 5,
        type: "message.deleted",
        occurred_at: message.created_at,
        actor_id: message.actor_id,
        chat_id: message.chat_id,
        subject_id: reply.id,
        data: { ...reply, deleted_at: message.created_at },
      }),
    ).toBe(true);
    expect(store.getState().messages.chat?.[0]?.thread_reply_count).toBe(0);
    const before = store.getState().messages.chat?.length;
    store.getState().apply({
      op: "event",
      seq: 6,
      type: "message.pinned",
      occurred_at: message.created_at,
      actor_id: message.actor_id,
      chat_id: message.chat_id,
      subject_id: message.id,
      data: { message_id: message.id },
    });
    expect(store.getState().messages.chat).toHaveLength(before ?? 0);
  });
  it("orders, resets, and clears ephemeral agent streams", () => {
    const store = createMessengerStore();
    const base = {
      streamID: "stream",
      runID: "run",
      actorID: "agent",
      chatID: "chat",
      threadRootID: null,
      expiresAt: "2099-01-01T00:00:00Z",
    };
    store.getState().applyMessageStream({ ...base, index: 1, delta: "Hel", reset: true, done: false });
    store.getState().applyMessageStream({ ...base, index: 2, delta: "lo", reset: false, done: false });
    store.getState().applyMessageStream({ ...base, index: 1, delta: "stale", reset: false, done: false });
    expect(store.getState().messageStreams.stream?.body).toBe("Hello");
    store.getState().applyMessageStream({ ...base, index: 3, delta: "", reset: false, done: true });
    expect(store.getState().messageStreams.stream).toBeUndefined();
    store.getState().setAgentStatus({
      runID: "run",
      actorID: "agent",
      chatID: "chat",
      threadRootID: null,
      state: "thinking",
      expiresAt: base.expiresAt,
    });
    store.getState().clearAgentEphemeral();
    expect(store.getState().agentStatuses.run).toBeUndefined();
  });
});
describe("markdown AST", () => {
  it("recognizes only the agreed safe subset", () => {
    const tree = parseMarkdown("**bold** [site](https://example.com) <script>");
    expect(tree.map((node) => node.type)).toEqual([
      "strong",
      "text",
      "link",
      "text",
    ]);
    expect(JSON.stringify(tree)).toContain("<script>");
  });
  it("parses headings, lists, contextual mentions and inline formatting", () => {
    const tree = parseMarkdown(
      "## План\n- первый\n- второй\nПривет, @all: ++важно++ и ~~устарело~~",
    );
    expect(tree.map((node) => node.type)).toEqual([
      "heading",
      "break",
      "list",
      "break",
      "text",
      "contextMention",
      "text",
      "underline",
      "text",
      "strike",
    ]);
  });
});

describe("structured mentions", () => {
  const actorID = "01a01612-85e4-7145-bda3-82db7b4a3075";

  it("keeps actor IDs out of editable and preview text", () => {
    const source = `Привет @[Лев](${actorID})`;
    expect(decodeMentions(source).text).toBe("Привет @Лев");
    expect(messagePlainText(source)).toBe("Привет @Лев");
    expect(mentionedActorIDs(source)).toEqual([actorID]);
  });

  it("round-trips a selected mention while text changes around it", () => {
    const selected = insertMention(
      { text: "Привет @ле", mentions: [] },
      7,
      10,
      actorID,
      "Лев",
    );
    const edited = updateMentionText(selected, `${selected.text}как дела?`);
    expect(encodeMentions(edited)).toBe(`Привет @[Лев](${actorID}) как дела?`);
  });

  it("drops mention metadata when its visible label is edited", () => {
    const source = `@[Лев](${actorID}) привет`;
    const draft = decodeMentions(source);
    const edited = updateMentionText(draft, "@Леон привет");
    expect(encodeMentions(edited)).toBe("@Леон привет");
    expect(mentionedActorIDs(encodeMentions(edited))).toEqual([]);
  });
});

describe("compact deep links", () => {
  it("round-trips UUIDs through a 22-character URL-safe key", () => {
    const id = "01a01855-2aaf-75f0-b24d-0685817a51af";
    const compact = compactUUID(id);
    expect(compact).toHaveLength(22);
    expect(compact).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(expandUUID(compact)).toBe(id);
  });
});

describe("realtime coordinator", () => {
  it("authenticates from the persisted checkpoint and ACKs duplicate delivery", async () => {
    let checkpoint = 5;
    const sent: string[] = [];
    const storage: CheckpointStorage = {
      get: async () => checkpoint,
      set: async (value) => {
        checkpoint = value;
      },
      clear: async () => {
        checkpoint = 0;
      },
    };
    const socket = {
      readyState: 1,
      send: (value: string) => sent.push(value),
      close: () => undefined,
      onopen: null as ((event: unknown) => void) | null,
      onmessage: null as ((event: { data: string }) => void) | null,
      onclose: null as ((event: unknown) => void) | null,
    };
    const api = {
      token: () => "token",
      refresh: async () => undefined,
      websocketURL: () => "ws://test",
    } as unknown as MessengerAPI;
    const coordinator = new RealtimeCoordinator(
      api,
      storage,
      () => {
        queueMicrotask(() => socket.onopen?.({}));
        return socket;
      },
      {
        state: () => undefined,
        event: () => false,
        resync: async () => undefined,
      },
    );
    coordinator.start();
    await nextTask();
    expect(JSON.parse(sent[0]!).last_seq).toBe(5);
    socket.onmessage?.({
      data: JSON.stringify({
        op: "hello",
        current_seq: 5,
        ack_interval_ms: 1,
        ack_batch_size: 50,
      }),
    });
    socket.onmessage?.({
      data: JSON.stringify({
        op: "event",
        seq: 5,
        type: "message.created",
        data: {},
      }),
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(
      sent
        .map((value) => JSON.parse(value))
        .some((frame) => frame.op === "ack" && frame.seq === 5),
    ).toBe(true);
    coordinator.stop();
  });

  it("refreshes and reconnects when the websocket access token expires", async () => {
    let token: string | null = "expired";
    let refreshes = 0;
    let sessionExpired = 0;
    const sockets: Array<{
      readyState: number;
      send(value: string): void;
      close(): void;
      onopen: ((event: unknown) => void) | null;
      onmessage: ((event: { data: string }) => void) | null;
      onclose: ((event: { code: number }) => void) | null;
    }> = [];
    const api = {
      token: () => token,
      clearToken: (expected: string | null) => {
        if (token !== expected) return false;
        token = null;
        return true;
      },
      refresh: async () => {
        refreshes += 1;
        token = "fresh";
        return {};
      },
      websocketURL: () => "ws://test",
    } as unknown as MessengerAPI;
    const coordinator = new RealtimeCoordinator(
      api,
      {
        get: async () => 0,
        set: async () => undefined,
        clear: async () => undefined,
      },
      () => {
        const socket = {
          readyState: 1,
          send: () => undefined,
          close: () => undefined,
          onopen: null as ((event: unknown) => void) | null,
          onmessage: null as ((event: { data: string }) => void) | null,
          onclose: null as ((event: { code: number }) => void) | null,
        };
        sockets.push(socket);
        queueMicrotask(() => socket.onopen?.({}));
        return socket;
      },
      {
        state: () => undefined,
        event: () => false,
        resync: async () => undefined,
        sessionExpired: () => {
          sessionExpired += 1;
        },
      },
    );
    coordinator.start();
    await nextTask();
    sockets[0]!.onclose?.({ code: 4001 });
    await nextTask();
    await nextTask();
    expect(refreshes).toBe(1);
    expect(sockets).toHaveLength(2);
    expect(token).toBe("fresh");
    expect(sessionExpired).toBe(0);
    coordinator.stop();
  });

  it("stops reconnecting when the server requires a password change", async () => {
    let refreshes = 0;
    let required = 0;
    const states: RealtimeState[] = [];
    const sockets: Array<{
      readyState: number;
      send(value: string): void;
      close(): void;
      onopen: ((event: unknown) => void) | null;
      onmessage: ((event: { data: string }) => void) | null;
      onclose: ((event: { code: number }) => void) | null;
    }> = [];
    const api = {
      token: () => "token",
      clearToken: () => true,
      refresh: async () => {
        refreshes += 1;
        return {};
      },
      websocketURL: () => "ws://test",
    } as unknown as MessengerAPI;
    const coordinator = new RealtimeCoordinator(
      api,
      {
        get: async () => 0,
        set: async () => undefined,
        clear: async () => undefined,
      },
      () => {
        const socket = {
          readyState: 1,
          send: () => undefined,
          close: () => undefined,
          onopen: null as ((event: unknown) => void) | null,
          onmessage: null as ((event: { data: string }) => void) | null,
          onclose: null as ((event: { code: number }) => void) | null,
        };
        sockets.push(socket);
        queueMicrotask(() => socket.onopen?.({}));
        return socket;
      },
      {
        state: (state) => states.push(state),
        event: () => false,
        resync: async () => undefined,
        passwordChangeRequired: () => {
          required += 1;
        },
      },
    );
    coordinator.start();
    await nextTask();
    sockets[0]!.onmessage?.({
      data: JSON.stringify({
        op: "error",
        code: "password_change_required",
      }),
    });
    await nextTask();
    sockets[0]!.onclose?.({ code: 4001 });
    await nextTask();
    expect(refreshes).toBe(0);
    expect(sockets).toHaveLength(1);
    expect(required).toBe(1);
    expect(states).toContain("password_change_required");
    coordinator.stop();
  });

  it("ends the session only when refresh itself is unauthorized", async () => {
    let token: string | null = "expired";
    let sessionExpired = 0;
    const socket = {
      readyState: 1,
      send: () => undefined,
      close: () => undefined,
      onopen: null as ((event: unknown) => void) | null,
      onmessage: null as ((event: { data: string }) => void) | null,
      onclose: null as ((event: { code: number }) => void) | null,
    };
    const api = {
      token: () => token,
      clearToken: (expected: string | null) => {
        if (token !== expected) return false;
        token = null;
        return true;
      },
      refresh: async () => {
        throw new APIError(401, "invalid_refresh_token", "expired");
      },
      websocketURL: () => "ws://test",
    } as unknown as MessengerAPI;
    const coordinator = new RealtimeCoordinator(
      api,
      {
        get: async () => 0,
        set: async () => undefined,
        clear: async () => undefined,
      },
      () => {
        queueMicrotask(() => socket.onopen?.({}));
        return socket;
      },
      {
        state: () => undefined,
        event: () => false,
        resync: async () => undefined,
        sessionExpired: () => {
          sessionExpired += 1;
        },
      },
    );
    coordinator.start();
    await nextTask();
    socket.onclose?.({ code: 4001 });
    await nextTask();
    expect(sessionExpired).toBe(1);
    coordinator.stop();
  });
});

describe("persistent outbox", () => {
  it("retries the original client_msg_id without creating another command", async () => {
    const values = new Map<string, OutboxItem>();
    const calls: string[] = [];
    let attempt = 0;
    const storage: OutboxStorage = {
      list: async () => [...values.values()],
      put: async (item) => {
        values.set(item.input.client_msg_id, item);
      },
      delete: async (id) => {
        values.delete(id);
      },
    };
    const api = {
      token: () => "token",
      createMessage: async (
        _chat: string,
        input: { client_msg_id: string },
      ) => {
        calls.push(input.client_msg_id);
        if (attempt++ === 0) throw new Error("offline");
        return { ...message, client_msg_id: input.client_msg_id } as Message;
      },
    } as unknown as MessengerAPI;
    const states: string[] = [];
    const outbox = new Outbox(api, storage, {
      optimistic: () => states.push("sending"),
      retrying: () => states.push("retrying"),
      delivered: () => states.push("sent"),
      failed: () => states.push("failed"),
    });
    await outbox.enqueue("chat", {
      client_msg_id: "stable",
      body: "hello",
      body_format: "plain",
    });
    await outbox.flush();
    expect(calls).toEqual(["stable", "stable"]);
    expect(states).toEqual(["sending", "failed", "retrying", "sent"]);
    expect(values.size).toBe(0);
  });
});

function nextTask() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
