import { describe, expect, it } from "vitest";
import {
  documentFormat,
  failureKey,
  highlightTerms,
  findQuotedFragment,
  focusedFragment,
  splitHighlight,
  splitQuote,
  statusKey,
  knowledgeFromPath,
  knowledgePath,
  knowledgeFocusFrom,
  knowledgeCollectionForm,
  knowledgeCollectionValid,
  knowledgeCollectionErrorKey,
  knowledgeCollectionPayload,
  knowledgePageUpdate,
  knowledgePageValid,
  sourceView,
  fileLabel,
  bestFragmentPerDocument,
  embeddingNoticeKey,
} from "./knowledge";
import { relativeAge } from "./chats";
import type { KnowledgeEmbeddingConnection, KnowledgeFragment } from "./types";

describe("knowledge formats", () => {
  it("mirrors the server document kinds", () => {
    expect(documentFormat("Регламент.PDF", "")).toBe("pdf");
    expect(documentFormat("rules.md", "application/octet-stream")).toBe("markdown");
    expect(documentFormat("slots", "text/csv")).toBe("csv");
    expect(documentFormat("table.xlsx", "")).toBe("xlsx");
    expect(documentFormat("memo.docx", "")).toBe("docx");
    expect(documentFormat("notes", "text/plain")).toBe("text");
    expect(documentFormat("photo.jpg", "image/jpeg")).toBe("");
    expect(documentFormat("old.doc", "application/msword")).toBe("");
  });

  it("explains a PDF without a text layer separately", () => {
    expect(
      failureKey({ error_code: "no_text_extracted", file_name: "scan.pdf", file_mime: "application/pdf" }),
    ).toBe("kbErrorNoTextPdf");
    expect(
      failureKey({ error_code: "no_text_extracted", file_name: "empty.txt", file_mime: "text/plain" }),
    ).toBe("kbErrorNoText");
    expect(failureKey({ error_code: "unsupported_format", file_name: null, file_mime: null })).toBe(
      "kbErrorUnsupported",
    );
    expect(failureKey({ error_code: "something_new", file_name: null, file_mime: null })).toBe(
      "kbErrorUnknown",
    );
    expect(statusKey("processing")).toBe("kbStatusProcessing");
  });
});

describe("knowledge highlighting", () => {
  it("matches word forms of the query", () => {
    expect(highlightTerms("заявление на отпуск")).toEqual(["заявлен", "отпу"]);
    const parts = splitHighlight("Заявление на отпуска подаётся заранее", "заявление отпуск");
    expect(parts.filter((part) => part.match).map((part) => part.text)).toEqual([
      "Заявление",
      "отпуска",
    ]);
    expect(parts.map((part) => part.text).join("")).toBe("Заявление на отпуска подаётся заранее");
  });

  it("leaves text untouched without usable terms", () => {
    expect(splitHighlight("Пропуск", "на")).toEqual([{ text: "Пропуск", match: false }]);
    expect(splitHighlight("a+b (c)", "(c)+")).toEqual([{ text: "a+b (c)", match: false }]);
  });
});

describe("knowledge routes", () => {
  it("parses and builds paths", () => {
    expect(knowledgeFromPath("/knowledge")).toEqual({ collectionID: undefined, documentID: undefined });
    expect(knowledgeFromPath("/knowledge/c1/d1")).toEqual({ collectionID: "c1", documentID: "d1" });
    expect(knowledgeFromPath("/knowledgebase")).toBeNull();
    expect(knowledgeFromPath("/knowledge/c1/d1/extra")).toBeNull();
    expect(knowledgePath("c1", "d1", { fragment: "f1", query: "отпуск" })).toBe(
      "/knowledge/c1/d1?fragment=f1&q=%D0%BE%D1%82%D0%BF%D1%83%D1%81%D0%BA",
    );
    expect(knowledgePath()).toBe("/knowledge");
  });
});

describe("agent quotes", () => {
  const fragments = [
    { chunk_id: "a", content: "Общие положения." },
    { chunk_id: "b", content: "Заболевший инструктор сообщает дежурному\nадминистратору до 08:00. Замену подбирает он." },
  ];
  it("finds the cited fragment despite line breaks and a cut excerpt", () => {
    expect(findQuotedFragment(fragments, "Заболевший инструктор сообщает дежурному администратору…")).toBe("b");
    expect(findQuotedFragment(fragments, "Нет такого текста в документе")).toBe("");
    expect(findQuotedFragment(fragments, "до")).toBe("");
  });
  it("marks the quoted passage when it is verbatim", () => {
    expect(splitQuote("Пропуск выдаёт администратор.", "выдаёт администратор…")).toEqual([
      { text: "Пропуск ", match: false },
      { text: "выдаёт администратор", match: true },
      { text: ".", match: false },
    ]);
    expect(splitQuote("Текст", "другое")).toEqual([{ text: "Текст", match: false }]);
  });
});

