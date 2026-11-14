import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  apiErrorKey,
  fieldErrorKey,
  permissionLabelKeys,
  roleLabelKey,
  type FieldError,
} from "@comamessenger/core";
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

describe("settings translations", () => {
  const keys = new Set(Object.keys(ru));

  it("has every key the settings screens ask for", () => {
    const missing = readdirSync(dir)
      .filter((name) => /\.tsx?$/.test(name) && !name.endsWith(".test.ts"))
      .flatMap((name) => literalKeys(readFileSync(join(dir, name), "utf8")))
      // Values compared in conditions and fieldErrorKey() arguments.
      .filter(
        (key) =>
          ![
            "all",
            "expired",
            "logo",
            "passwordTooShort",
            "passwordUnchanged",
          ].includes(key),
      )
      .filter((key) => !keys.has(key));
    expect(missing).toEqual([]);
  });

  it("has the keys packages/core hands out", () => {
    const shared = [
      ...Object.values(permissionLabelKeys),
      ...["owner", "admin", "member"].map(roleLabelKey),
      ...(
        [
          "required",
          "tooLong",
          "slug",
          "ttl",
          "hexColor",
          "port",
          "email",
          "passwordTooShort",
          "passwordsDoNotMatch",
          "passwordUnchanged",
        ] satisfies FieldError[]
      ).map(fieldErrorKey),
      apiErrorKey(new Error("offline")) ?? "errorNetwork",
    ];
    expect(shared.filter((key) => !keys.has(key))).toEqual([]);
  });
});
