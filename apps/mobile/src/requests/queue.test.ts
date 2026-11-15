import { describe, expect, it, vi } from "vitest";
import { APIError, type CreateRequestRequest } from "@comamessenger/core";
import { enqueue, sendQueued, withoutEntry } from "./queue";

const chat = "chat-1";
const build =
  (body: string) =>
  (clientMsgID: string): CreateRequestRequest => ({
    client_msg_id: clientMsgID,
    body,
    body_format: "plain",
    audience: { kind: "chat" },
    answer: { preset: "attend" },
    allow_comment: true,
    auto_remind: false,
  });

describe("request queue", () => {
  const now = new Date("2026-11-15T10:00:00Z");

  it("reuses the client_msg_id of the same form so a retry is not a second request", () => {
    let next = 0;
    const id = () => `id-${++next}`;
    const first = enqueue([], chat, build("Будете?"), id, now);
    expect(first.entry.clientMsgID).toBe("id-1");
    expect(first.entry.input.client_msg_id).toBe("id-1");
    const retry = enqueue(first.items, chat, build("Будете?"), id, now);
    expect(retry.entry.clientMsgID).toBe("id-1");
    expect(retry.items).toHaveLength(1);
    const other = enqueue(first.items, chat, build("Придёте?"), id, now);
    expect(other.entry.clientMsgID).toBe("id-2");
    expect(other.items).toHaveLength(2);
    expect(
      withoutEntry(other.items, "id-1").map((item) => item.clientMsgID),
    ).toEqual(["id-2"]);
  });

  it("keeps it on network failures and server errors, drops it on a refusal", async () => {
    const { entry } = enqueue([], chat, build("Будете?"), () => "id", now);
    const message = { id: "m" };
    expect(await sendQueued(entry, async () => message)).toEqual({
      kind: "sent",
      message,
    });
    expect(
      await sendQueued(
        entry,
        vi.fn().mockRejectedValue(new TypeError("offline")),
      ),
    ).toEqual({ kind: "queued" });
    expect(
      await sendQueued(
        entry,
        vi.fn().mockRejectedValue(new APIError(503, "request_failed", "")),
      ),
    ).toEqual({ kind: "queued" });
    const refused = await sendQueued(
      entry,
      vi.fn().mockRejectedValue(new APIError(422, "request_invalid", "")),
    );
    expect(refused.kind).toBe("refused");
  });
});
