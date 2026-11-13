import { describe, expect, it } from "vitest";
import { threadPreview } from "./threads";
import type { Message } from "./types";

function reply(
  id: string,
  actor: string,
  seq: number,
  extra: Partial<Message> = {},
): Message {
  return {
    id,
    chat_id: "chat",
    actor_id: actor,
    client_msg_id: id,
    type: "text",
    body: id,
    body_format: "plain",
    version: 1,
    created_seq: seq,
    created_at: `2026-01-01T09:${String(seq).padStart(2, "0")}:00Z`,
    mentioned_actor_ids: [],
    thread_reply_count: 0,
    thread_root_id: "root",
    ...extra,
  };
}

describe("threadPreview", () => {
  it("lists distinct reply authors, newest first, and the latest reply time", () => {
    const loaded = [
      reply("a", "anna", 10),
      reply("b", "boris", 11),
      reply("c", "anna", 12),
    ];
    const preview = threadPreview("root", [loaded]);
    expect(preview.participantIDs).toEqual(["anna", "boris"]);
    expect(preview.lastReplyAt).toBe("2026-01-01T09:12:00Z");
    expect(preview.lastReply?.id).toBe("c");
  });

  it("merges realtime replies with the loaded page without duplicates", () => {
    const loaded = [reply("a", "anna", 10)];
    const stored = [
      reply("a", "anna", 10),
      reply("d", "dina", 20),
      reply("x", "oleg", 21, { thread_root_id: "other" }),
    ];
    const preview = threadPreview("root", [loaded, stored]);
    expect(preview.participantIDs).toEqual(["dina", "anna"]);
    expect(preview.lastReply?.id).toBe("d");
  });

  it("skips deleted replies, caps the authors and copes with nothing loaded", () => {
    const loaded = [
      reply("a", "a1", 1),
      reply("b", "a2", 2),
      reply("c", "a3", 3),
      reply("d", "a4", 4),
      reply("e", "a5", 5, { deleted_at: "2026-01-01T10:00:00Z" }),
    ];
    expect(threadPreview("root", [loaded]).participantIDs).toEqual([
      "a4",
      "a3",
      "a2",
    ]);
    expect(threadPreview("root", [undefined])).toEqual({
      participantIDs: [],
      lastReplyAt: null,
      lastReply: null,
    });
  });
});
