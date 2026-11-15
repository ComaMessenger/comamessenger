import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import i18next from "i18next";
import ICU from "i18next-icu";
import { beforeAll, describe, expect, it } from "vitest";
import { permissionLabelKeys } from "@comamessenger/core";
import { en } from "../i18n/en";
import { ru } from "../i18n/ru";
import { orgEn, orgRu } from "./i18n";

const keys = new Set(Object.keys(ru));

/** Every string literal inside a `t(...)` call, ternary branches included. */
function literalKeys(source: string): string[] {
  const found: string[] = [];
  for (const match of source.matchAll(/\bt\(/g)) {
    let depth = 0;
    let end = match.index! + 1;
    for (; end < source.length; end++) {
      if (source[end] === "(") depth++;
      else if (source[end] === ")" && --depth === 0) break;
    }
    const call = source.slice(match.index! + 2, end);
    for (const literal of call.matchAll(/"([a-zA-Z][A-Za-z0-9_]+)"/g))
      found.push(literal[1]!);
  }
  return found;
}

const sources = [
  ...readdirSync(__dirname)
    .filter((name) => /\.tsx?$/.test(name) && !name.endsWith(".test.ts"))
    .map((name) => join(__dirname, name)),
  // Screens of other modules the org structure touched.
  join(__dirname, "../people/PeopleScreen.tsx"),
  join(__dirname, "../people/PersonScreen.tsx"),
  join(__dirname, "../settings/MembersScreens.tsx"),
  join(__dirname, "../conversation/Composer.tsx"),
];

const russian = i18next.createInstance();
beforeAll(async () => {
  await russian.use(ICU).init({
    lng: "ru",
    initAsync: false,
    interpolation: { escapeValue: false },
    resources: { ru: { translation: ru } },
  });
});

describe("org structure translations", () => {
  it("has every key the org screens ask for", () => {
    const missing = sources
      .flatMap((path) => literalKeys(readFileSync(path, "utf8")))
      // Values compared inside a t(...) call, not keys.
      .filter((key) => !["lead", "user"].includes(key))
      .filter((key) => !keys.has(key));
    expect(missing).toEqual([]);
  });

  it("has the labels of every permission", () => {
    expect(
      Object.values(permissionLabelKeys).filter((key) => !keys.has(key)),
    ).toEqual([]);
  });

  it("spreads into both languages", () => {
    for (const key of Object.keys(orgRu)) {
      expect(ru[key as keyof typeof ru]).toBe(orgRu[key as keyof typeof orgRu]);
      expect(en[key as keyof typeof en]).toBe(orgEn[key as keyof typeof orgEn]);
    }
  });

  it("keeps ICU placeholders the same in both languages", () => {
    const names = (text: string) =>
      [...text.matchAll(/\{([a-z]\w*)[,}]/g)].map((match) => match[1]).sort();
    for (const key of Object.keys(orgRu) as (keyof typeof orgRu)[])
      expect(names(orgRu[key]), key).toEqual(names(orgEn[key]));
  });

  it("words Russian counts", () => {
    const format = (key: keyof typeof orgRu, count: number) =>
      russian.t(key, { count });
    expect(format("orgEmployees", 1)).toBe("1 сотрудник");
    expect(format("orgEmployees", 3)).toBe("3 сотрудника");
    expect(format("orgEmployees", 11)).toBe("11 сотрудников");
    expect(format("orgMentionInChat", 5)).toBe(
      "5 человек из отдела в этом чате",
    );
    expect(format("orgMissing", 3)).toBe("В чате нет 3 сотрудников отдела");
    expect(format("orgMissing", 1)).toBe("В чате нет 1 сотрудника отдела");
  });
});
