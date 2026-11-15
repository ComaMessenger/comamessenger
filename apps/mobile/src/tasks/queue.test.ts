import { describe, expect, it, vi } from "vitest";
import { APIError, type CreateTaskRequest } from "@comamessenger/core";
import { enqueueTask, sendQueuedTask, withoutTask } from "./queue";

const chat = "chat-1";
const build =
  (title: string, itemAssignee: string | null = null) =>
  (clientMsgID: string): CreateTaskRequest => ({
    client_msg_id: clientMsgID,
    title,
    description: "",
    assignee: { kind: "person", actor_id: "anna" },
    remind_before_due: false,
    items: [
      itemAssignee
        ? { text: "Разложить маты", assignee_id: itemAssignee }
        : { text: "Разложить маты" },
    ],
  });

describe("task queue", () => {
  const now = new Date("2026-11-15T10:00:00Z");

  it("reuses the client_msg_id of the same form so a retry is not a second task", () => {
    let next = 0;
    const id = () => `id-${++next}`;
    const first = enqueueTask([], chat, build("Повесить расписание"), id, now);
    expect(first.entry.clientMsgID).toBe("id-1");
    expect(first.entry.input.client_msg_id).toBe("id-1");
    const retry = enqueueTask(
      first.items,
      chat,
      build("Повесить расписание"),
      id,
      now,
    );
    expect(retry.entry.clientMsgID).toBe("id-1");
    expect(retry.items).toHaveLength(1);
    // Another item assignee is another task.
    const other = enqueueTask(
      first.items,
      chat,
      build("Повесить расписание", "oleg"),
      id,
      now,
    );
    expect(other.entry.clientMsgID).toBe("id-2");
    expect(other.items).toHaveLength(2);
    // The same form in another chat is another task too.
    expect(
      enqueueTask(other.items, "chat-2", build("Повесить расписание"), id, now)
        .entry.clientMsgID,
    ).toBe("id-3");
    expect(
      withoutTask(other.items, "id-1").map((item) => item.clientMsgID),
    ).toEqual(["id-2"]);
  });

  it("keeps it on network failures and server errors, drops it on a refusal", async () => {
    const { entry } = enqueueTask([], chat, build("Задача"), () => "id", now);
    const message = { id: "m" };
    expect(await sendQueuedTask(entry, async () => message)).toEqual({
      kind: "sent",
      message,
    });
    expect(
      await sendQueuedTask(
        entry,
        vi.fn().mockRejectedValue(new TypeError("offline")),
      ),
    ).toEqual({ kind: "queued" });
    expect(
      await sendQueuedTask(
        entry,
        vi.fn().mockRejectedValue(new APIError(429, "rate_limited", "")),
      ),
    ).toEqual({ kind: "queued" });
    const refused = await sendQueuedTask(
      entry,
      vi.fn().mockRejectedValue(new APIError(422, "task_assignee_invalid", "")),
    );
    expect(refused.kind).toBe("refused");
  });
});
