import type { KnowledgeDocument } from "@comamessenger/core";

export type DocumentFormat =
  | "csv"
  | "markdown"
  | "xlsx"
  | "docx"
  | "pdf"
  | "text"
  | "";

const spreadsheetMIME =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const wordMIME =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

/** Mirrors files.DocumentKind on the server: what the indexer can read. */
export function documentFormat(name: string, mime: string): DocumentFormat {
  const dot = name.lastIndexOf(".");
  const extension = dot >= 0 ? name.slice(dot).toLowerCase() : "";
  const type = mime.trim().toLowerCase();
  if (extension === ".csv" || type === "text/csv") return "csv";
  if (extension === ".md" || extension === ".markdown" || type === "text/markdown")
    return "markdown";
  if (extension === ".xlsx" || type === spreadsheetMIME) return "xlsx";
  if (extension === ".docx" || type === wordMIME) return "docx";
  if (extension === ".pdf" || type === "application/pdf") return "pdf";
  if (type.startsWith("text/") || extension === ".txt") return "text";
  return "";
}

/** File picker filter matching documentFormat(). */
export const acceptedDocuments = [
  ".txt",
  ".md",
  ".markdown",
  ".csv",
  ".xlsx",
  ".docx",
  ".pdf",
  "text/plain",
  "text/markdown",
  "text/csv",
  "application/pdf",
  spreadsheetMIME,
  wordMIME,
].join(",");

/** Translation key explaining why indexing failed, in the reader's words. */
export function failureKey(
  document: Pick<KnowledgeDocument, "error_code" | "file_name" | "file_mime">,
): string {
  switch (document.error_code) {
    case "unsupported_format":
      return "kbErrorUnsupported";
    case "file_unavailable":
      return "kbErrorFileUnavailable";
    case "no_text_extracted":
      return documentFormat(document.file_name ?? "", document.file_mime ?? "") ===
        "pdf"
        ? "kbErrorNoTextPdf"
        : "kbErrorNoText";
    case "empty_document":
      return "kbErrorEmpty";
    case "indexing_failed":
      return "kbErrorIndexing";
    default:
      return "kbErrorUnknown";
  }
}

export function statusKey(status: KnowledgeDocument["status"]): string {
  return status === "pending"
    ? "kbStatusPending"
    : status === "processing"
      ? "kbStatusProcessing"
      : status === "ready"
        ? "kbStatusReady"
        : "kbStatusFailed";
}

export function isProcessing(document: Pick<KnowledgeDocument, "status">) {
  return document.status === "pending" || document.status === "processing";
}

/**
 * Search terms of a query as case-insensitive stems. Full-text search matches
 * word forms (vacation → vacations), so each word keeps its first letters only.
 */
export function highlightTerms(query: string): string[] {
  const words = query
    .toLocaleLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word.length >= 3);
  const stems = words.map((word) =>
    word.length > 5 ? word.slice(0, Math.max(4, word.length - 2)) : word,
  );
  return [...new Set(stems)].sort((left, right) => right.length - left.length);
}

/** Splits text into plain and matching words for highlighting. */
export function splitHighlight(
  text: string,
  query: string,
): Array<{ text: string; match: boolean }> {
  const terms = highlightTerms(query);
  if (!terms.length || !text) return [{ text, match: false }];
  const pattern = new RegExp(
    `((?:${terms.map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})[\\p{L}\\p{N}]*)`,
    "giu",
  );
  return text
    .split(pattern)
    .filter((part) => part !== "")
    .map((part) => {
      const lower = part.toLocaleLowerCase();
      return { text: part, match: terms.some((term) => lower.startsWith(term)) };
    });
}
