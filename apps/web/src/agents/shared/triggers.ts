import type {
  AgentTrigger,
  Chat,
  CreateAgentTriggerRequest,
} from "@comamessenger/core";
import { chatName, type Translate } from "./format";

/*
 * Launch rules as sentences. Every server trigger type has its own subject
 * form; nothing asks for a raw «configuration» string.
 */

export type TriggerType = AgentTrigger["type"];

export const triggerTypes: TriggerType[] = [
  "mention",
  "command",
  "keyword",
  "schedule",
  "event",
  "every_message",
  "manual",
];

/** Events a rule can wait for; the server accepts any event kind. */
export const knownEvents = [
  "member.joined",
  "member.removed",
  "reaction.added",
  "message.pinned",
] as const;

/** Monday first; values are Go weekdays (Sunday = 0) as the server stores. */
export const weekDays = [1, 2, 3, 4, 5, 6, 0] as const;
export const workDays = [1, 2, 3, 4, 5];

export type RuleForm = {
  type: TriggerType;
  command: string;
  keywords: string;
  chatID: string;
  time: string;
  days: number[];
  eventType: string;
  timezone: string;
};

export function emptyRule(
  type: TriggerType,
  defaults: { chatID?: string; timezone: string },
): RuleForm {
  return {
    type,
    command: "",
    keywords: "",
    chatID: type === "schedule" ? (defaults.chatID ?? "") : "",
    time: "09:00",
    days: [],
    eventType: "member.joined",
    timezone: defaults.timezone,
  };
}

const escapeRegex = (value: string) =>
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Plain keywords become an alternation; the server matches case-insensitively. */
export function keywordPattern(keywords: string): string {
  const words = keywords
    .split(",")
    .map((word) => word.trim())
    .filter(Boolean);
  if (words.length === 1) return escapeRegex(words[0]!);
  return words.length ? `(${words.map(escapeRegex).join("|")})` : "";
}

/** Reads keywords back from a pattern the builder wrote; null otherwise. */
export function keywordsOf(pattern: string): string | null {
  const body =
    pattern.startsWith("(") && pattern.endsWith(")")
      ? pattern.slice(1, -1)
      : pattern;
  const words: string[] = [];
  let current = "";
  for (let index = 0; index < body.length; index++) {
    const character = body[index]!;
    if (character === "\\" && index + 1 < body.length) {
      current += body[++index];
      continue;
    }
    if (character === "|") {
      words.push(current);
      current = "";
      continue;
    }
    if (/[.*+?^${}()[\]]/.test(character)) return null;
    current += character;
  }
  words.push(current);
  return words.every((word) => word.trim()) ? words.join(", ") : null;
}

export function ruleFromTrigger(trigger: AgentTrigger): RuleForm {
  const config = trigger.config as Record<string, unknown>;
  const hour = Number(config.hour ?? 9);
  const minute = Number(config.minute ?? 0);
  return {
    type: trigger.type,
    command: String(config.command ?? ""),
    keywords: keywordsOf(String(config.pattern ?? "")) ?? "",
    chatID: String(config.chat_id ?? ""),
    time: `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`,
    days: Array.isArray(config.days_of_week)
      ? (config.days_of_week as number[])
      : [],
    eventType: Array.isArray(config.event_types)
      ? String(config.event_types[0] ?? "member.joined")
      : "member.joined",
    timezone: trigger.timezone,
  };
}

/** i18n key of the first problem in the form, or null when it can be saved. */
export function ruleProblem(form: RuleForm): string | null {
  if (
    form.type === "command" &&
    !/^[^\s/][^\s]{0,63}$/.test(form.command.trim().replace(/^\/+/, ""))
  )
    return "agentRuleProblem_command";
  if (form.type === "keyword" && !keywordPattern(form.keywords))
    return "agentRuleProblem_keyword";
  if (form.type === "schedule" && !form.chatID)
    return "agentRuleProblem_scheduleChat";
  if (form.type === "schedule" && !/^\d{2}:\d{2}$/.test(form.time))
    return "agentRuleProblem_time";
  return null;
}

