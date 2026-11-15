import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  myTaskGroupLabelKeys,
  taskDuePresetLabelKeys,
  taskInboxModeLabelKeys,
  waitingFilterLabelKeys,
} from "@comamessenger/core";
import { ru } from "../i18n/ru";
import { en } from "../i18n/en";
import { tasksEn, tasksRu } from "./i18n";

// The parser i18next-icu formats with at runtime (not a direct dependency).
const icu = createRequire(createRequire(__filename).resolve("i18next-icu"));
const IntlMessageFormat = (
  icu("intl-messageformat") as {
    default: new (
      message: string,
      locale: string,
    ) => { format(values: Record<string, unknown>): unknown };
  }
).default;

const values = [
  "person",
  "department",
  "position",
  "message_deleted",
  "open",
  "in_progress",
  "done",
  "canceled",
];

const files = [
  "tasks/TaskCard.tsx",
  "tasks/TaskSheet.tsx",
  "tasks/TaskScreen.tsx",
  "tasks/TaskRow.tsx",
  "tasks/ChatTasksDrop.tsx",
  "tasks/ChatTasksScreen.tsx",
  "tasks/fields.tsx",
  "tasks/format.ts",
  "conversation/ChatSlot.tsx",
  "important/WaitingWithTasks.tsx",
  "chats/ChatRow.tsx",
];

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

describe("task translations", () => {
  it("has every key the task screens ask for, in both languages", () => {
    const missing = files
      .flatMap((file) =>
        literalKeys(readFileSync(join(__dirname, "..", file), "utf8")),
      )
      // Values compared in conditions, not keys.
      .filter((key) => !values.includes(key))
      .filter((key) => !(key in ru) || !(key in en));
    expect(missing).toEqual([]);
  });

  it("has the keys packages/core hands out", () => {
    const shared = [
      "composerTask",
      "composerTaskHint",
      "messageMakeTask",
      ...Object.values(taskDuePresetLabelKeys),
      ...Object.values(myTaskGroupLabelKeys),
      ...Object.values(waitingFilterLabelKeys),
      ...Object.values(taskInboxModeLabelKeys),
    ];
    expect(shared.filter((key) => !(key in ru) || !(key in en))).toEqual([]);
  });

  it("parses every string as ICU with the same placeholders", () => {
    const names = (text: string) =>
      [...text.matchAll(/\{(\w+)\s*[,}]/g)].map((match) => match[1]).sort();
    for (const [key, text] of Object.entries(tasksRu)) {
      const other = tasksEn[key as keyof typeof tasksRu];
      expect(() => new IntlMessageFormat(text, "ru")).not.toThrow();
      expect(() => new IntlMessageFormat(other, "en")).not.toThrow();
      expect([key, ...new Set(names(other))]).toEqual([
        key,
        ...new Set(names(text)),
      ]);
    }
  });

  it("formats the plural strings", () => {
    const queue = new IntlMessageFormat(tasksRu.taskQueueWho, "ru");
    expect(queue.format({ count: 0 })).toBe("В этом чате нет никого из них");
    expect(queue.format({ count: 3 })).toBe(
      "Увидят 3 человека в этом чате, возьмёт первый",
    );
    expect(
      new IntlMessageFormat(tasksRu.taskGroupInChat, "ru").format({ count: 5 }),
    ).toBe("5 человек в этом чате");
  });
});
