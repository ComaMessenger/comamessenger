import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MessengerAPI,
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