export function triggerConfig(form: RuleForm): Record<string, unknown> {
  switch (form.type) {
    case "manual":
      return {};
    case "command":
      return {
        command: form.command.trim().replace(/^\/+/, "").toLowerCase(),
        include_agent_messages: false,
      };
    case "keyword":
      return {
        pattern: keywordPattern(form.keywords),
        case_sensitive: false,
        include_agent_messages: false,
      };
    case "event":
      return {
        event_types: [form.eventType],
        include_agent_messages: false,
        ...(form.chatID ? { chat_id: form.chatID } : {}),
      };
    case "schedule": {
      const [hour, minute] = form.time.split(":").map(Number);
      return {
        chat_id: form.chatID,
        hour: hour || 0,
        minute: minute || 0,
        days_of_week: [...form.days].sort(),
      };
    }
    default:
      return { include_agent_messages: false };
  }
}

export function triggerRequest(form: RuleForm): CreateAgentTriggerRequest {
  return {
    type: form.type,
    config: triggerConfig(form),
    enabled: true,
    timezone: form.timezone || "UTC",
    missed_runs_policy:
      form.type === "schedule" || form.type === "event" ? "latest" : "skip",
  };
}

export function scheduleDays(t: Translate, days: number[]): string {
  const unique = [...new Set(days)];
  if (unique.length === 0 || unique.length === 7) return t("agentRuleEveryDay");
  if (
    unique.length === workDays.length &&
    workDays.every((day) => unique.includes(day))
  )
    return t("agentRuleWorkDays");
  return t("agentRuleOnDays", {
    days: weekDays
      .filter((day) => unique.includes(day))
      .map((day) => t(`agentWeekdayShort_${day}`))
      .join(", "),
  });
}

/**
 * «When … → …». `then` is empty for manual rules, which have no automatic
 * consequence.
 */
export function describeRule(
  t: Translate,
  trigger: Pick<AgentTrigger, "type" | "config" | "timezone">,
  chats: Chat[],
  userTimezone: string,
): { when: string; then: string } {
  const form = ruleFromTrigger(trigger as AgentTrigger);
  const chat = chats.find((item) => item.id === form.chatID);
  const config = trigger.config as Record<string, unknown>;
  switch (trigger.type) {
    case "mention":
      return { when: t("agentRuleWhen_mention"), then: t("agentRuleThen_reply") };
    case "command":
      return {
        when: t("agentRuleWhen_command", { command: form.command }),
        then: t("agentRuleThen_task"),
      };
    case "keyword":
      return {
        when: t("agentRuleWhen_keyword", {
          words: form.keywords || String(config.pattern ?? ""),
        }),
        then: t("agentRuleThen_reply"),
      };
    case "every_message":
      return {
        when: t("agentRuleWhen_every_message"),
        then: t("agentRuleThen_reply"),
      };
    case "schedule":
      return {
        when: t("agentRuleWhen_schedule", {
          days: scheduleDays(t, form.days),
          time: form.time,
          zone:
            trigger.timezone && trigger.timezone !== userTimezone
              ? ` (${trigger.timezone})`
              : "",
        }),
        then: chat
          ? t("agentRuleThen_writeTo", { chat: chatName(chat) })
          : t("agentRuleThen_writeToMissing"),
      };
    case "event": {
      const kinds = Array.isArray(config.event_types)
        ? (config.event_types as string[])
        : [];
      const event = kinds
        .map((kind) =>
          (knownEvents as readonly string[]).includes(kind)
            ? t(`agentEvent_${kind.replace(".", "_")}`)
            : t("agentEvent_other"),
        )
        .join(t("agentRuleOr"));
      return {
        when: chat
          ? t("agentRuleWhen_eventIn", {
              event: event || t("agentEvent_other"),
              chat: chatName(chat),
            })
          : t("agentRuleWhen_event", { event: event || t("agentEvent_other") }),
        then: t("agentRuleThen_task"),
      };
    }
    default:
      return { when: t("agentRuleWhen_manual"), then: "" };
  }
}
