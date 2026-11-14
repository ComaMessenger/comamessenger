import {
  knowledgeDocumentExtensions,
  knowledgeDocumentMIMETypes,
} from "@comamessenger/core";

export {
  documentFormat,
  failureKey,
  findQuotedFragment,
  focusedFragment,
  highlightTerms,
  isProcessing,
  splitHighlight,
  splitQuote,
  statusKey,
  type DocumentFormat,
} from "@comamessenger/core";

/** File picker filter matching documentFormat(). */
export const acceptedDocuments = [
  ...knowledgeDocumentExtensions,
  ...knowledgeDocumentMIMETypes,
].join(",");
