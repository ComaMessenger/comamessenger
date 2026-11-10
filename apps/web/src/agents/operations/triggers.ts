import type { Translate } from "../shared/format";

export function triggerConfig(
  type: string,
  value: string,
  chatID?: string,
): Record<string, unknown> {
  if (type === "manual") return {};
  if (type === "command")
    return { command: value.replace(/^\//, ""), include_agent_messages: false };
  if (type === "keyword")
    return {
      pattern: value,
      case_sensitive: false,
      include_agent_messages: false,
    };
  if (type === "event")
    return {
      event_types: [value],
      include_agent_messages: false,
      ...(chatID ? { chat_id: chatID } : {}),
    };
  if (type === "schedule") {
    const [hour, minute] = value.split(":").map(Number);
    return {
      chat_id: chatID,
      hour: hour || 0,
      minute: minute || 0,
      days_of_week: [],
    };
  }
  return { include_agent_messages: false };
}

export function triggerDetails(
  t: Translate,
  type: string,
  rawConfig: unknown,
): string {
  const config = rawConfig as Record<string, unknown>;
  if (type === "manual") return t("agentWizardLaunchHint_manual");
  if (type === "command") return `/${String(config.command ?? "")}`;
  if (type === "keyword") return String(config.pattern ?? "");
  if (type === "schedule")
    return `${String(config.hour ?? 0).padStart(2, "0")}:${String(
      config.minute ?? 0,
    ).padStart(2, "0")}`;
  if (type === "event")
    return Array.isArray(config.event_types)
      ? config.event_types.join(", ")
      : t("agentTriggerEventHint");
  return type === "mention"
    ? t("agentTriggerMentionHint")
    : t("agentTriggerEveryMessageHint");
}
