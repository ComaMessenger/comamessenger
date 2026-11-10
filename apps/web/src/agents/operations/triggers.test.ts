import { describe, expect, it } from "vitest";

import { triggerConfig, triggerDetails } from "./triggers";

const t = ((key: string) => key) as Parameters<typeof triggerDetails>[0];

describe("manual trigger form", () => {
  it("strips the slash from commands", () => {
    expect(triggerConfig("command", "/summarize")).toEqual({
      command: "summarize",
      include_agent_messages: false,
    });
  });

  it("parses schedule time and binds the first agent chat", () => {
    expect(triggerConfig("schedule", "09:05", "chat-1")).toEqual({
      chat_id: "chat-1",
      hour: 9,
      minute: 5,
      days_of_week: [],
    });
    expect(triggerConfig("schedule", "", "chat-1")).toMatchObject({
      hour: 0,
      minute: 0,
    });
  });

  it("scopes events to a chat only when one is known", () => {
    expect(triggerConfig("event", "member.joined")).toEqual({
      event_types: ["member.joined"],
      include_agent_messages: false,
    });
    expect(triggerConfig("event", "member.joined", "chat-1")).toMatchObject({
      chat_id: "chat-1",
    });
  });

  it("describes stored triggers", () => {
    expect(triggerDetails(t, "schedule", { hour: 9, minute: 5 })).toBe("09:05");
    expect(triggerDetails(t, "command", { command: "sum" })).toBe("/sum");
    expect(triggerDetails(t, "event", {})).toBe("agentTriggerEventHint");
    expect(triggerDetails(t, "every_message", {})).toBe(
      "agentTriggerEveryMessageHint",
    );
  });
});
