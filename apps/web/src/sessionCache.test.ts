import { describe, expect, it } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import { savedKeys } from "@comamessenger/core";
import { claimSessionCache } from "./sessionCache";

describe("session cache", () => {
  it("empties the cache on sign-out and when another person signs in", () => {
    const queryClient = new QueryClient();
    let owner = claimSessionCache(queryClient, null, "anna");
    queryClient.setQueryData(savedKeys.ids("anna", "chat"), ["secret"]);
    queryClient.setQueryData(["chat-members", "chat"], [{ actor_id: "x" }]);

    // The same person (a token refresh, a profile edit) keeps the cache.
    owner = claimSessionCache(queryClient, owner, "anna");
    expect(queryClient.getQueryCache().getAll()).toHaveLength(2);

    // Sign-out: nothing of Anna is left for whoever comes next.
    owner = claimSessionCache(queryClient, owner, null);
    expect(queryClient.getQueryCache().getAll()).toHaveLength(0);

    queryClient.setQueryData(savedKeys.ids("anna", "chat"), ["secret"]);
    owner = claimSessionCache(queryClient, "anna", "boris");
    expect(owner).toBe("boris");
    expect(queryClient.getQueryCache().getAll()).toHaveLength(0);
    // And even a stale entry could not be read under Boris's keys.
    expect(queryClient.getQueryData(savedKeys.ids("boris", "chat"))).toBeUndefined();
  });
});