describe("focusedFragment", () => {
  const fragments = [
    { chunk_id: "a", position: 0, content: "Ключи от зала передаются следующему инструктору." },
    { chunk_id: "b", position: 1, content: "Заболевший инструктор сообщает дежурному администратору до 8:00." },
  ];
  it("prefers the exact fragment of the source", () => {
    expect(focusedFragment(fragments, "a", "Заболевший инструктор сообщает", 1)).toBe("a");
  });
  it("falls back to the position, then to the quote, after a new indexing", () => {
    expect(focusedFragment(fragments, "gone", "", 1)).toBe("b");
    expect(focusedFragment(fragments, "gone", "Ключи от зала передаются", 1)).toBe("a");
  });
  it("keeps the quote search for old messages", () => {
    expect(focusedFragment(fragments, "", "Заболевший инструктор сообщает", null)).toBe("b");
    expect(focusedFragment(fragments, "", "", null)).toBe("");
  });
});

describe("shared knowledge helpers", () => {
  it("encodes focus like URLSearchParams and reads it back", () => {
    const path = knowledgePath("c1", "d1", { query: "отпуск (летний) 2", position: 0, quote: "a'b" });
    const search = new URLSearchParams({ position: "0", q: "отпуск (летний) 2", quote: "a'b" });
    expect(path).toBe(`/knowledge/c1/d1?${search}`);
    const parsed = new URLSearchParams(path.split("?")[1]);
    expect(knowledgeFocusFrom((name) => parsed.get(name))).toEqual({
      fragment: "",
      query: "отпуск (летний) 2",
      quote: "a'b",
      position: 0,
    });
    expect(knowledgeFocusFrom(() => undefined).position).toBeNull();
  });

  it("builds the collection payload and validates chats", () => {
    const form = knowledgeCollectionForm();
    expect(knowledgeCollectionValid(form)).toBe(false);
    const chats = { ...form, name: " Регламенты ", access: "chats" as const, connectionID: "" };
    expect(knowledgeCollectionValid(chats)).toBe(false);
    expect(knowledgeCollectionErrorKey(chats)).toBe("kbChatsRequired");
    expect(knowledgeCollectionPayload({ ...chats, chatIDs: ["x"] })).toEqual({
      name: "Регламенты",
      description: "",
      access: "chats",
      chat_ids: ["x"],
      embedding_connection_id: null,
    });
    expect(knowledgeCollectionPayload({ ...chats, access: "organization", chatIDs: ["x"] }).chat_ids).toEqual([]);
  });

  it("sends a page body only when it changed", () => {
    expect(knowledgePageUpdate({ body: "a" }, " T ", "a")).toEqual({ title: "T" });
    expect(knowledgePageUpdate({ body: "a" }, "T", "b")).toEqual({ title: "T", body: "b" });
    expect(knowledgePageValid("T", "  ")).toBe(false);
  });

  it("picks the viewer and the file label", () => {
    expect(sourceView({ file_name: "a.pdf", file_mime: null })).toBe("pdf");
    expect(sourceView({ file_name: "a.csv", file_mime: null })).toBe("text");
    expect(sourceView({ file_name: "a.docx", file_mime: null })).toBe("office");
    expect(sourceView({ file_name: "a.bin", file_mime: null })).toBe("other");
    expect(fileLabel({ title: "a.md", file_name: "a.md", file_mime: "" })).toBe("Markdown");
    expect(fileLabel({ title: "Правила", file_name: "rules.pdf", file_mime: "" })).toBe("rules.pdf");
  });

  it("keeps the best fragment of each document", () => {
    const fragment = (chunk_id: string, document_id: string) =>
      ({ chunk_id, document_id }) as KnowledgeFragment;
    expect(
      bestFragmentPerDocument([fragment("1", "a"), fragment("2", "b"), fragment("3", "a")]).map(
        (item) => item.chunk_id,
      ),
    ).toEqual(["1", "2"]);
  });

  it("explains the embedding choice", () => {
    const connection = { enabled: true, data_sharing_approved: true } as KnowledgeEmbeddingConnection;
    expect(embeddingNoticeKey()).toBe("kbEmbeddingNoneHint");
    expect(embeddingNoticeKey({ ...connection, enabled: false })).toBe("kbEmbeddingDisabled");
    expect(embeddingNoticeKey({ ...connection, data_sharing_approved: false })).toBe("kbEmbeddingNotApproved");
    expect(embeddingNoticeKey(connection)).toBe("kbEmbeddingWarning");
  });

  it("buckets ages", () => {
    const now = new Date("2026-11-14T12:00:00");
    expect(relativeAge("2026-11-14T11:59:50", now)).toEqual({ unit: "now" });
    expect(relativeAge("2026-11-14T11:30:00", now)).toEqual({ unit: "minutes", count: 30 });
    expect(relativeAge("2026-11-14T09:00:00", now)).toEqual({ unit: "hours", count: 3 });
    expect(relativeAge("2026-11-13T09:00:00", now)).toEqual({ unit: "date" });
  });
});
