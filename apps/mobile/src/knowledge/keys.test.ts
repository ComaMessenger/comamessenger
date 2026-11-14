import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  embeddingNoticeKey,
  embeddingOptionKey,
  failureKey,
  knowledgeAccessLabel,
  knowledgeCollectionErrorKey,
  knowledgeCollectionForm,
  knowledgeUploadStatusKey,
  statusKey,
  type KnowledgeCollection,
  type KnowledgeEmbeddingConnection,
} from "@comamessenger/core";
import { en } from "../i18n/en";
import { ru } from "../i18n/ru";

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

describe("knowledge translations", () => {
  it("has every key the knowledge screens ask for", () => {
    const missing = readdirSync(__dirname)
      .filter((name) => /\.tsx?$/.test(name) && !name.endsWith(".test.ts"))
      .flatMap((name) => literalKeys(readFileSync(join(__dirname, name), "utf8")))
      .filter((key) => !["page", "chats", "pending", "failed", "text"].includes(key))
      .filter((key) => !keys.has(key));
    expect(missing).toEqual([]);
  });

  it("has the keys packages/core hands out", () => {
    const connection = {
      enabled: true,
      data_sharing_approved: true,
    } as KnowledgeEmbeddingConnection;
    const t = (key: string) => key;
    const shared = [
      ...(["pending", "processing", "ready", "failed"] as const).map(statusKey),
      ...[
        "unsupported_format",
        "file_unavailable",
        "no_text_extracted",
        "empty_document",
        "indexing_failed",
        "unknown",
      ].flatMap((error_code) => [
        failureKey({ error_code, file_name: "a.pdf", file_mime: "" }),
        failureKey({ error_code, file_name: "a.txt", file_mime: "" }),
      ]),
      embeddingNoticeKey(),
      embeddingNoticeKey({ ...connection, enabled: false }),
      embeddingNoticeKey({ ...connection, data_sharing_approved: false }),
      embeddingNoticeKey(connection),
      embeddingOptionKey(connection),
      embeddingOptionKey({ ...connection, data_sharing_approved: false }),
      knowledgeCollectionErrorKey({
        ...knowledgeCollectionForm(),
        access: "chats",
      }),
      ...(["uploading", "adding", "cancelled", "rejected"] as const).map(
        knowledgeUploadStatusKey,
      ),
      ...(["organization", "chats"] as const).flatMap((access) =>
        [true, false].map((can_manage) =>
          knowledgeAccessLabel(t, {
            access,
            can_manage,
            chat_ids: [],
          } as unknown as KnowledgeCollection),
        ),
      ),
    ];
    expect(shared.filter((key) => !keys.has(key))).toEqual([]);
  });

  it("keeps ICU placeholders the same in both languages", () => {
    const names = (text: string) =>
      [...text.matchAll(/\{(\w+)[,}]/g)].map((match) => match[1]).sort();
    const differing = Object.keys(ru)
      .filter((key) => key.startsWith("kb"))
      .filter(
        (key) =>
          JSON.stringify(names(ru[key as keyof typeof ru])) !==
          JSON.stringify(names(en[key as keyof typeof en])),
      );
    expect(differing).toEqual([]);
  });
});
