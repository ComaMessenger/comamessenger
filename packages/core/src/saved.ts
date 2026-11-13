import type { DurableEvent, SavedMessage } from "./types";

/**
 * Saved messages («Важные») are the reader's own bookmarks: nobody else sees
 * them. Unlike chat pins they are not part of a message, so the feed stays
 * the same for every reader and the star comes from a separate list of ids.
 */
export const savedKeys = {
  /** Everything saved of one person: keys always carry the reader's id. */
  all: (userID: string) => ["saved", userID] as const,
  /** Pages of the «Important» screen; `null` is every chat. */
  list: (userID: string, chatID: string | null = null) =>
    ["saved", userID, "list", chatID] as const,
  /** Chats with saves and how many: the filter chips. */
  chats: (userID: string) => ["saved", userID, "chats"] as const,
  /** Ids of saved messages in one chat: the star in the feed. */
  ids: (userID: string, chatID: string) =>
    ["saved", userID, "ids", chatID] as const,
};

export type SavedChange = {
  messageID: string;
  chatID: string | null;
  saved: boolean;
};

/**
 * What a realtime event means for the reader's saves. `message.saved` and
 * `message.unsaved` reach only the reader's own devices; a deleted message
 * loses every save on the server, so it leaves the list too.
 */
export function savedChange(event: DurableEvent): SavedChange | null {
  const chatID =
    typeof event.data.chat_id === "string"
      ? event.data.chat_id
      : (event.chat_id ?? null);
  if (event.type === "message.saved" || event.type === "message.unsaved")
    return {
      messageID: event.subject_id,
      chatID,
      saved: event.type === "message.saved",
    };
  if (event.type === "message.deleted")
    return { messageID: event.subject_id, chatID, saved: false };
  return null;
}

/** The ids list after one message is saved or removed, for optimistic updates. */
export function withSaved(
  ids: readonly string[] | undefined,
  messageID: string,
  saved: boolean,
): string[] {
  const rest = (ids ?? []).filter((id) => id !== messageID);
  return saved ? [messageID, ...rest] : rest;
}

/** Where opening a saved message leads: its thread or the chat at it. */
export function savedMessageHref(item: SavedMessage): string {
  const root = item.message.thread_root_id;
  return root
    ? `/chat/${item.chat.id}/thread/${root}`
    : `/chat/${item.chat.id}?message=${item.message.id}`;
}

/** The part of a TanStack QueryClient the saved helpers need. */
export interface SavedQueryCache {
  setQueryData(
    queryKey: readonly unknown[],
    updater: (value: string[] | undefined) => string[] | undefined,
  ): unknown;
  invalidateQueries(filters: { queryKey: readonly unknown[] }): unknown;
}

/**
 * Brings cached saves up to date after a change made here or reported by
 * realtime: the star of the chat at once, the «Important» list on next view.
 */
export function applySavedChange(
  cache: SavedQueryCache,
  userID: string,
  change: SavedChange,
): void {
  if (change.chatID)
    cache.setQueryData(savedKeys.ids(userID, change.chatID), (ids) =>
      ids ? withSaved(ids, change.messageID, change.saved) : ids,
    );
  void cache.invalidateQueries({ queryKey: ["saved", userID, "list"] });
  void cache.invalidateQueries({ queryKey: savedKeys.chats(userID) });
}

/** What a client shows when the server refuses a save over the limit. */
export const savedLimitCode = "saved_limit_reached";

/** Both limits read the same to a person: remove saves you do not need. */
export function isSavedLimitError(error: unknown): boolean {
  const code =
    typeof error === "object" && error !== null
      ? (error as { code?: unknown }).code
      : undefined;
  return code === savedLimitCode || code === "saved_storage_full";
}
