import type { AgentTrigger, Chat } from "@comamessenger/core";
import { describe, expect, it } from "vitest";
import {
  describeRule,
  emptyRule,
  keywordPattern,
  keywordsOf,
  ruleProblem,
  triggerRequest,
} from "./triggers";

const t = ((key: string, values?: Record<string, unknown>) =>
  values ? `${key}:${JSON.stringify(values)}` : key) as Parameters<
  typeof describeRule
>[0];
const chat = { id: "chat-1", name: "Зал 1" } as Chat;
const trigger = (
  type: AgentTrigger["type"],
  config: Record<string, unknown>,
  timezone = "Europe/Moscow",
) => ({ type, config, timezone });

describe("launch rules", () => {
  it("turns keywords into a safe alternation and back", () => {
    expect(keywordPattern("замена, a+b")).toBe("(замена|a\\+b)");
    expect(keywordPattern("отчёт")).toBe("отчёт");
    expect(keywordsOf("(замена|a\\+b)")).toBe("замена, a+b");
    expect(keywordsOf("^custom.*regex$")).toBeNull();
  });

  it("creates every rule in the person's timezone", () => {
    const form = emptyRule("manual", { timezone: "Asia/Yekaterinburg" });
    expect(triggerRequest(form)).toMatchObject({
      type: "manual",
      timezone: "Asia/Yekaterinburg",
      config: {},
    });
    const schedule = {
      ...emptyRule("schedule", { chatID: "chat-1", timezone: "Europe/Moscow" }),
      time: "18:05",
      days: [5, 1],
    };
    expect(triggerRequest(schedule)).toMatchObject({
      type: "schedule",
      timezone: "Europe/Moscow",
      missed_runs_policy: "latest",
      config: { chat_id: "chat-1", hour: 18, minute: 5, days_of_week: [1, 5] },
    });
  });

  it("explains what is missing in a form", () => {
    expect(ruleProblem(emptyRule("command", { timezone: "UTC" }))).toBe(
      "agentRuleProblem_command",
    );
    expect(ruleProblem(emptyRule("schedule", { timezone: "UTC" }))).toBe(
      "agentRuleProblem_scheduleChat",
    );
    expect(
      ruleProblem({
        ...emptyRule("command", { timezone: "UTC" }),
        command: "/sum",
      }),
    ).toBeNull();
  });

  it("reads every trigger type as a sentence", () => {
    expect(
      describeRule(t, trigger("mention", {}), [chat], "Europe/Moscow"),
    ).toEqual({
      when: "agentRuleWhen_mention",
      then: "agentRuleThen_reply",
    });
    expect(
      describeRule(
        t,
        trigger("schedule", {
          chat_id: "chat-1",
          hour: 9,
          minute: 0,
          days_of_week: [1, 2, 3, 4, 5],
        }),
        [chat],
        "Europe/Moscow",
      ),
    ).toEqual({
      when: 'agentRuleWhen_schedule:{"days":"agentRuleWorkDays","time":"09:00","zone":""}',
      then: 'agentRuleThen_writeTo:{"chat":"Зал 1"}',
    });
    expect(
      describeRule(
        t,
        trigger("schedule", { chat_id: "chat-1", hour: 7, minute: 30 }, "UTC"),
        [chat],
        "Europe/Moscow",
      ).when,
    ).toContain('"zone":" (UTC)"');
    expect(
      describeRule(
        t,
        trigger("event", { event_types: ["member.joined"], chat_id: "chat-1" }),
        [chat],
        "UTC",
      ).when,
    ).toBe(
      'agentRuleWhen_eventIn:{"event":"agentEvent_member_joined","chat":"Зал 1"}',
    );
    expect(
      describeRule(
        t,
        trigger("event", { event_types: ["chat.updated"] }),
        [],
        "UTC",
      ).when,
    ).toBe('agentRuleWhen_event:{"event":"agentEvent_other"}');
    expect(describeRule(t, trigger("manual", {}), [], "UTC")).toEqual({
      when: "agentRuleWhen_manual",
      then: "",
    });
  });
});

describe("webhook rules", () => {
  it("reads as a sentence with the webhook name and the target chat", () => {
    const form = {
      ...emptyRule("webhook", { chatID: "chat-1", timezone: "UTC" }),
      webhookID: "hook-1",
      webhookEvents: "slot.released, slot.released, slot.changed",
    };
    expect(ruleProblem(form)).toBeNull();
    const request = triggerRequest(form);
    expect(request.config).toEqual({
      webhook_id: "hook-1",
      chat_id: "chat-1",
      event_types: ["slot.released", "slot.changed"],
    });
    expect(
      describeRule(
        t,
        trigger("webhook", request.config, "UTC"),
        [chat],
        "UTC",
        new Map([["hook-1", "Учёт"]]),
      ),
    ).toEqual({
      when: 'agentRuleWhen_webhookEvents:{"system":"Учёт","events":"slot.released, slot.changed"}',
      then: 'agentRuleThen_writeTo:{"chat":"Зал 1"}',
    });
  });

  it("asks for a webhook, a chat and valid event names", () => {
    const base = emptyRule("webhook", { chatID: "chat-1", timezone: "UTC" });
    expect(ruleProblem(base)).toBe("agentRuleProblem_webhook");
    expect(ruleProblem({ ...base, webhookID: "h", chatID: "" })).toBe(
      "agentRuleProblem_webhookChat",
    );
    expect(
      ruleProblem({ ...base, webhookID: "h", webhookEvents: "bad event" }),
    ).toBe("agentRuleProblem_webhookEvents");
  });
});
