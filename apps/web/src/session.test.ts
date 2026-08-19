import { describe, expect, it, vi } from "vitest";
import type { TokenResponse } from "@comamessenger/core";
import {
  BrowserSessionCoordinator,
  type SessionChannel,
  type SessionLocks,
} from "./session";

class SerialLocks implements SessionLocks {
  private tail: Promise<unknown> = Promise.resolve();

  request<T>(_name: string, callback: () => Promise<T>): Promise<T> {
    const result = this.tail.then(callback, callback);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

function channelPair(): [SessionChannel, SessionChannel] {
  const first: SessionChannel = {
    onmessage: null,
    postMessage: (message) =>
      queueMicrotask(() =>
        second.onmessage?.({ data: message } as MessageEvent),
      ),
    close: () => undefined,
  };
  const second: SessionChannel = {
    onmessage: null,
    postMessage: (message) =>
      queueMicrotask(() =>
        first.onmessage?.({ data: message } as MessageEvent),
      ),
    close: () => undefined,
  };
  return [first, second];
}

const tokens = {
  access_token: "shared-access-token",
  access_expires_at: "2026-08-19T15:00:00Z",
  user: { id: "actor" },
} as TokenResponse;

describe("browser session coordinator", () => {
  it("rotates a shared refresh cookie only once across simultaneous tabs", async () => {
    const [firstChannel, secondChannel] = channelPair();
    const locks = new SerialLocks();
    const first = new BrowserSessionCoordinator(firstChannel, locks);
    const second = new BrowserSessionCoordinator(secondChannel, locks);
    const request = vi.fn(async () => tokens);

    const [firstResult, secondResult] = await Promise.all([
      first.refresh(request),
      second.refresh(request),
    ]);

    expect(request).toHaveBeenCalledOnce();
    expect(firstResult.access_token).toBe(tokens.access_token);
    expect(secondResult.access_token).toBe(tokens.access_token);
    first.close();
    second.close();
  });
});
