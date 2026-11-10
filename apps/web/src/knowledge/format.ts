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

const normalize = (value: string) =>
  value.replace(/[…]+$|\.{3}$/u, "").replace(/\s+/gu, " ").trim().toLocaleLowerCase();

/** The fragment an agent quoted: its excerpt is a (possibly cut) piece of it. */
export function findQuotedFragment(
  fragments: Array<{ chunk_id: string; content: string }>,
  quote: string,
): string {
  const needle = normalize(quote).slice(0, 120);
  if (needle.length < 8) return "";
  return fragments.find((fragment) => normalize(fragment.content).includes(needle))?.chunk_id ?? "";
}

/** Splits text around the quoted passage, if the text contains it verbatim. */
export function splitQuote(
  text: string,
  quote: string,
): Array<{ text: string; match: boolean }> {
  const needle = quote.replace(/[…]+$|\.{3}$/u, "").trim();
  const index = needle ? text.toLocaleLowerCase().indexOf(needle.toLocaleLowerCase()) : -1;
  if (index < 0) return [{ text, match: false }];
  return [
    { text: text.slice(0, index), match: false },
    { text: text.slice(index, index + needle.length), match: true },
    { text: text.slice(index + needle.length), match: false },
  ].filter((part) => part.text !== "");
}

/**
 * The fragment to show in focus: the exact fragment an agent source names;
 * after the document was indexed again, the fragment at the same position if
 * it still contains the quote; then a fragment containing the quote (messages
 * written before sources carried fragments); then the position alone.
 */
export function focusedFragment(
  fragments: Array<{ chunk_id: string; position: number; content: string }>,
  fragmentID: string,
  quote: string,
  position: number | null,
): string {
  if (fragmentID && fragments.some((fragment) => fragment.chunk_id === fragmentID))
    return fragmentID;
  const atPosition = position === null ? undefined : fragments.find((fragment) => fragment.position === position);
  if (quote) {
    const quoted = findQuotedFragment(fragments, quote);
    if (atPosition && quoted && findQuotedFragment([atPosition], quote)) return atPosition.chunk_id;
    if (quoted) return quoted;
  }
  return atPosition?.chunk_id ?? "";
}
