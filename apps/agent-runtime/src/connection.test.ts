import { describe, expect, it, vi } from "vitest";

import type { MessengerAPI } from "@comamessenger/core";

import { AgentConnectionManager, type SocketLike } from "./connection.js";

function socket(): SocketLike & { close: ReturnType<typeof vi.fn> } {
  return {
    readyState: 1,
    send: vi.fn(),
    close: vi.fn(),
    onopen: null,
    onmessage: null,
    onclose: null,
  };
}

describe("AgentConnectionManager protocol errors", () => {
  it("reports rejected ephemeral operations and keeps a non-fatal socket open", async () => {
    const current = socket();
    const errors = vi.fn();
    const api = {
      agentRuntimeCheckpoint: vi.fn(async () => ({ last_event_seq: 0 })),
      websocketURL: vi.fn(() => "wss://core.test/ws"),
    } as unknown as MessengerAPI;
    const connection = new AgentConnectionManager(
      api,
      "test",
      () => current,
      async () => {},
      errors,
    );
    connection.start();
    await vi.waitFor(() => expect(current.onmessage).not.toBeNull());
    current.onmessage?.({
      data: JSON.stringify({
        op: "error",
        code: "ephemeral_rate_limited",
        message: "Operation rate limited",
        fatal: false,
      }),
    });
    await vi.waitFor(() =>
      expect(errors).toHaveBeenCalledWith({
        code: "ephemeral_rate_limited",
        message: "Operation rate limited",
        fatal: false,
      }),
    );
    expect(current.close).not.toHaveBeenCalled();
    connection.stop();
  });

  it("closes the connection on a fatal protocol error", async () => {
    const current = socket();
    const api = {
      agentRuntimeCheckpoint: vi.fn(async () => ({ last_event_seq: 0 })),
      websocketURL: vi.fn(() => "wss://core.test/ws"),
    } as unknown as MessengerAPI;
    const connection = new AgentConnectionManager(
      api,
      "test",
      () => current,
      async () => {},
      vi.fn(),
    );
    connection.start();
    await vi.waitFor(() => expect(current.onmessage).not.toBeNull());
    current.onmessage?.({
      data: JSON.stringify({ op: "error", code: "forbidden", fatal: true }),
    });
    await vi.waitFor(() => expect(current.close).toHaveBeenCalled());
    connection.stop();
  });
});
