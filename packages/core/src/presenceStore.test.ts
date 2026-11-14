import { afterEach, describe, expect, it, vi } from "vitest";
import type { MessengerAPI } from "./api";
import { RealtimeCoordinator, presenceRefreshMs } from "./realtime";
import { createMessengerStore } from "./store";

afterEach(() => vi.useRealTimers());

function harness() {
  const sent: Record<string, unknown>[] = [];
  const snapshots: unknown[] = [];
  const socket = {
    readyState: 1,
    send: (value: string) => sent.push(JSON.parse(value)),
    close: () => undefined,
    onopen: null as ((event: unknown) => void) | null,
    onmessage: null as ((event: { data: string }) => void) | null,
    onclose: null as ((event: unknown) => void) | null,
  };
  const api = {
    token: () => "token",
    refresh: async () => undefined,
    websocketURL: () => "ws://test",
  } as unknown as MessengerAPI;
  const coordinator = new RealtimeCoordinator(
    api,
    {
      get: async () => 0,
      set: async () => undefined,
      clear: async () => undefined,
    },
    () => {
      queueMicrotask(() => socket.onopen?.({}));
      return socket;
    },
    {
      state: () => undefined,
      event: () => false,
      resync: async () => undefined,
      presenceSnapshot: (frame) => snapshots.push(frame),
    },
  );
  const hello = (features?: string[]) =>
    socket.onmessage?.({
      data: JSON.stringify({
        op: "hello",
        current_seq: 0,
        ack_interval_ms: 1000,
        ack_batch_size: 50,
        ...(features ? { features } : {}),
      }),
    });
  return { sent, snapshots, socket, coordinator, hello };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("typing actions on the wire", () => {
  it("names the action only to a server that announced it", async () => {
    const { sent, coordinator, hello } = harness();
    coordinator.start();
    await flush();
    hello();
    await flush();
    coordinator.typing("chat", true, null, "uploading_photo");
    expect(sent.at(-1)).toEqual({
      op: "typing",
      chat_id: "chat",
      thread_root_id: null,
      active: true,
    });
    hello(["typing_actions"]);
    await flush();
    coordinator.typing("chat", true, null, "uploading_photo");
    expect(sent.at(-1)).toMatchObject({ action: "uploading_photo" });
    // Plain typing stays the old frame.
    coordinator.typing("chat", true);
    expect(sent.at(-1)).not.toHaveProperty("action");
    coordinator.stop();
  });
});

describe("presence on the wire", () => {
  it("repeats the state after hello and every refresh, and passes the snapshot on", async () => {
    const { sent, snapshots, socket, coordinator, hello } = harness();
    coordinator.start();
    await flush();
    vi.useFakeTimers();
    coordinator.presence("active");
    sent.length = 0;
    hello();
    await vi.advanceTimersByTimeAsync(0);
    expect(sent).toContainEqual({ op: "presence", state: "active" });
    coordinator.presence("away");
    sent.length = 0;
    await vi.advanceTimersByTimeAsync(presenceRefreshMs);
    expect(sent).toEqual([{ op: "presence", state: "away" }]);
    socket.onmessage?.({
      data: JSON.stringify({ op: "presence.snapshot", actors: [] }),
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(snapshots).toHaveLength(1);
    coordinator.stop();
    sent.length = 0;
    await vi.advanceTimersByTimeAsync(presenceRefreshMs * 2);
    expect(sent).toEqual([]);
  });
});

describe("store: typing and presence", () => {
  it("keeps actions by scope and expires them", () => {
    vi.useFakeTimers();
    const store = createMessengerStore();
    const expiresAt = new Date(Date.now() + 6000).toISOString();
    store
      .getState()
      .setTyping("chat", "anna", true, {
        action: "recording_voice",
        expiresAt,
      });
    store
      .getState()
      .setTyping("chat", "oleg", true, { threadRootID: "root", expiresAt });
    expect(store.getState().typingActions.chat).toEqual({
      anna: { action: "recording_voice", expiresAt: Date.parse(expiresAt) },
    });
    expect(Object.keys(store.getState().typingActions["chat:root"]!)).toEqual([
      "oleg",
    ]);
    vi.advanceTimersByTime(6100);
    expect(store.getState().typingActions.chat).toEqual({});
    expect(store.getState().typing.chat).toEqual([]);
  });

  it("a newer typing frame outlives the older timer", () => {
    vi.useFakeTimers();
    const store = createMessengerStore();
    const first = new Date(Date.now() + 6000).toISOString();
    store.getState().setTyping("chat", "anna", true, { expiresAt: first });
    vi.advanceTimersByTime(3000);
    const second = new Date(Date.now() + 6000).toISOString();
    store.getState().setTyping("chat", "anna", true, { expiresAt: second });
    vi.advanceTimersByTime(3500);
    expect(store.getState().typingActions.chat?.anna).toBeDefined();
    vi.advanceTimersByTime(3000);
    expect(store.getState().typingActions.chat?.anna).toBeUndefined();
  });

  it("expires presence, remembers last seen and trusts the snapshot", () => {
    vi.useFakeTimers();
    const store = createMessengerStore();
    store.getState().setPresence("anna", "online", {
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    store.getState().setPresence("oleg", "online", {
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    store.getState().applyPresenceSnapshot([
      {
        actorID: "anna",
        state: "online",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
    ]);
    expect(store.getState().presence).toEqual({
      anna: "online",
      oleg: "offline",
    });
    vi.advanceTimersByTime(61_000);
    expect(store.getState().presence.anna).toBe("offline");
    store.getState().setPresence("oleg", "offline", {
      lastSeenAt: "2026-11-14T12:00:00Z",
    });
    expect(store.getState().lastSeen.oleg).toBe("2026-11-14T12:00:00Z");
  });
});
