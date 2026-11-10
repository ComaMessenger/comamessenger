import type { TFunction } from "i18next";
import type { ChatAgent } from "@comamessenger/core";

const readScopes: Array<[string, string]> = [
  ["messages:read", "acReadMessages"],
  ["files:read", "acReadFiles"],
  ["search:read", "acReadSearch"],
  ["members:read", "acReadMembers"],
  ["chats:read", "acReadChats"],
  ["memory:read", "acReadMemory"],
  ["tables:read", "acReadTables"],
];

const writeScopes: Array<[string, string]> = [
  ["messages:write", "acDoWrite"],
  ["reactions:write", "acDoReact"],
  ["messages:interactive", "acDoInteractive"],
  ["followups:write", "acDoFollowups"],
  ["memory:write", "acDoMemory"],
];

/** What the agent reads, in plain language. */
export function describeReads(agent: ChatAgent, t: TFunction): string[] {
  const scopes = new Set<string>(agent.scopes);
  const lines = readScopes
    .filter(([scope]) => scopes.has(scope))
    .map(([, key]) => t(key));
  if (scopes.has("knowledge:read"))
    lines.push(t("acReadKnowledge", { count: agent.knowledge_collection_count }));
  return lines;
}

/** What the agent may do, in plain language. */
export function describeActions(agent: ChatAgent, t: TFunction): string[] {
  const scopes = new Set<string>(agent.scopes);
  const lines = writeScopes
    .filter(([scope]) => scopes.has(scope))
    .map(([, key]) => t(key));
  return lines.length ? lines : [t("acDoNothing")];
}

function weekdays(days: number[], locale: string): string {
  const format = new Intl.DateTimeFormat(locale, { weekday: "short" });
  // 2026-11-08 is a Sunday: index 0 matches the server's day numbering.
  return [...days]
    .sort((left, right) => ((left + 6) % 7) - ((right + 6) % 7))
    .map((day) => format.format(new Date(Date.UTC(2026, 10, 8 + day, 12))))
    .join(", ");
}

/** How the agent starts in this chat, in plain language. */
export function describeTriggers(
  agent: ChatAgent,
  t: TFunction,
  locale: string,
): string[] {
  const lines: string[] = [];
  const seen = new Set<string>();
  for (const trigger of agent.triggers) {
    let line: string;
    switch (trigger.type) {
      case "mention":
        line = t("acStartMention");
        break;
      case "command":
        line = t("acStartCommand", { command: trigger.command ?? "" });
        break;
      case "keyword":
        line = t("acStartKeyword");
        break;
      case "every_message":
        line = t("acStartEveryMessage");
        break;
      case "event":
        line = t("acStartEvent");
        break;
      case "schedule": {
        const schedule = trigger.schedule;
        if (!schedule) continue;
        const time = `${String(schedule.hour).padStart(2, "0")}:${String(schedule.minute).padStart(2, "0")}`;
        line =
          schedule.days_of_week.length === 0 || schedule.days_of_week.length === 7
            ? t("acStartScheduleDaily", { time })
            : t("acStartSchedule", { days: weekdays(schedule.days_of_week, locale), time });
        break;
      }
      default:
        continue;
    }
    if (seen.has(line)) continue;
    seen.add(line);
    lines.push(line);
  }
  return lines.length ? lines : [t("acStartNone")];
}
