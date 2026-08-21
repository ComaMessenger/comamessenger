import { describe, expect, it } from "vitest";

import { builtinTriggerRequests } from "./agentTemplates";

describe("built-in agent templates", () => {
  it("gives Summarizer both manual and scheduled entry points", () => {
    expect(
      builtinTriggerRequests(
        "summarizer",
        "00000000-0000-7000-8000-000000000001",
      ).map((trigger) => trigger.type),
    ).toEqual(["command", "schedule"]);
  });

  it("gives Q&A a mention trigger", () => {
    expect(builtinTriggerRequests("qa").map((trigger) => trigger.type)).toEqual(
      ["mention"],
    );
  });

  it("greets new members and remains available for follow-up mentions", () => {
    const triggers = builtinTriggerRequests(
      "onboarding",
      "00000000-0000-7000-8000-000000000001",
    );
    expect(triggers.map((trigger) => trigger.type)).toEqual([
      "event",
      "mention",
    ]);
    expect(triggers[0]?.config).toMatchObject({
      event_types: ["member.joined"],
    });
  });
});
