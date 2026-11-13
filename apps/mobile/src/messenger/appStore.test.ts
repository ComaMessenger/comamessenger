import { describe, expect, it, vi } from "vitest";
import type { ClientMessage, FileMetadata } from "@comamessenger/core";
import { createAppStore } from "./appStore";

const base: ClientMessage = {
  id: "m1",
  chat_id: "chat",
  actor_id: "anna",
  client_msg_id: "c1",
  type: "text",
  body: "hello",
  body_format: "plain",
  version: 1,
  created_seq: 3,
  created_at: "2026-11-11T09:00:00Z",
  mentioned_actor_ids: [],
  thread_reply_count: 0,
  files: [],
};

const frame = (seq: number, data: Record<string, unknown>) => ({
  op: "event" as const,
  seq,
  type: "message.created",
  occurred_at: base.created_at,
  actor_id: base.actor_id,
  chat_id: base.chat_id,
  subject_id: String(data.id),
  data,
});

const shown = (store: ReturnType<typeof createAppStore>, id: string) =>
  store.getState().messages.chat?.find((item) => item.id === id);

describe("the phone's message store", () => {
  it("reads a truncated message in full by REST and shows it", async () => {
    const full = { ...base, id: "big", body: "x".repeat(70_000) };
    const messageContext = vi.fn(async (id: string, limit?: number) => {
      expect(limit).toBeGreaterThanOrEqual(3);
      return { messages: id === "big" ? [base, full] : [] };
    });
    const store = createAppStore({ messageContext } as never);
    store
      .getState()
      .apply(frame(4, { ...full, body: "", files: [], truncated: true }));
    expect(shown(store, "big")?.body).toBe("");
    await vi.waitFor(() =>
      expect(shown(store, "big")?.body).toHaveLength(70_000),
    );
    expect(messageContext).toHaveBeenCalledWith("big", 3);
  });

  it("shows what a full frame carries at once: files, thread count, why", () => {
    const store = createAppStore({ messageContext: vi.fn() } as never);
    const photo = {
      id: "f1",
      name: "photo.jpg",
      mime: "image/jpeg",
      size: 10,
      status: "ready",
    } as unknown as FileMetadata;
    store.getState().apply(
      frame(5, {
        ...base,
        files: [photo],
        agent_provenance: { trigger: "mention" },
      }),
    );
    expect(shown(store, "m1")?.files).toEqual([photo]);
    expect(shown(store, "m1")?.agent_provenance).toEqual({
      trigger: "mention",
    });
    // A reply carries the exact count of its root, not a guess.
    store.getState().apply(
      frame(6, {
        ...base,
        id: "r1",
        client_msg_id: "rc1",
        created_seq: 6,
        thread_root_id: "m1",
        thread_root_reply_count: 7,
      }),
    );
    expect(shown(store, "m1")?.thread_reply_count).toBe(7);
  });
});
