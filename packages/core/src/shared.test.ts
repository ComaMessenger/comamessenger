import { describe, expect, it } from "vitest";
import {
  groupSharedByMonth,
  isSharedVideo,
  sharedChangedChat,
  sharedItems,
  sharedKeys,
  sharedMessageTarget,
  sharedNextCursor,
  withoutSharedMessage,
} from "./shared";
import type { ChatSharedAttachment, ChatSharedLink, DurableEvent } from "./types";

const author = { actor_id: "a", display_name: "Аня", type: "user" as const, avatar_version: 0 };
function attachment(messageID: string, fileID: string, createdAt: string, mime = "image/jpeg"): ChatSharedAttachment {
  return {
    message_id: messageID,
    thread_root_id: null,
    author,
    created_at: createdAt,
    file: {
      id: fileID,
      name: "x",
      mime,
      size: 1,
      status: "ready",
      processing_status: "ready",
      created_at: createdAt,
      uploader_id: "a",
    },
  };
}
function link(messageID: string, url: string, createdAt: string, threadRootID: string | null = null): ChatSharedLink {
  return { message_id: messageID, url, domain: "x.ru", label: null, thread_root_id: threadRootID, author, created_at: createdAt, snippet: url };
}

describe("shared media", () => {
  it("groups by month in order, with the year only for past years", () => {
    const now = new Date(2026, 10, 14);
    const items = [
      attachment("m1", "f1", new Date(2026, 10, 3).toISOString()),
      attachment("m2", "f2", new Date(2026, 10, 1).toISOString()),
      attachment("m3", "f3", new Date(2026, 9, 30).toISOString()),
      attachment("m4", "f4", new Date(2025, 10, 30).toISOString()),
    ];
    const months = groupSharedByMonth(items, "ru", now);
    expect(months.map((month) => [month.key, month.label, month.items.length])).toEqual([
      ["2026-11", "Ноябрь", 2],
      ["2026-10", "Октябрь", 1],
      ["2025-11", "Ноябрь 2025", 1],
    ]);
    expect(groupSharedByMonth(items, "en", now)[2]!.label).toBe("November 2025");
  });

  it("flattens pages once and reads the cursor", () => {
    const first = attachment("m1", "f1", "2026-11-01T00:00:00Z");
    const pages = [
      { items: [first, attachment("m1", "f2", "2026-11-01T00:00:00Z")], next_cursor: "abc" },
      { items: [first], next_cursor: null },
    ];
    expect(sharedItems(pages).map((item) => item.file.id)).toEqual(["f1", "f2"]);
    expect(sharedNextCursor(pages[0]!)).toBe("abc");
    expect(sharedNextCursor(pages[1]!)).toBeUndefined();
    expect(sharedItems(undefined)).toEqual([]);
    const links = [{ items: [link("m1", "https://a.ru", "2026-11-01T00:00:00Z"), link("m1", "https://b.ru", "2026-11-01T00:00:00Z")], next_cursor: null }];
    expect(sharedItems(links)).toHaveLength(2);
  });

  it("drops a deleted message from loaded pages", () => {
    const pages = [{ items: [attachment("m1", "f1", "2026-11-01T00:00:00Z"), attachment("m2", "f2", "2026-11-01T00:00:00Z")], next_cursor: null }];
    expect(withoutSharedMessage(pages, "m1")[0]!.items.map((item) => item.message_id)).toEqual(["m2"]);
  });

  it("knows which events change a chat's shared media", () => {
    const event = (type: string, chat_id: string | null = "c1"): DurableEvent => ({
      op: "event", seq: 1, type, occurred_at: "", actor_id: "a", chat_id, subject_id: "m", data: {},
    });
    expect(sharedChangedChat(event("message.created"))).toBe("c1");
    expect(sharedChangedChat(event("message.updated"))).toBe("c1");
    expect(sharedChangedChat(event("message.deleted"))).toBe("c1");
    expect(sharedChangedChat(event("reaction.added"))).toBeNull();
    expect(sharedChangedChat(event("message.created", null))).toBeNull();
    expect(sharedKeys.tab("c1", "media")).toEqual(["chat-shared", "c1", "tab", "media"]);
    expect(sharedKeys.all("c1")).toEqual(sharedKeys.counts("c1").slice(0, 2));
  });

  it("leads to the message in its thread", () => {
    expect(sharedMessageTarget(link("m1", "https://a.ru", "", "root"))).toEqual({ messageID: "m1", threadRootID: "root" });
    expect(isSharedVideo(attachment("m", "f", "", "video/mp4"))).toBe(true);
    expect(isSharedVideo(attachment("m", "f", ""))).toBe(false);
  });
});
