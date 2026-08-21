import type { CreateAgentTriggerRequest } from "@comamessenger/core";

export type AgentTemplate = "custom" | "summarizer" | "qa" | "onboarding";

export function builtinTriggerRequests(
  template: AgentTemplate,
  chatID?: string,
): CreateAgentTriggerRequest[] {
  if (template === "summarizer") {
    return [
      {
        type: "command",
        config: { command: "summarize", include_agent_messages: false },
        enabled: true,
        timezone: "UTC",
        missed_runs_policy: "skip",
      },
      ...(chatID
        ? [
            {
              type: "schedule" as const,
              config: {
                chat_id: chatID,
                hour: 9,
                minute: 0,
                days_of_week: [],
              },
              enabled: true,
              timezone: "UTC",
              missed_runs_policy: "latest" as const,
            },
          ]
        : []),
    ];
  }
  if (template === "qa") {
    return [
      {
        type: "mention",
        config: { include_agent_messages: false },
        enabled: true,
        timezone: "UTC",
        missed_runs_policy: "skip",
      },
    ];
  }
  if (template === "onboarding") {
    return [
      {
        type: "event",
        config: {
          event_types: ["member.joined"],
          include_agent_messages: false,
          ...(chatID ? { chat_id: chatID } : {}),
        },
        enabled: true,
        timezone: "UTC",
        missed_runs_policy: "latest",
      },
      {
        type: "mention",
        config: { include_agent_messages: false },
        enabled: true,
        timezone: "UTC",
        missed_runs_policy: "skip",
      },
    ];
  }
  return [];
}
