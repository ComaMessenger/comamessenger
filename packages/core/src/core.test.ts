import { afterEach, describe, expect, it, vi } from "vitest";
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
import { chatPreview, formatListTime } from "./chats";
import { feedRows } from "./feed";
import { resolvedMentionActorIDs } from "./mentions";
import type { Chat } from "./types";
import { RealtimeCoordinator, type CheckpointStorage } from "./realtime";
import { Outbox, type OutboxItem, type OutboxStorage } from "./outbox";
import type { ClientMessage, Message, RealtimeState } from "./types";
import { APIError, MessengerAPI, type RefreshTokenStore } from "./api";

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
    store.getState().applyMessageStream({
      ...base,
      index: 1,
      delta: "Hel",
      reset: true,
      done: false,
    });
    store.getState().applyMessageStream({
      ...base,
      index: 2,
      delta: "lo",
      reset: false,
      done: false,
    });
    store.getState().applyMessageStream({
      ...base,
      index: 1,
      delta: "stale",
      reset: false,
      done: false,
    });
    expect(store.getState().messageStreams.stream?.body).toBe("Hello");
    store.getState().applyMessageStream({
      ...base,
      index: 3,
      delta: "",
      reset: false,
      done: true,
    });
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

  it("does not retry forever when the first refresh is rejected", async () => {
    let sessionExpired = 0;
    let refreshes = 0;
    let sockets = 0;
    const api = {
      token: () => null,
      refresh: async () => {
        refreshes += 1;
        throw new APIError(401, "invalid_refresh_token", "revoked");
      },
      websocketURL: () => "ws://test",
    } as unknown as MessengerAPI;
    const states: RealtimeState[] = [];
    const coordinator = new RealtimeCoordinator(
      api,
      {
        get: async () => 0,
        set: async () => undefined,
        clear: async () => undefined,
      },
      () => {
        sockets += 1;
        throw new Error("no socket expected");
      },
      {
        state: (state) => states.push(state),
        event: () => false,
        resync: async () => undefined,
        sessionExpired: () => {
          sessionExpired += 1;
        },
      },
    );
    coordinator.start();
    await new Promise((resolve) => setTimeout(resolve, 1100));
    expect(refreshes).toBe(1);
    expect(sockets).toBe(0);
    expect(sessionExpired).toBe(1);
    expect(states.at(-1)).toBe("session_expired");
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

describe("websocket URL", () => {
  it("maps the API scheme and keeps a path prefix", () => {
    expect(new MessengerAPI("https://acme.ru/coma").websocketURL()).toBe(
      "wss://acme.ru/coma/api/v1/ws",
    );
    expect(new MessengerAPI("http://localhost:8080").websocketURL()).toBe(
      "ws://localhost:8080/api/v1/ws",
    );
  });
});

describe("native session transport", () => {
  afterEach(() => vi.unstubAllGlobals());

  const user = { id: "user" };
  function memoryStore(initial: string | null): RefreshTokenStore & {
    token: string | null;
  } {
    return {
      token: initial,
      async load() {
        return this.token;
      },
      async save(token) {
        this.token = token;
      },
    };
  }

  it("keeps the refresh token in the store and sends it in the body", async () => {
    const requests: { url: string; init: RequestInit }[] = [];
    const responses = [
      { access_token: "a1", refresh_token: "r1", user },
      { access_token: "a2", refresh_token: "r2", user },
    ];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      requests.push({ url, init });
      return new Response(JSON.stringify(responses.shift()), { status: 200 });
    });
    const store = memoryStore(null);
    const api = new MessengerAPI("https://coma.test", undefined, store);

    const login = await api.login({ email: "a@b.c", password: "secret" });
    expect(login).not.toHaveProperty("refresh_token");
    expect(store.token).toBe("r1");

    await api.refresh();
    expect(api.token()).toBe("a2");
    expect(store.token).toBe("r2");
    const refresh = requests[1]!;
    expect(refresh.init.credentials).toBe("omit");
    expect(new Headers(refresh.init.headers).get("X-Coma-Client")).toBe(
      "native",
    );
    expect(JSON.parse(refresh.init.body as string)).toEqual({
      refresh_token: "r1",
    });
  });

  it("forgets a rejected refresh token without calling the server twice", async () => {
    const fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ code: "invalid_refresh_token" }), {
          status: 401,
        }),
    );
    vi.stubGlobal("fetch", fetch);
    const store = memoryStore("stale");
    const api = new MessengerAPI("https://coma.test", undefined, store);

    await expect(api.refresh()).rejects.toMatchObject({ status: 401 });
    expect(store.token).toBeNull();
    await expect(api.refresh()).rejects.toMatchObject({
      code: "invalid_refresh_token",
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe("chat list helpers", () => {
  const labels = { you: "You", deleted: "Deleted", attachment: "Attachment" };
  const chat = (patch: Partial<Chat>) =>
    ({ id: "c", kind: "group", topic: "Topic", ...patch }) as Chat;

  it("builds sender-prefixed previews", () => {
    const last = {
      actor_id: "other",
      actor_display_name: "Anna",
      body: "hello",
      deleted: false,
    } as Chat["last_message"];
    expect(chatPreview(chat({ last_message: last }), "me", labels)).toEqual({
      sender: "Anna: ",
      text: "hello",
    });
    expect(
      chatPreview(chat({ kind: "direct", last_message: last }), "me", labels),
    ).toEqual({ sender: "", text: "hello" });
    expect(chatPreview(chat({}), "me", labels)).toEqual({
      sender: "",
      text: "Topic",
    });
  });

  it("formats list times relative to now", () => {
    const now = new Date(2026, 8, 29, 15, 0);
    expect(
      formatListTime(
        new Date(2026, 8, 29, 9, 5).toISOString(),
        "ru",
        "вчера",
        now,
      ),
    ).toBe("09:05");
    expect(
      formatListTime(
        new Date(2026, 8, 28, 23, 0).toISOString(),
        "ru",
        "вчера",
        now,
      ),
    ).toBe("вчера");
    expect(
      formatListTime(
        new Date(2025, 0, 2).toISOString(),
        "en",
        "Yesterday",
        now,
      ),
    ).toContain("2025");
  });
});

describe("feed layout", () => {
  const at = (minute: number, actor = "a", seq = minute) =>
    ({
      ...message,
      id: `m${seq}`,
      actor_id: actor,
      created_seq: seq,
      created_at: new Date(2026, 8, 29, 10, minute).toISOString(),
    }) as ClientMessage;

  it("groups consecutive messages and breaks at the read boundary", () => {
    const rows = feedRows(
      [at(0), at(2), at(3, "b"), at(20, "b"), at(21, "b")],
      20,
    );
    expect(rows.map((row) => row.grouped)).toEqual([
      false,
      true,
      false,
      false,
      false,
    ]);
    expect(rows.map((row) => row.firstUnread)).toEqual([
      false,
      false,
      false,
      false,
      true,
    ]);
    expect(rows[0]!.newDay).toBe(true);
  });

  it("expands @all and @here", () => {
    const members = [{ actor_id: "x" }, { actor_id: "y" }];
    expect(resolvedMentionActorIDs("hi @all", members, {}).sort()).toEqual([
      "x",
      "y",
    ]);
    expect(
      resolvedMentionActorIDs("hi @here", members, { y: "online" }),
    ).toEqual(["y"]);
  });
});
