import { describe, expect, it, vi } from "vitest";
import {
  applySavedChange,
  canPinIn,
  messageMenu,
  savedChange,
  savedChatFilters,
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
    cursor: 1,
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
          expect(key).toEqual(savedKeys.ids("c1"));
          ids = updater(ids);
        },
      ),
      invalidateQueries: vi.fn(),
    };
    applySavedChange(cache, { messageID: "m1", chatID: "c1", saved: true });
    expect(ids).toEqual(["m1", "x"]);
    expect(cache.invalidateQueries).toHaveBeenCalledWith({
      queryKey: ["saved", "list"],
    });
    // An uncached chat stays uncached.
    ids = undefined;
    applySavedChange(cache, { messageID: "m1", chatID: "c1", saved: true });
    expect(ids).toBeUndefined();
  });

  it("orders chat filters by count and links into threads", () => {
    const items = [item("1", "a"), item("2", "b"), item("3", "b", "root")];
    expect(
      savedChatFilters(items).map((entry) => [entry.chat.id, entry.count]),
    ).toEqual([
      ["b", 2],
      ["a", 1],
    ]);
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
