import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  actionTools,
  agentBuilderSteps,
  draftProblems,
  emptyDraft,
  knowledgeSources,
  skills,
  triggerTypes,
  type ConfirmableAction,
} from "@comamessenger/core";
import { en } from "../../i18n/en";
import { ru } from "../../i18n/ru";

const roots = [
  join(__dirname, ".."),
  join(__dirname, "../../app/(app)/agents"),
];

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.tsx?$/.test(name) && !name.endsWith(".test.ts") ? [path] : [];
  });
}

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

describe("agent builder translations", () => {
  const keys = new Set(Object.keys(ru));

  it("has every key the builder and the Architect ask for", () => {
    const missing = roots
      .flatMap(sources)
      .flatMap((path) => literalKeys(readFileSync(path, "utf8")))
      // Values compared in conditions, not shown.
      .filter(
        (key) =>
          !["auto", "confirm", "both", "none", "daily_cost_limit"].includes(
            key,
          ),
      )
      .filter((key) => !keys.has(key));
    expect(missing).toEqual([]);
  });

  it("has the keys built from shared names", () => {
    const built = [
      ...knowledgeSources.flatMap((source) => [
        `agentSource_${source}`,
        `agentSourceHint_${source}`,
      ]),
      ...skills.flatMap((skill) => [
        `agentSkill_${skill}`,
        `agentSkillHint_${skill}`,
      ]),
      ...(Object.keys(actionTools) as ConfirmableAction[]).map(
        (action) => `agentAction_${action}`,
      ),
      ...triggerTypes.flatMap((type) => [
        `agentRuleType_${type}`,
        `agentRuleTypeHint_${type}`,
      ]),
      ...["both", "read", "write"].map((role) => `agentChatRole_${role}`),
      ...[0, 1, 2, 3, 4, 5, 6].flatMap((day) => [
        `agentWeekday_${day}`,
        `agentWeekdayShort_${day}`,
      ]),
      ...draftProblems({
        ...emptyDraft(),
        display_name: "",
        handle: "",
        daily_cost_limit: "x",
        description: "x".repeat(5000),
        max_output_tokens: 0,
      }).map((problem) => problem.key),
    ];
    expect(built.filter((key) => !keys.has(key))).toEqual([]);
    expect(agentBuilderSteps).toHaveLength(6);
  });

  it("speaks English with the same keys", () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(ru).sort());
  });
});
