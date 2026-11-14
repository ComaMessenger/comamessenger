import { hasPermission } from "./settings";
import type {
  CreateKnowledgeCollectionRequest,
  KnowledgeCollection,
  KnowledgeDocument,
  KnowledgeEmbeddingConnection,
  KnowledgeFragment,
  UpdateKnowledgeDocumentRequest,
  User,
} from "./types";

/*
 * Knowledge base logic shared by the web and mobile clients: document
 * formats, statuses, failure reasons, search highlighting, the fragment to
 * focus, paths, query keys and the collection and page forms.
 */

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

/** File picker filter matching documentFormat(): extensions, then MIME types. */
export const knowledgeDocumentExtensions = [
  ".txt",
  ".md",
  ".markdown",
  ".csv",
  ".xlsx",
  ".docx",
  ".pdf",
] as const;

export const knowledgeDocumentMIMETypes = [
  "text/plain",
  "text/markdown",
  "text/csv",
  "application/pdf",
  spreadsheetMIME,
  wordMIME,
] as const;

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

/** File name when the title differs from it, otherwise just its format. */
export function fileLabel(
  document: Pick<KnowledgeDocument, "title" | "file_name" | "file_mime">,
) {
  const name = document.file_name ?? "";
  if (name && name !== document.title) return name;
  const format = documentFormat(name, document.file_mime ?? "");
  if (format === "markdown") return "Markdown";
  if (format === "text") return "TXT";
  return format ? format.toUpperCase() : name;
}

/**
 * How the original file is shown: PDF as a document, text formats as plain
 * text (an uploaded HTML file never renders as a page), office files by the
 * platform viewer when it has one, otherwise saved or shared.
 */
