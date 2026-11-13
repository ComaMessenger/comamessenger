import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MessengerAPI,
  createMessengerStore,
  Outbox,
  type OutboxItem,
  type OutboxStorage,
  type TokenResponse,
} from "./index";

const tokens = (userID: string, token: string) =>
  ({
    access_token: token,
    access_expires_at: "2099-01-01T00:00:00Z",
    user: { id: userID },
  }) as unknown as TokenResponse;

function memoryStorage(items: OutboxItem[]): OutboxStorage & {
  items: OutboxItem[];
} {
  const storage = {
    items,
    async list() {
      return [...storage.items];
    },
    async put(value: OutboxItem) {
      storage.items = [
        ...storage.items.filter(
          (item) => item.input.client_msg_id !== value.input.client_msg_id,
        ),
        value,
      ];
    },
    async delete(clientMsgID: string) {
      storage.items = storage.items.filter(
        (item) => item.input.client_msg_id !== clientMsgID,
      );
    },
  };
  return storage;
}

const queued = (): OutboxItem => ({
  chatID: "chat",
  input: { client_msg_id: "m1", body: "от Алексея", body_format: "plain" },
  createdAt: "2026-11-11T10:00:00Z",
  attempts: 0,
});

const callbacks = {
  optimistic: () => undefined,
  delivered: () => undefined,
  retrying: () => undefined,
  failed: () => undefined,
};

describe("outbox owner", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("never sends one person's message with another person's token", async () => {
    const sent: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        sent.push(new Headers(init.headers).get("Authorization") ?? "");
        return new Response(JSON.stringify({ id: "m1" }), { status: 201 });
      }),
    );
    const api = new MessengerAPI("https://coma.test");
    api.adoptTokens(tokens("alexey", "token-alexey"));
    const storage = memoryStorage([queued()]);
    const outbox = new Outbox(api, storage, callbacks, "alexey");
    // Boris signs in on the same device before the queue is flushed.
    api.adoptTokens(tokens("boris", "token-boris"));
    await outbox.flush();
    expect(sent).toEqual([]);
    expect(storage.items).toHaveLength(1);
    // Back with Alexey's token, the message goes out as Alexey.
    api.adoptTokens(tokens("alexey", "token-alexey-2"));
    await outbox.flush();
    expect(sent).toEqual(["Bearer token-alexey-2"]);
    expect(storage.items).toHaveLength(0);
  });

  it("does not retry after a refresh that returned someone else", async () => {
    const authorizations: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        if (url.endsWith("/auth/refresh"))
          return new Response(JSON.stringify(tokens("boris", "token-boris")), {
            status: 200,
          });
        authorizations.push(
          new Headers(init.headers).get("Authorization") ?? "",
        );
        return new Response(JSON.stringify({ code: "unauthorized" }), {
          status: 401,
        });
      }),
    );
    const api = new MessengerAPI("https://coma.test");
    api.adoptTokens(tokens("alexey", "token-alexey"));
    const storage = memoryStorage([queued()]);
    await new Outbox(api, storage, callbacks, "alexey").flush();
    // One attempt with Alexey's expired token, none with Boris's.
    expect(authorizations).toEqual(["Bearer token-alexey"]);
    expect(storage.items).toHaveLength(1);
  });
});

describe("outbox optimistic message", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("is authored by the owner from the first frame and keeps its key when delivered", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              id: "server-1",
              chat_id: "chat",
              actor_id: "alexey",
              client_msg_id: "m2",
              type: "text",
              body: "привет",
              body_format: "markdown",
              version: 1,
              created_seq: 42,
              created_at: "2026-11-11T10:00:01Z",
              mentioned_actor_ids: [],
              thread_reply_count: 0,
              files: [],
            }),
            { status: 201 },
          ),
      ),
    );
    const api = new MessengerAPI("https://coma.test");
    api.adoptTokens(tokens("alexey", "token-alexey"));
    const store = createMessengerStore();
    const frames: { actor: string; key: string; count: number }[] = [];
    store.subscribe((state) => {
      const items = state.messages.chat ?? [];
      const last = items[items.length - 1];
      if (last)
        frames.push({
          actor: last.actor_id,
          key: last.client_msg_id || last.id,
          count: items.length,
        });
    });
    const outbox = new Outbox(
      api,
      memoryStorage([]),
      {
        optimistic: store.getState().optimistic,
        delivered: store.getState().reconcile,
        retrying: store.getState().retrying,
        failed: store.getState().failed,
      },
      "alexey",
    );
    await outbox.enqueue("chat", {
      client_msg_id: "m2",
      body: "привет",
      body_format: "markdown",
    });
    // Queued, then confirmed: one message, always Alexey's, one list key.
    expect(frames.length).toBeGreaterThanOrEqual(2);
    expect(frames.every((frame) => frame.actor === "alexey")).toBe(true);
    expect(frames.every((frame) => frame.key === "m2")).toBe(true);
    expect(frames.every((frame) => frame.count === 1)).toBe(true);
    const [delivered] = store.getState().messages.chat ?? [];
    expect(delivered).toMatchObject({ id: "server-1", delivery: "sent" });
  });
});
