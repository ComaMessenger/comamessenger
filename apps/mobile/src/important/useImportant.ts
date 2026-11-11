import { useMemo } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { useStore } from "zustand";
import { savedChatFilters, savedKeys } from "@comamessenger/core";
import { useMessenger } from "@/messenger/MessengerProvider";
import { useSignedIn } from "@/session/SessionProvider";
import { fetchSavedPage, importantItems, nextSavedPage } from "./saved";

export type { ImportantItem } from "./saved";

function useSavedPages(chatID: string | null, enabled = true) {
  const { api } = useSignedIn();
  return useInfiniteQuery({
    queryKey: savedKeys.list(chatID),
    enabled,
    initialPageParam: undefined as number | undefined,
    queryFn: ({ pageParam }) => fetchSavedPage(api, chatID, pageParam),
    getNextPageParam: nextSavedPage,
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
    () => importantItems(all.data?.pages, {}),
    [all.data],
  );
  const items = useMemo(
    () => importantItems(query.data?.pages, chatMap),
    [query.data, chatMap],
  );
  const groups = useMemo(() => savedChatFilters(allItems), [allItems]);
  return { query, all, items, groups, total: allItems.length };
}