export function sourceView(
  document: Pick<KnowledgeDocument, "file_name" | "file_mime">,
): "pdf" | "text" | "office" | "other" {
  const format = documentFormat(document.file_name ?? "", document.file_mime ?? "");
  if (format === "pdf") return "pdf";
  if (format === "text" || format === "markdown" || format === "csv") return "text";
  if (format === "docx" || format === "xlsx") return "office";
  return "other";
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

/** Highlighted parts of a focused fragment: the search query, else the quote. */
export function focusedParts(
  content: string,
  focus: { query?: string; quote?: string },
): Array<{ text: string; match: boolean }> {
  if (focus.query) return splitHighlight(content, focus.query);
  if (focus.quote) return splitQuote(content, focus.quote);
  return [{ text: content, match: false }];
}

/** One search result per document: the best-ranked fragment represents it. */
export function bestFragmentPerDocument(
  fragments: KnowledgeFragment[],
): KnowledgeFragment[] {
  return fragments.filter(
    (fragment, index, all) =>
      all.findIndex((other) => other.document_id === fragment.document_id) === index,
  );
}

/** Where the reader stands in the knowledge base and what to focus. */
export type KnowledgeFocus = {
  fragment?: string;
  position?: number;
  query?: string;
  quote?: string;
};

export type KnowledgeRoute = {
  collectionID?: string;
  documentID?: string;
};

/** `/knowledge`, `/knowledge/:collection`, `/knowledge/:collection/:document`. */
export function knowledgeFromPath(path: string): KnowledgeRoute | null {
  const match = /^\/knowledge(?:\/([^/]+))?(?:\/([^/]+))?\/?$/.exec(path);
  if (!match) return null;
  return {
    collectionID: match[1] ? decodeURIComponent(match[1]) : undefined,
    documentID: match[2] ? decodeURIComponent(match[2]) : undefined,
  };
}

// application/x-www-form-urlencoded, as URLSearchParams serializes it.
const formEncode = (value: string) =>
  encodeURIComponent(value)
    .replace(/[!'()~]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)
    .replace(/%20/g, "+");

/** Search parameters of a focused document, in a stable order. */
export function knowledgeFocusParams(focus?: KnowledgeFocus): Record<string, string> {
  const params: Record<string, string> = {};
  if (focus?.fragment) params.fragment = focus.fragment;
  if (focus?.position !== undefined) params.position = String(focus.position);
  if (focus?.query) params.q = focus.query;
  if (focus?.quote) params.quote = focus.quote;
  return params;
}

/** Reads the focus back from search parameters (web URL or mobile route). */
export function knowledgeFocusFrom(
  get: (name: string) => string | null | undefined,
): Required<Omit<KnowledgeFocus, "position">> & { position: number | null } {
  const position = get("position");
  const parsed = position ? Number(position) : NaN;
  return {
    fragment: get("fragment") ?? "",
    query: get("q") ?? "",
    quote: get("quote") ?? "",
    position: Number.isFinite(parsed) ? parsed : null,
  };
}

export function knowledgePath(
  collectionID?: string,
  documentID?: string,
  focus?: KnowledgeFocus,
) {
  let path = "/knowledge";
  if (collectionID) path += `/${encodeURIComponent(collectionID)}`;
  if (collectionID && documentID) path += `/${encodeURIComponent(documentID)}`;
  const search = Object.entries(knowledgeFocusParams(focus))
    .map(([name, value]) => `${name}=${formEncode(value)}`)
    .join("&");
  return search ? `${path}?${search}` : path;
}

/** Query keys shared by every screen that reads or changes the knowledge base. */
export const knowledgeCollectionsKey = ["knowledge", "collections"] as const;
export const knowledgeCollectionKey = (collectionID: string) =>
  ["knowledge", "collection", collectionID] as const;
export const knowledgeDocumentsKey = (collectionID: string) =>
  ["knowledge", "documents", collectionID] as const;
export const knowledgeDocumentKey = (documentID: string) =>
  ["knowledge", "document", documentID] as const;
export const knowledgeEmbeddingConnectionsKey = [
  "knowledge",
  "embedding-connections",
] as const;

/** Creating collections takes knowledge.manage; each collection says can_manage. */
export function canManageKnowledge(user: User) {
  return hasPermission(user, "knowledge.manage");
}

/** Who reads a collection, as the reader may know it. */
export function knowledgeAccessLabel(
  t: (key: string, options?: Record<string, unknown>) => string,
  collection: KnowledgeCollection,
) {
  if (collection.access === "organization") return t("kbAccessOrganization");
  return collection.can_manage
    ? t("kbAccessChats", { count: collection.chat_ids.length })
    : t("kbAccessChatsReader");
}

export type KnowledgeCollectionForm = {
  name: string;
  description: string;
  access: KnowledgeCollection["access"];
  chatIDs: string[];
  /** Empty means word search only. */
  connectionID: string;
};

export function knowledgeCollectionForm(
  collection?: KnowledgeCollection,
): KnowledgeCollectionForm {
  return {
    name: collection?.name ?? "",
    description: collection?.description ?? "",
    access: collection?.access ?? "organization",
    chatIDs: collection?.chat_ids ?? [],
    connectionID: collection?.embedding_connection_id ?? "",
  };
}

export function knowledgeCollectionValid(form: KnowledgeCollectionForm) {
  return (
    form.name.trim().length > 0 &&
    (form.access === "organization" || form.chatIDs.length > 0)
  );
}

/** The error to show when saving an invalid form; empty when the save button explains itself. */
export function knowledgeCollectionErrorKey(form: KnowledgeCollectionForm) {
  return form.access === "chats" && !form.chatIDs.length ? "kbChatsRequired" : "";
}

/** Create and update share one payload. */
export function knowledgeCollectionPayload(
  form: KnowledgeCollectionForm,
): CreateKnowledgeCollectionRequest {
  return {
    name: form.name.trim(),
    description: form.description.trim(),
    access: form.access,
    chat_ids: form.access === "chats" ? form.chatIDs : [],
    embedding_connection_id: form.connectionID || null,
  };
}

/** Changing the embedding connection of an existing collection rebuilds its index. */
export function knowledgeConnectionChanged(
  collection: KnowledgeCollection | undefined,
  form: KnowledgeCollectionForm,
) {
  return Boolean(collection) && (collection?.embedding_connection_id ?? "") !== form.connectionID;
}

/** The warning under the embedding choice: what happens to the text. */
export function embeddingNoticeKey(connection?: KnowledgeEmbeddingConnection) {
  if (!connection) return "kbEmbeddingNoneHint";
  if (!connection.enabled) return "kbEmbeddingDisabled";
  if (!connection.data_sharing_approved) return "kbEmbeddingNotApproved";
  return "kbEmbeddingWarning";
}

export function embeddingOptionKey(connection: KnowledgeEmbeddingConnection) {
  return connection.data_sharing_approved ? "kbEmbeddingOption" : "kbEmbeddingOptionBlocked";
}

export function knowledgePageValid(title: string, body: string) {
  return title.trim().length > 0 && body.trim().length > 0;
}

/** A changed body re-indexes the page, so it is sent only when it changed. */
export function knowledgePageUpdate(
  page: Pick<KnowledgeDocument, "body">,
  title: string,
  body: string,
): UpdateKnowledgeDocumentRequest {
  return { title: title.trim(), ...(body !== page.body ? { body } : {}) };
}

export type KnowledgeUploadState =
  | "uploading"
  | "adding"
  | "failed"
  | "cancelled"
  | "rejected";

/** Status line of a queued upload; a failure shows its own message instead. */
export function knowledgeUploadStatusKey(state: KnowledgeUploadState) {
  switch (state) {
    case "uploading":
      return "kbUploading";
    case "adding":
      return "kbUploadAdding";
    case "cancelled":
      return "kbUploadCancelled";
    case "rejected":
      return "kbUploadRejected";
    default:
      return "";
  }
}
