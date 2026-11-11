import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { failureReasonKey, scheduledFailureReasons } from "@comamessenger/core";
import { scheduledCatalog } from "./i18n";

// The push the server sends for a failed scheduled message uses the same
// words as the list; this keeps the two catalogs from drifting apart.
describe("failure reasons", () => {
  it("match the words of the server's push", () => {
    const source = readFileSync(
      resolve(process.cwd(), "../../core/internal/push/scheduled.go"),
      "utf8",
    );
    const server = new Map<string, [string, string]>();
    for (const match of source.matchAll(
      /^\s*"([a-z_]*)":\s*\{"([^"]+)",\s*"([^"]+)"\},$/gm,
    ))
      server.set(match[1]!, [match[2]!, match[3]!]);
    expect(server.size).toBe(scheduledFailureReasons.length + 1);
    const catalog = scheduledCatalog as {
      ru: Record<string, string>;
      en: Record<string, string>;
    };
    for (const reason of [...scheduledFailureReasons, ""]) {
      const key = failureReasonKey(reason || null);
      expect([catalog.ru[key], catalog.en[key]], reason).toEqual(
        server.get(reason),
      );
    }
  });
});
