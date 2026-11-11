import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import { releaseScheduledCache, scheduledQueryKey } from "./useScheduled";

describe("scheduled message cache", () => {
  it("belongs to one person and leaves with them", () => {
    const client = new QueryClient();
    client.setQueryData(scheduledQueryKey("anna"), [{ id: "a1" }]);
    client.setQueryData(scheduledQueryKey("boris"), [{ id: "b1" }]);
    client.setQueryData(["chat-members", "c1"], []);
    // Boris signs in: Anna's list is gone, other caches are not ours.
    releaseScheduledCache(client, "boris");
    expect(client.getQueryData(scheduledQueryKey("anna"))).toBeUndefined();
    expect(client.getQueryData(scheduledQueryKey("boris"))).toEqual([
      { id: "b1" },
    ]);
    expect(client.getQueryData(["chat-members", "c1"])).toEqual([]);
    // Boris signs out.
    releaseScheduledCache(client, null);
    expect(client.getQueryData(scheduledQueryKey("boris"))).toBeUndefined();
  });
});
