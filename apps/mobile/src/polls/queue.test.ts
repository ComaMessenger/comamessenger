import { describe, expect, it } from "vitest";
import { APIError, type CreatePollRequest } from "@comamessenger/core";
import {
  enqueuePoll,
  queuedPollFor,
  sendQueuedPoll,
  withoutPoll,
  type QueuedPoll,
} from "./queue";

const input = (clientMsgID: string): CreatePollRequest => ({
  client_msg_id: clientMsgID,
  question: "Когда субботник?",
  options: ["Суббота", "Воскресенье"],
  multiple: false,
  anonymous: false,
});

const now = new Date("2026-11-15T10:00:00Z");

describe("the poll queue", () => {
  it("queues a poll once and reuses its id for the same form", () => {
    let next = 0;
    const id = () => `id-${++next}`;
    const first = enqueuePoll([], "chat", input, id, now);
    expect(first.entry.clientMsgID).toBe("id-1");
    expect(first.entry.input.client_msg_id).toBe("id-1");
    const again = enqueuePoll(first.items, "chat", input, id, now);
    expect(again.entry.clientMsgID).toBe("id-1");
    expect(again.items).toHaveLength(1);
    // Another chat or another form is another poll.
    const elsewhere = enqueuePoll(again.items, "other", input, id, now);
    expect(elsewhere.entry.clientMsgID).toBe("id-2");
    const changed = enqueuePoll(
      elsewhere.items,
      "chat",
      (clientMsgID) => ({ ...input(clientMsgID), anonymous: true }),
      id,
      now,
    );
    expect(changed.entry.clientMsgID).toBe("id-3");
    expect(queuedPollFor(changed.items, "chat", first.entry.signature)).toBe(
      first.entry,
    );
    expect(withoutPoll(changed.items, "id-1").map((item) => item.clientMsgID))
      .toEqual(["id-2", "id-3"]);
  });

  it("keeps a poll for the network, drops one the server refused", async () => {
    const entry: QueuedPoll = enqueuePoll([], "chat", input, () => "x", now)
      .entry;
    expect(
      await sendQueuedPoll(entry, async () => ({ id: "m1" })),
    ).toEqual({ kind: "sent", message: { id: "m1" } });
    expect(
      await sendQueuedPoll(entry, async () => {
        throw new TypeError("Network request failed");
      }),
    ).toEqual({ kind: "queued" });
    expect(
      await sendQueuedPoll(entry, async () => {
        throw new APIError(503, "unavailable" as never, "down");
      }),
    ).toEqual({ kind: "queued" });
    expect(
      await sendQueuedPoll(entry, async () => {
        throw new APIError(429, "rate_limited", "slow down");
      }),
    ).toEqual({ kind: "queued" });
    const refused = await sendQueuedPoll(entry, async () => {
      throw new APIError(422, "poll_invalid", "options");
    });
    expect(refused.kind).toBe("refused");
  });
});
