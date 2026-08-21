import { describe, expect, it, vi } from "vitest";
import type { MessengerAPI } from "@comamessenger/core";
import { AvatarObjectURLs } from "./objectURLs";

describe("avatar object URL cache", () => {
  it("deduplicates a version, invalidates older versions, and revokes on logout", async () => {
    const actorAvatar = vi.fn(async () => new Blob(["avatar"]));
    const create = vi.fn(() => `blob:${create.mock.calls.length}`);
    const revoke = vi.fn();
    vi.stubGlobal("URL", {
      ...URL,
      createObjectURL: create,
      revokeObjectURL: revoke,
    });
    const cache = new AvatarObjectURLs({
      actorAvatar,
    } as unknown as MessengerAPI);
    const first = await cache.get("actor", 1);
    expect(await cache.get("actor", 1)).toBe(first);
    expect(actorAvatar).toHaveBeenCalledTimes(1);
    await cache.get("actor", 2);
    expect(revoke).toHaveBeenCalledWith(first);
    cache.dispose();
    expect(revoke).toHaveBeenCalledTimes(2);
    vi.unstubAllGlobals();
  });
});
