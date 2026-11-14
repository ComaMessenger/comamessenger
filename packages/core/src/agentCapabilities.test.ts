import { describe, expect, it } from "vitest";
import { capabilitiesOf, scopesFor } from "./agentCapabilities";

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
});

describe("spreadsheets", () => {
  it("derives tables:read from the chosen source within bound collections", () => {
    const capabilities = { sources: [], skills: [] };
    expect(
      scopesFor({ capabilities, hasKnowledge: true, hasTables: true, current: [] }),
    ).toContain("tables:read");
    expect(
      scopesFor({ capabilities, hasKnowledge: false, hasTables: true, current: [] }),
    ).not.toContain("tables:read");
    expect(
      scopesFor({ capabilities, hasKnowledge: true, current: ["tables:read"] }),
    ).toContain("tables:read");
    expect(
      scopesFor({ capabilities, hasKnowledge: true, hasTables: false, current: ["tables:read"] }),
    ).not.toContain("tables:read");
  });
});
