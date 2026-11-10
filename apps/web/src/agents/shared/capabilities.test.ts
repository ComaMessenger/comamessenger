import { describe, expect, it } from "vitest";
import { capabilitiesOf, scopesFor } from "./capabilities";

describe("scopes derived from builder blocks", () => {
  it("always keeps reading the agent chats and running", () => {
    expect(
      scopesFor({
        capabilities: { sources: [], skills: [] },
        hasKnowledge: false,
        current: [],
      }),
    ).toEqual(["messages:read", "runtime:execute"]);
  });

  it("maps knowledge and skills to their scopes in a stable order", () => {
    expect(
      scopesFor({
        capabilities: {
          sources: ["search", "members"],
          skills: ["cards", "memory"],
        },
        hasKnowledge: true,
        current: ["runtime:worker", "reactions:write"],
      }),
    ).toEqual([
      "messages:read",
      "messages:interactive",
      "search:read",
      "members:read",
      "knowledge:read",
      "memory:read",
      "memory:write",
      "runtime:execute",
      "runtime:worker",
    ]);
  });

  it("reads the switches back from scopes", () => {
    expect(
      capabilitiesOf([
        "messages:read",
        "messages:write",
        "files:read",
        "followups:write",
        "memory:read",
      ]),
    ).toEqual({ sources: ["files"], skills: ["messages", "followups"] });
  });

  it("keeps reading slot tables through edits of other blocks", () => {
    const current = ["messages:read", "tables:read", "runtime:execute"] as const;
    for (const hasKnowledge of [true, false])
      expect(
        scopesFor({
          capabilities: { sources: [], skills: ["cards"] },
          hasKnowledge,
          current,
        }),
      ).toContain("tables:read");
    expect(
      scopesFor({
        capabilities: { sources: [], skills: [] },
        hasKnowledge: true,
        current: ["messages:read"],
      }),
    ).not.toContain("tables:read");
  });

  it("writes to people privately only as its own skill", () => {
    expect(
      scopesFor({
        capabilities: { sources: [], skills: ["direct"] },
        hasKnowledge: false,
        current: [],
      }),
    ).toEqual(["messages:read", "messages:direct_cards", "runtime:execute"]);
    expect(
      capabilitiesOf(["messages:read", "messages:interactive"]).skills,
    ).toEqual(["cards"]);
    expect(
      capabilitiesOf(["messages:interactive", "messages:direct_cards"]).skills,
    ).toEqual(["cards", "direct"]);
  });
});
