import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { en } from "../i18n/en";
import { ru } from "../i18n/ru";

const dir = __dirname;

/** Every string literal inside a `t(...)` call, ternary branches included. */
function literalKeys(source: string): string[] {
  const keys: string[] = [];
  for (const match of source.matchAll(/\bt\(/g)) {
    let depth = 0;
    let end = match.index! + 1;
    for (; end < source.length; end++) {
      if (source[end] === "(") depth++;
      else if (source[end] === ")" && --depth === 0) break;
    }
    const call = source.slice(match.index! + 2, end);
    for (const literal of call.matchAll(/"([a-zA-Z][A-Za-z0-9_]+)"/g))
      keys.push(literal[1]!);
  }
  return keys;
}

/*
 * Keys Core builds from server values (`agentStatus_${kind}` and the like):
 * every value the clients know must have a text on the phone too.
 */
const families: Record<string, readonly string[]> = {
  agentStatus_: ["approval", "attention", "paused", "draft", "working"],
  agentRunStatus_: [
    "queued",
    "running",
    "completed",
    "failed",
    "canceled",
    "timed_out",
  ],
  agentOutcome_: ["all", "failed", "working"],
  agentFeedDone_: [
    "mention",
    "command",
    "keyword",
    "every_message",
    "schedule",
    "event",
    "message_action",
    "collection",
    "followup",
    "webhook",
    "confirmation",
    "check",
    "manual",
  ],
  acWhy_: [
    "mention",
    "command",
    "keyword",
    "every_message",
    "schedule",
    "event",
    "message_action",
    "collection",
    "followup",
    "webhook",
    "confirmation",
    "manual",
  ],
  agentRunError_: [
    "provider_credential_missing",
    "budget_exceeded",
    "run_timeout",
    "run_canceled",
    "unknown",
  ],
  agentStep_: ["get_chat_messages", "search_knowledge", "post_message"],
  agentStepWould_: ["post_message", "post_card", "send_direct_message"],
  agentExample_custom_: ["1", "2", "3"],
};

describe("agent section translations", () => {
  it("has every key the screens ask for, in both languages", () => {
    const keys = readdirSync(dir)
      .filter((name) => /\.tsx?$/.test(name) && !name.endsWith(".test.ts"))
      .flatMap((name) => literalKeys(readFileSync(join(dir, name), "utf8")));
    const missing = [...new Set(keys)].filter((key) => !(key in ru));
    expect(missing).toEqual([]);
  });

  it("has the texts Core builds from server values", () => {
    const missing = Object.entries(families).flatMap(([prefix, values]) =>
      values.map((value) => prefix + value).filter((key) => !(key in ru)),
    );
    expect(missing).toEqual([]);
  });

  it("keeps the same placeholders in Russian and English", () => {
    const placeholders = (text: string) =>
      [...text.matchAll(/\{(\w+)(?=[,}])/g)].map((match) => match[1]).sort();
    const differ = Object.keys(ru)
      .filter((key) => key.startsWith("agent") || key === "tabAgents")
      .filter(
        (key) =>
          JSON.stringify(placeholders(ru[key as keyof typeof ru])) !==
          JSON.stringify(placeholders(en[key as keyof typeof en])),
      );
    expect(differ).toEqual([]);
  });
});
