import { describe, expect, it, vi } from "vitest";

import {
  AgentClient,
  DeltaCoalescer,
  defineAgent,
  scopesForRecipe,
  simulationInput,
} from "./index.js";

describe("agent SDK", () => {
  it("uses long-poll claim without exposing transport details", async () => {
    const fetcher = vi.fn(async (_url, init) => {
      expect(JSON.parse(String(init?.body))).toMatchObject({
        wait_seconds: 25,
        lease_seconds: 90,
      });
      return new Response(null, { status: 204 });
    }) as typeof fetch;
    const client = new AgentClient("https://coma.test/", "secret", fetcher);
    await expect(
      client.claim({ workerID: crypto.randomUUID() }),
    ).resolves.toBeNull();
  });

  it("coalesces and bounds UTF-8 streaming frames", () => {
    const emitted: string[] = [];
    const stream = new DeltaCoalescer(
      (value) => emitted.push(value),
      10_000,
      8,
    );
    stream.push("абвгд");
    stream.close();
    expect(emitted.join("")).toBe("абвгд");
    expect(
      emitted.every((value) => new TextEncoder().encode(value).byteLength <= 8),
    ).toBe(true);
  });

  it("validates recipes at definition time", () => {
    expect(() =>
      defineAgent({
        name: "",
        version: 1,
        instructions: "test",
        triggers: [],
        tools: [],
      }),
    ).toThrow("Invalid agent recipe");
  });

  it("derives least-privilege scopes from declared tools", () => {
    expect(
      scopesForRecipe({
        name: "release-notes",
        version: 1,
        instructions: "Summarize releases",
        triggers: ["command:/release-notes"],
        tools: ["search_messages", "post_message"],
      }),
    ).toEqual(["messages:write", "runtime:execute", "search:read"]);
  });

  it("builds deterministic simulation trigger payloads", () => {
    expect(
      simulationInput({ kind: "command", command: "/digest weekly release" }),
    ).toMatchObject({
      simulated: true,
      trigger: {
        type: "command",
        command: "digest",
        arguments: "weekly release",
      },
    });
    expect(simulationInput({ kind: "mention", text: "@agent hi" })).toEqual({
      simulated: true,
      trigger: { type: "mention", text: "@agent hi" },
    });
  });
});
