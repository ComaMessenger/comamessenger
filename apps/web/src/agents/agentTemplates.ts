import type { CreateAgentTriggerRequest } from "@comamessenger/core";

export type AgentTemplate = "custom" | "summarizer" | "qa" | "onboarding";

export type AgentLaunch =
  | "manual"
  | "mention"
  | "command"
  | "schedule"
  | "member_join";

export type AgentRecipeOptions = {
  launch: AgentLaunch;
  destinationChatID?: string;
  command?: string;
  hour?: number;
  minute?: number;
  timezone?: string;
};

export function recipeTriggerRequests(
  template: AgentTemplate,
  options: AgentRecipeOptions,
): CreateAgentTriggerRequest[] {
  const timezone = options.timezone || "UTC";
  if (options.launch === "manual") {
    return [
      {
        type: "manual",
        config: {},
        enabled: true,
        timezone,
        missed_runs_policy: "skip",
      },
    ];
  }
  if (options.launch === "mention") {
    return [
      {
        type: "mention",
        config: { include_agent_messages: false },
        enabled: true,
        timezone,
        missed_runs_policy: "skip",
      },
    ];
  }
  if (options.launch === "command") {
    return [
      {
        type: "command",
        config: {
          command:
            options.command?.trim().replace(/^\/+/, "") ||
            (template === "summarizer" ? "summarize" : "ask"),
          include_agent_messages: false,
        },
        enabled: true,
        timezone,
        missed_runs_policy: "skip",
      },
    ];
  }
  if (options.launch === "schedule") {
    if (!options.destinationChatID) return [];
    return [
      {
        type: "schedule",
        config: {
          chat_id: options.destinationChatID,
          hour: options.hour ?? 9,
          minute: options.minute ?? 0,
          days_of_week: [],
        },
        enabled: true,
        timezone,
        missed_runs_policy: "latest",
      },
    ];
  }
  if (options.launch === "member_join") {
    return [
      {
        type: "event",
        config: {
          event_types: ["member.joined"],
          include_agent_messages: false,
          ...(options.destinationChatID
            ? { chat_id: options.destinationChatID }
            : {}),
        },
        enabled: true,
        timezone,
        missed_runs_policy: "latest",
      },
    ];
  }
  return [];
}

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
