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
} from "./format";
import { knowledgeFromPath, knowledgePath } from "./routes";

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
