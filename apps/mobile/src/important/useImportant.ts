import { useMemo } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { useStore } from "zustand";
import {
  savedChatFilters,
  savedKeys,
  type Chat,
  type SavedMessage,
} from "@comamessenger/core";
import { useMessenger } from "@/messenger/MessengerProvider";
import { useSignedIn } from "@/session/SessionProvider";

/** A saved message as the screen shows it, with the chat from the list if known. */
export type ImportantItem = SavedMessage & { localChat?: Chat };

function useSavedPages(chatID: string | null, enabled = true) {
  const { api } = useSignedIn();
  return useInfiniteQuery({
    queryKey: savedKeys.list(chatID),
    enabled,
    initialPageParam: undefined as number | undefined,
    queryFn: ({ pageParam }) =>
      api.savedMessages({ chatID: chatID ?? undefined, before: pageParam }),
    getNextPageParam: (page) => page.next_before ?? undefined,
  });
}

/**
 * The person's own saved messages («Важные»), newest save first — the same
 * source as the web. Nobody else sees them. A chat filter asks the server
 * for that chat only, so older saves of the chat are not missed.
 */
export function useImportant(chatFilter: string | null) {
  const { store } = useMessenger();
  const chatMap = useStore(store, (state) => state.chats);
  const all = useSavedPages(null);
  const filtered = useSavedPages(chatFilter, chatFilter !== null);
  const query = chatFilter ? filtered : all;
  const allItems = useMemo(
    () => all.data?.pages.flatMap((page) => page.items) ?? [],
    [all.data],
  );
  const items = useMemo<ImportantItem[]>(
    () =>
      (query.data?.pages.flatMap((page) => page.items) ?? []).map((item) => ({
        ...item,
        localChat: chatMap[item.chat.id],
      })),
    [query.data, chatMap],
  );
  const groups = useMemo(() => savedChatFilters(allItems), [allItems]);
  return { query, all, items, groups, total: allItems.length };
}
