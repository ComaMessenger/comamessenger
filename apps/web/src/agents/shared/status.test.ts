import type { Agent } from "@comamessenger/core";
import { describe, expect, it } from "vitest";
import { humanStatus } from "./status";

const agent = (patch: Partial<Agent>): Agent =>
  ({
    operational_status: "active",
    published_version: 2,
    has_unpublished_changes: false,
    readiness: { state: "active", ready: true, blockers: [] },
    ...patch,
  }) as Agent;

describe("human status", () => {
  it("puts waiting people first", () => {
    expect(humanStatus(agent({}), 2)).toEqual({ kind: "approval", count: 2 });
  });

  it("names the reason of a problem", () => {
    expect(
      humanStatus(
        agent({
          readiness: {
            state: "needs_setup",
            ready: false,
            blockers: ["llm_connection_unavailable"],
          },
        }),
      ),
    ).toEqual({ kind: "attention", reason: "agentBlocker_llm_connection_unavailable" });
    expect(humanStatus(agent({ operational_status: "needs_attention" }))).toEqual({
      kind: "attention",
      reason: "agentAttention_runs",
    });
  });

  it("does not alarm about an unfinished draft of a working agent", () => {
    expect(
      humanStatus(
        agent({
          has_unpublished_changes: true,
          readiness: { state: "needs_setup", ready: false, blockers: ["chat_required"] },
        }),
      ),
    ).toEqual({ kind: "working", changed: true });
  });

  it("separates pause and draft", () => {
    expect(humanStatus(agent({ operational_status: "paused" }))).toEqual({ kind: "paused" });
    expect(
      humanStatus(agent({ operational_status: "draft", published_version: null })),
    ).toEqual({ kind: "draft" });
  });
});
