import type { KnowledgeCollection } from "@comamessenger/core";

export const collectionsKey = ["knowledge", "collections"] as const;
export const collectionKey = (collectionID: string) =>
  ["knowledge", "collection", collectionID] as const;
export const documentsKey = (collectionID: string) =>
  ["knowledge", "documents", collectionID] as const;
export const documentKey = (documentID: string) =>
  ["knowledge", "document", documentID] as const;

export function accessLabel(
  t: (key: string, options?: Record<string, unknown>) => string,
  collection: KnowledgeCollection,
) {
  if (collection.access === "organization") return t("kbAccessOrganization");
  return collection.can_manage
    ? t("kbAccessChats", { count: collection.chat_ids.length })
    : t("kbAccessChatsReader");
}
