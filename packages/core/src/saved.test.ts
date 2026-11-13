import { describe, expect, it, vi } from "vitest";
import {
  applySavedChange,
  canPinIn,
  messageMenu,
  savedChange,
  isSavedLimitError,
  savedKeys,
  savedMessageHref,
  withSaved,
  type DurableEvent,
  type MessageMenuFacts,
  type SavedMessage,
} from "./index";

function event(type: string, data: Record<string, unknown> = {}): DurableEvent {
  return {
    op: "event",
    seq: 1,
    type,
    occurred_at: "2026-11-11T10:00:00Z",
    actor_id: "me",
    chat_id: null,
    subject_id: "m1",
    data,
  };
}

function item(id: string, chatID: string, root?: string): SavedMessage {
  return {
    saved_at: "2026-11-11T10:00:00Z",
    chat: { id: chatID, kind: "group", display_name: chatID },
    author: {
      actor_id: "a",
      display_name: "A",
      type: "user",
      avatar_version: 0,
    },
    message: {
      id,
      chat_id: chatID,
      actor_id: "a",
      client_msg_id: id,
      type: "text",
      body: id,
      body_format: "markdown",
      version: 1,
      created_seq: 1,
      created_at: "2026-11-11T09:00:00Z",
      mentioned_actor_ids: [],
      thread_reply_count: 0,
      files: [],
      thread_root_id: root ?? null,
    },
  };
}

describe("saved messages", () => {
  it("reads private save events and deletions", () => {
    expect(savedChange(event("message.saved", { chat_id: "c1" }))).toEqual({
      messageID: "m1",
      chatID: "c1",
      saved: true,
    });
    expect(
      savedChange(event("message.unsaved", { chat_id: "c1" }))?.saved,
    ).toBe(false);
    expect(savedChange({ ...event("message.deleted"), chat_id: "c2" })).toEqual(
      {
        messageID: "m1",
        chatID: "c2",
        saved: false,
      },
    );
    expect(savedChange(event("message.pinned"))).toBeNull();
  });

  it("toggles one id without duplicates", () => {
    expect(withSaved(["a", "b"], "a", true)).toEqual(["a", "b"]);
    expect(withSaved(["a", "b"], "c", true)).toEqual(["c", "a", "b"]);
    expect(withSaved(["a", "b"], "a", false)).toEqual(["b"]);
    expect(withSaved(undefined, "a", false)).toEqual([]);
  });

  it("updates the cached star and refreshes the list", () => {
    let ids: string[] | undefined = ["x"];
    const cache = {
      setQueryData: vi.fn(
        (
          key: readonly unknown[],
          updater: (value: string[] | undefined) => string[] | undefined,
        ) => {
          expect(key).toEqual(savedKeys.ids("u1", "c1"));
          ids = updater(ids);
        },
      ),
      invalidateQueries: vi.fn(),
    };
    applySavedChange(cache, "u1", {
      messageID: "m1",
      chatID: "c1",
      saved: true,
    });
    expect(ids).toEqual(["m1", "x"]);
    expect(cache.invalidateQueries).toHaveBeenCalledWith({
      queryKey: ["saved", "u1", "list"],
    });
    expect(cache.invalidateQueries).toHaveBeenCalledWith({
      queryKey: savedKeys.chats("u1"),
    });
    // An uncached chat stays uncached.
    ids = undefined;
    applySavedChange(cache, "u1", {
      messageID: "m1",
      chatID: "c1",
      saved: true,
    });
    expect(ids).toBeUndefined();
  });

  it("keeps every person's saves under their own keys", () => {
    // Two people in one browser tab never share a cache entry.
    for (const key of [
      [savedKeys.list("a"), savedKeys.list("b")],
      [savedKeys.ids("a", "c"), savedKeys.ids("b", "c")],
      [savedKeys.chats("a"), savedKeys.chats("b")],
    ])
      expect(key[0]).not.toEqual(key[1]);
    expect(savedKeys.list("a", "c").slice(0, 2)).toEqual(savedKeys.all("a"));
  });

  it("recognizes the limit error", () => {
    expect(isSavedLimitError({ code: "saved_limit_reached" })).toBe(true);
    // The cap on all rows, hidden saves included, reads the same to a person.
    expect(isSavedLimitError({ code: "saved_storage_full" })).toBe(true);
    expect(isSavedLimitError({ code: "rate_limited" })).toBe(false);
    expect(isSavedLimitError(null)).toBe(false);
  });

  it("links into threads", () => {
    const items = [item("1", "a"), item("2", "b"), item("3", "b", "root")];
    expect(savedMessageHref(items[0]!)).toBe("/chat/a?message=1");
    expect(savedMessageHref(items[2]!)).toBe("/chat/b/thread/root");
  });
});

describe("messageMenu", () => {
  const base: MessageMenuFacts = {
    own: false,
    canModerate: false,
    canPin: false,
    pinned: false,
    saved: false,
    inThread: false,
    hasText: true,
    persisted: true,
  };

  it("offers «Important» to every member and pinning by rights", () => {
    expect(messageMenu(base)[1]).toEqual(["save", "forward", "details"]);
    expect(messageMenu({ ...base, saved: true })[1]![0]).toBe("unsave");
    expect(messageMenu({ ...base, canPin: true })[1]).toEqual([
      "save",
      "pin",
      "forward",
      "details",
    ]);
    expect(messageMenu({ ...base, canPin: true, pinned: true })[1]).toContain(
      "unpin",
    );
    expect(messageMenu({ ...base, persisted: false }).flat()).not.toContain(
      "save",
    );
    expect(canPinIn("admin")).toBe(true);
    expect(canPinIn("member")).toBe(false);
  });
});

describe("message context window", () => {
  it("never asks the server for fewer than three messages", async () => {
    const { MessengerAPI, minMessageContext } = await import("./api");
    const requests: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        requests.push(String(input));
        return new Response(
          JSON.stringify({
            messages: [],
            target_id: "m",
            has_earlier: false,
            has_later: false,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }),
    );
    const api = new MessengerAPI("https://coma.test");
    await api.messageContext("m", 1);
    await api.messageContext("m", 5);
    vi.unstubAllGlobals();
    expect(minMessageContext).toBe(3);
    expect(requests).toEqual([
      "https://coma.test/api/v1/messages/m/context?limit=3",
      "https://coma.test/api/v1/messages/m/context?limit=5",
    ]);
  });
});
