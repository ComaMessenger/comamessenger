import { describe, expect, it } from "vitest";
import {
  folderColorToken,
  folderColors,
  folderOfTab,
  matchesTab,
  moveFolder,
  removeFolder,
  resolveTab,
  sortChats,
  tabUnreadCount,
  toggleChatInFolder,
  totalUnread,
  unreadByChat,
  upsertFolder,
  type ChatListTab,
} from "./folders";
import type { Chat, ChatFolder, UnreadSnapshot } from "./types";

const chat = (id: string, patch: Partial<Chat> = {}) =>
  ({
    id,
    kind: "group",
    created_at: "2026-11-01T10:00:00Z",
    last_message_at: null,
    ...patch,
  }) as Chat;

const folder = (id: string, chatIDs: string[]): ChatFolder => ({
  id,
  name: id,
  icon: "folder",
  color: "blue",
  chat_ids: chatIDs,
});

const chats = [
  chat("a", { kind: "direct" }),
  chat("b"),
  chat("c", { kind: "channel" }),
  chat("d"),
];
const folders = [folder("work", ["b", "c"]), folder("empty", [])];
const unread: UnreadSnapshot = {
  chats: [
    { chat_id: "a", last_read_seq: 0, unread_count: 2, mention_count: 0 },
    { chat_id: "c", last_read_seq: 0, unread_count: 5, mention_count: 1 },
    { chat_id: "d", last_read_seq: 0, unread_count: 0, mention_count: 1 },
    { chat_id: "gone", last_read_seq: 0, unread_count: 9, mention_count: 0 },
  ],
  threads: [],
};
const counts = unreadByChat(unread);
const ids = (tab: ChatListTab) =>
  chats
    .filter((item) => matchesTab(item, tab, folders, counts))
    .map((item) => item.id);

describe("chat list tabs", () => {
  it("selects chats of built-in tabs and folders", () => {
    expect(ids("all")).toEqual(["a", "b", "c", "d"]);
    expect(ids("direct")).toEqual(["a"]);
    expect(ids("grouped")).toEqual(["b", "d"]);
    expect(ids("channel")).toEqual(["c"]);
    expect(ids("folder:work")).toEqual(["b", "c"]);
    expect(ids("folder:empty")).toEqual([]);
    expect(ids("folder:deleted")).toEqual([]);
  });

  it("treats a mention without unread messages as unread", () => {
    expect(ids("unread")).toEqual(["a", "c", "d"]);
  });

  it("sums unread messages per tab and skips chats the person left", () => {
    expect(tabUnreadCount(chats, "all", folders, counts)).toBe(7);
    expect(tabUnreadCount(chats, "folder:work", folders, counts)).toBe(5);
    expect(tabUnreadCount(chats, "folder:empty", folders, counts)).toBe(0);
    expect(
      totalUnread(unread, Object.fromEntries(chats.map((c) => [c.id, c]))),
    ).toBe(7);
  });

  it("falls back to «All» when the selected folder is deleted", () => {
    expect(resolveTab("folder:work", folders)).toBe("folder:work");
    expect(resolveTab("folder:deleted", folders)).toBe("all");
    expect(resolveTab("unread", folders)).toBe("unread");
    expect(folderOfTab("folder:work", folders)?.id).toBe("work");
    expect(folderOfTab("all", folders)).toBeUndefined();
  });

  it("puts pinned chats first in pin order, then the most recent", () => {
    const list = [
      chat("old", { last_message_at: "2026-11-02T00:00:00Z" }),
      chat("new", { last_message_at: "2026-11-05T00:00:00Z" }),
      chat("pin2"),
      chat("pin1"),
    ];
    expect(sortChats(list, ["pin1", "pin2"]).map((item) => item.id)).toEqual([
      "pin1",
      "pin2",
      "new",
      "old",
    ]);
  });
});

describe("folder edits", () => {
  it("toggles a chat in one folder only", () => {
    const added = toggleChatInFolder(folders, "empty", "a");
    expect(added[1]!.chat_ids).toEqual(["a"]);
    expect(added[0]).toBe(folders[0]);
    expect(toggleChatInFolder(added, "empty", "a")[1]!.chat_ids).toEqual([]);
  });

  it("replaces an existing folder in place and appends a new one", () => {
    const renamed = upsertFolder(folders, { ...folders[0]!, name: "Job" });
    expect(renamed.map((item) => item.name)).toEqual(["Job", "empty"]);
    expect(upsertFolder(folders, folder("new", [])).map((f) => f.id)).toEqual([
      "work",
      "empty",
      "new",
    ]);
    expect(removeFolder(folders, "work").map((f) => f.id)).toEqual(["empty"]);
  });

  it("moves tabs one step and keeps the edges", () => {
    const three = [...folders, folder("x", [])];
    expect(moveFolder(three, "x", -1).map((f) => f.id)).toEqual([
      "work",
      "x",
      "empty",
    ]);
    expect(moveFolder(three, "work", 1).map((f) => f.id)).toEqual([
      "empty",
      "work",
      "x",
    ]);
    expect(moveFolder(three, "work", -1)).toBe(three);
    expect(moveFolder(three, "x", 1)).toBe(three);
    expect(moveFolder(three, "missing", 1)).toBe(three);
  });

  it("names the theme token of every colour", () => {
    expect(folderColorToken("blue")).toBe("folderBlue");
    expect(folderColors.map(folderColorToken)).toContain("folderSlate");
  });
});
