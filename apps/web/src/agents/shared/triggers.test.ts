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
      ruleProblem({ ...emptyRule("command", { timezone: "UTC" }), command: "/sum" }),
    ).toBeNull();
  });

  it("reads every trigger type as a sentence", () => {
    expect(describeRule(t, trigger("mention", {}), [chat], "Europe/Moscow")).toEqual({
      when: "agentRuleWhen_mention",
      then: "agentRuleThen_reply",
    });
    expect(
      describeRule(
        t,
        trigger("schedule", { chat_id: "chat-1", hour: 9, minute: 0, days_of_week: [1, 2, 3, 4, 5] }),
        [chat],
        "Europe/Moscow",
      ),
    ).toEqual({
      when: 'agentRuleWhen_schedule:{"days":"agentRuleWorkDays","time":"09:00","zone":""}',
      then: 'agentRuleThen_writeTo:{"chat":"Зал 1"}',
    });
    expect(
      describeRule(t, trigger("schedule", { chat_id: "chat-1", hour: 7, minute: 30 }, "UTC"), [chat], "Europe/Moscow")
        .when,
    ).toContain('"zone":" (UTC)"');
    expect(
      describeRule(t, trigger("event", { event_types: ["member.joined"], chat_id: "chat-1" }), [chat], "UTC").when,
    ).toBe('agentRuleWhen_eventIn:{"event":"agentEvent_member_joined","chat":"Зал 1"}');
    expect(
      describeRule(t, trigger("event", { event_types: ["chat.updated"] }), [], "UTC").when,
    ).toBe('agentRuleWhen_event:{"event":"agentEvent_other"}');
    expect(describeRule(t, trigger("manual", {}), [], "UTC")).toEqual({
      when: "agentRuleWhen_manual",
      then: "",
    });
  });
});
