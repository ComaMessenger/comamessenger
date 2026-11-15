import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  awayPresenceFilterLabelKeys,
  composerMenu,
  customStatusExpiryLabelKeys,
  customStatusPresets,
  pollDuePresetLabelKeys,
  waitingFilterLabelKeys,
} from "@comamessenger/core";
import { ru } from "../i18n/ru";
import { en } from "../i18n/en";
import { pollsEn, pollsRu } from "./i18n";
import { statusEn, statusRu } from "../status/i18n";

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

const sources = (dir: string) =>
  readdirSync(dir)
    .filter((name) => /\.tsx?$/.test(name) && !name.endsWith(".test.ts"))
    .map((name) => readFileSync(join(dir, name), "utf8"));

describe("poll and status translations", () => {
  it("has both languages for every key of the wave", () => {
    expect(Object.keys(pollsEn).sort()).toEqual(Object.keys(pollsRu).sort());
    expect(Object.keys(statusEn).sort()).toEqual(Object.keys(statusRu).sort());
    for (const key of [...Object.keys(pollsRu), ...Object.keys(statusRu)]) {
      expect(ru[key as keyof typeof ru], key).toBeTruthy();
      expect(en[key as keyof typeof en], key).toBeTruthy();
    }
  });

  it("has every key the poll and status screens ask for", () => {
    const keys = new Set(Object.keys(ru));
    const missing = [
      ...sources(__dirname),
      ...sources(join(__dirname, "../status")),
    ]
      .flatMap(literalKeys)
      // Values compared in conditions inside t(...).
      .filter((key) => !["away", "beforeStart", "empty", "past"].includes(key))
      .filter((key) => !keys.has(key));
    expect(missing).toEqual([]);
  });

  it("has the keys packages/core hands out", () => {
    const keys = new Set(Object.keys(ru));
    const shared = [
      ...Object.values(pollDuePresetLabelKeys),
      ...Object.values(awayPresenceFilterLabelKeys),
      ...Object.values(customStatusExpiryLabelKeys),
      ...customStatusPresets.flatMap((preset) => [
        preset.labelKey,
        preset.durationKey,
      ]),
      waitingFilterLabelKeys.polls,
      ...composerMenu({
        platform: "mobile",
        readonly: false,
        hasAgents: true,
        features: ["message_requests", "message_polls"],
        inThread: false,
      }).flatMap((group) =>
        group.items.flatMap((item) => [item.labelKey, item.hintKey ?? ""]),
      ),
    ].filter(Boolean);
    expect(shared.filter((key) => !keys.has(key))).toEqual([]);
  });
});
