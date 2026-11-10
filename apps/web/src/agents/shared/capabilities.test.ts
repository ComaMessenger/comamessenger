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

  it("keeps reading slot tables only while a collection is bound", () => {
    const current = ["messages:read", "tables:read", "runtime:execute"] as const;
    const capabilities = { sources: [], skills: ["cards"] } as const;
    expect(
      scopesFor({
        capabilities: { sources: [], skills: [...capabilities.skills] },
        hasKnowledge: true,
        current,
      }),
    ).toEqual([
      "messages:read",
      "messages:interactive",
      "knowledge:read",
      "tables:read",
      "runtime:execute",
    ]);
    expect(
      scopesFor({
        capabilities: { sources: [], skills: [...capabilities.skills] },
        hasKnowledge: false,
        current,
      }),
    ).not.toContain("tables:read");
  });
});
