import {
  isSavedLimitError,
  type Chat,
  type MessengerAPI,
  type SavedMessage,
  type SavedMessagePage,
} from "@comamessenger/core";

/** A saved message as the screen shows it, with the chat from the list if known. */
export type ImportantItem = SavedMessage & { localChat?: Chat };

/**
 * One page of the person's saved messages: a single request that already
 * carries the message, author and chat. The old screen asked for pins chat
 * by chat and then for each message with `context?limit=1`, which the server
 * rejects (the minimum is 3) — one pin was enough to fail the whole screen.
 */
export function fetchSavedPage(
  api: Pick<MessengerAPI, "savedMessages">,
  chatID: string | null,
  cursor?: string,
): Promise<SavedMessagePage> {
  return api.savedMessages({ chatID: chatID ?? undefined, cursor });
}

export function nextSavedPage(page: SavedMessagePage): string | undefined {
  return page.next_cursor ?? undefined;
}

/** Cards in order, each with the chat from the chat list when it is there. */
export function importantItems(
  pages: readonly SavedMessagePage[] | undefined,
  chats: Record<string, Chat>,
): ImportantItem[] {
  return (pages ?? []).flatMap((page) =>
    page.items.map((item) => ({ ...item, localChat: chats[item.chat.id] })),
  );
}

/** The message shown when a save fails: the limit explains what to do. */
export function saveFailureKey(error: unknown): string {
  return isSavedLimitError(error) ? "savedLimitReached" : "actionFailed";
}
