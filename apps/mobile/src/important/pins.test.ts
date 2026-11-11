import { describe, expect, it } from "vitest";
import type { Chat, Message, MessagePin } from "@comamessenger/core";
import {
  canUnpin,
  chatsWithPins,
  importantHref,
  type ImportantItem,
} from "./pins";

const item = (
  chatID: string,
  messageID: string,
  patch: {
    chat?: Partial<Chat>;
    message?: Partial<Message>;
    pin?: Partial<MessagePin>;
  } = {},
): ImportantItem => ({
  chat: { id: chatID, kind: "group", role: "member", ...patch.chat } as Chat,
  message: { id: messageID, thread_root_id: null, ...patch.message } as Message,
  pin: {
    message_id: messageID,
    pinned_by: "other",
    pinned_at: "2026-11-01T00:00:00Z",
    ...patch.pin,
  },
});

describe("important messages", () => {
  it("groups pins by chat, most pins first", () => {
    const groups = chatsWithPins([
      item("a", "1"),
      item("b", "2"),
      item("b", "3"),
    ]);
    expect(groups.map((group) => [group.chat.id, group.count])).toEqual([
      ["b", 2],
      ["a", 1],
    ]);
  });

  it("opens thread replies in their thread and the rest in the chat", () => {
    expect(importantHref(item("a", "1"))).toBe("/chat/a?message=1");
    expect(
      importantHref(item("a", "2", { message: { thread_root_id: "r" } })),
    ).toBe("/chat/a/thread/r");
  });

  it("lets the pinner and moderators unpin", () => {
    expect(canUnpin(item("a", "1"), "me", [])).toBe(false);
    expect(
      canUnpin(item("a", "1", { pin: { pinned_by: "me" } }), "me", []),
    ).toBe(true);
    expect(canUnpin(item("a", "1"), "me", ["chats.moderate"])).toBe(true);
    expect(
      canUnpin(item("a", "1", { chat: { role: "admin" } }), "me", []),
    ).toBe(true);
    expect(
      canUnpin(
        item("a", "1", { chat: { kind: "direct", role: "owner" } }),
        "me",
        [],
      ),
    ).toBe(false);
  });
});
