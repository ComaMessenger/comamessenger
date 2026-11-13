import { describe, expect, it } from "vitest";
import {
  completeMessage,
  createMessengerStore,
  threadPreview,
  type ClientMessage,
  type DurableEvent,
} from "./index";

const chatID = "01a0e9d6-54a5-7aef-974c-d9281669f1b4";
const rootID = "01a0e9d6-54db-7a16-86ba-778c50a4cbf4";

/** `data` exactly as core/internal/eventlog builds it: no files, no count. */
function frame(
  seq: number,
  type: string,
  data: Record<string, unknown>,
): DurableEvent {
  return {
    op: "event",
    seq,
    type,
    occurred_at: "2026-09-29T10:40:29Z",
    actor_id: String(data.actor_id),
    chat_id: chatID,
    subject_id: String(data.id),
    data,
  };
}

function row(id: string, seq: number, patch: Record<string, unknown> = {}) {
  return {
    id,
    chat_id: chatID,
    actor_id: "01a0e9d6-543e-722d-87a8-f514a0e75f7c",
    client_msg_id: `client-${id}`,
    type: "text",
    body: "миграция готова",
    body_format: "plain",
    reply_to_id: null,
    thread_root_id: null,
    version: 1,
    created_seq: seq,
    created_at: "2026-09-28T21:05:32.891681+00:00",
    edited_at: null,
    deleted_at: null,
    forwarded_from: null,
    mentioned_actor_ids: [],
    ...patch,
  };
}

describe("messages from realtime frames (chat «Backend» crash)", () => {
  it("replaying history from zero gives messages with every field", () => {
    const store = createMessengerStore();
    // A fresh install replays retained events: root, quoted reply, thread reply.
    store.getState().apply(frame(1, "message.created", row(rootID, 10)));
    store
      .getState()
      .apply(
        frame(2, "message.created", row("reply", 23, { reply_to_id: rootID })),
      );
    store
      .getState()
      .apply(
        frame(
          3,
          "message.created",
          row("in-thread", 24, { thread_root_id: rootID }),
        ),
      );
    const messages = store.getState().messages[chatID]!;
    for (const message of messages) {
      // MessageBubble reads files.length and the thread caption count.
      expect(Array.isArray(message.files)).toBe(true);
      expect(Number.isFinite(message.thread_reply_count)).toBe(true);
    }
    const root = messages.find((message) => message.id === rootID)!;
    // Was undefined + 1 = NaN, cached as null.
    expect(root.thread_reply_count).toBe(1);
    expect(threadPreview(rootID, [messages]).participantIDs).toHaveLength(1);
    // JSON for the disk cache keeps a number, not null.
    expect(JSON.parse(JSON.stringify(root)).thread_reply_count).toBe(1);
  });

  it("an update keeps the files and count the client already knows", () => {
    const store = createMessengerStore();
    const file = { id: "f", name: "a.png" } as never;
    store.getState().replaceMessages(chatID, [
      {
        ...row(rootID, 10),
        files: [file],
        thread_reply_count: 3,
      } as ClientMessage,
    ]);
    store
      .getState()
      .apply(
        frame(5, "message.updated", row(rootID, 10, { body: "исправлено" })),
      );
    const root = store.getState().messages[chatID]![0]!;
    expect(root.body).toBe("исправлено");
    expect(root.files).toEqual([file]);
    expect(root.thread_reply_count).toBe(3);
  });

  it("repairs messages cached by the build that crashed", () => {
    // Two records copied from the simulator's cache (key messages:<Backend>).
    const cached = [
      {
        ...row(rootID, 10),
        delivery: "sent",
        thread_reply_count: null,
      },
      { ...row("reply", 23, { reply_to_id: rootID }), delivery: "sent" },
    ] as unknown as ClientMessage[];
    const store = createMessengerStore();
    store.getState().replaceMessages(chatID, cached);
    for (const message of store.getState().messages[chatID]!) {
      expect(message.files).toEqual([]);
      expect(message.thread_reply_count).toBe(0);
      expect(message.mentioned_actor_ids).toEqual([]);
    }
  });

  it("keeps a complete message as it is", () => {
    const full = {
      ...row("x", 1),
      files: [],
      thread_reply_count: 2,
    } as ClientMessage;
    expect(completeMessage(full)).toEqual(full);
  });
});
