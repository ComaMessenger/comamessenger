import { afterEach, describe, expect, it, vi } from "vitest";
import { MessengerAPI, type SavedMessage } from "@comamessenger/core";
import { fetchSavedPage, importantItems, nextSavedPage } from "./saved";

function saved(id: string, chatID: string): SavedMessage {
  return {
    cursor: 10,
    saved_at: "2026-11-11T10:00:00Z",
    chat: { id: chatID, kind: "channel", display_name: "Новости" },
    author: {
      actor_id: "a",
      display_name: "Анна",
      type: "user",
      avatar_version: 0,
    },
    message: {
      id,
      chat_id: chatID,
      actor_id: "a",
      client_msg_id: id,
      type: "text",
      body: "Важно",
      body_format: "markdown",
      version: 1,
      created_seq: 1,
      created_at: "2026-11-11T09:00:00Z",
      mentioned_actor_ids: [],
      thread_reply_count: 0,
      files: [],
    },
  };
}

describe("loading «Important»", () => {
  afterEach(() => vi.unstubAllGlobals());

  function serve(status: number, body: unknown) {
    const requests: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        requests.push(String(input));
        return new Response(JSON.stringify(body), {
          status,
          headers: { "Content-Type": "application/json" },
        });
      }),
    );
    return requests;
  }

  it("reads a page in one request and continues from next_before", async () => {
    const requests = serve(200, {
      items: [saved("m1", "c1")],
      next_before: 10,
    });
    const api = new MessengerAPI("https://coma.test");
    const page = await fetchSavedPage(api, null);
    expect(requests).toEqual(["https://coma.test/api/v1/saved-messages"]);
    expect(nextSavedPage(page)).toBe(10);
    await fetchSavedPage(api, "c1", 10);
    expect(requests[1]).toBe(
      "https://coma.test/api/v1/saved-messages?chat_id=c1&before=10",
    );
    expect(nextSavedPage({ items: [], next_before: null })).toBeUndefined();
  });

  it("builds cards without asking for each message again", async () => {
    const requests = serve(200, {
      items: [saved("m1", "c1"), saved("m2", "gone")],
      next_before: null,
    });
    const page = await fetchSavedPage(
      new MessengerAPI("https://coma.test"),
      null,
    );
    const chat = { id: "c1", display_name: "Новости" } as never;
    const items = importantItems([page], { c1: chat });
    expect(items.map((item) => item.message.id)).toEqual(["m1", "m2"]);
    expect(items[0]!.localChat).toBe(chat);
    // A chat missing from the list still has a name from the server.
    expect(items[1]!.localChat).toBeUndefined();
    expect(items[1]!.chat.display_name).toBe("Новости");
    expect(requests).toHaveLength(1);
  });

  it("reports a server error instead of an empty list", async () => {
    serve(500, { error: { code: "internal", message: "boom" } });
    await expect(
      fetchSavedPage(new MessengerAPI("https://coma.test"), null),
    ).rejects.toMatchObject({ status: 500 });
  });
});
