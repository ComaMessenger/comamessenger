import { describe, expect, it } from "vitest";
import { agentRoute } from "./routes";

describe("agentRoute", () => {
  it("separates global and per-agent navigation", () => {
    expect(agentRoute("/agents")).toEqual({
      kind: "global",
      section: "overview",
    });
    expect(agentRoute("/agents/connections")).toEqual({
      kind: "global",
      section: "connections",
    });
    expect(agentRoute("/agents/agent-1/automations")).toEqual({
      kind: "agent",
      agentID: "agent-1",
      section: "automations",
    });
    expect(agentRoute("/agents/agent-1/unknown")).toEqual({
      kind: "agent",
      agentID: "agent-1",
      section: "overview",
    });
  });
});

describe("builderAnchor", () => {
  it("opens the matching block of the one-page builder", async () => {
    const { builderAnchor } = await import("./routes");
    expect(builderAnchor("behavior")).toBe("identity");
    expect(builderAnchor("knowledge")).toBe("knowledge");
    expect(builderAnchor("automations")).toBe("triggers");
    expect(builderAnchor("test")).toBe("check");
    expect(builderAnchor("settings")).toBe("advanced");
    expect(builderAnchor("overview")).toBe("top");
  });
});
