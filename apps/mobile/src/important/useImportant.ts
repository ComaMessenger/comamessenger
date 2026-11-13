import { useMemo } from "react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useStore } from "zustand";
import { savedKeys } from "@comamessenger/core";
import { useMessenger } from "@/messenger/MessengerProvider";
import { useSignedIn } from "@/session/SessionProvider";
import { fetchSavedPage, importantItems, nextSavedPage } from "./saved";

export type { ImportantItem } from "./saved";

function useSavedPages(chatID: string | null, enabled = true) {
  const { api, user } = useSignedIn();
  return useInfiniteQuery({
    queryKey: savedKeys.list(user.id, chatID),
    enabled,
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => fetchSavedPage(api, chatID, pageParam),
    getNextPageParam: nextSavedPage,
  });
}

/**
 * The person's own saved messages («Важные»), newest save first — the same
 * source as the web. Nobody else sees them. A chat filter asks the server
 * for that chat only, and the chat chips come with counts over every save,
 * not just the loaded pages.
 */
export function useImportant(chatFilter: string | null) {
  const { api, user } = useSignedIn();
  const { store } = useMessenger();
  const chatMap = useStore(store, (state) => state.chats);
  const all = useSavedPages(null, chatFilter === null);
  const filtered = useSavedPages(chatFilter, chatFilter !== null);
  const query = chatFilter ? filtered : all;
  const chats = useQuery({
    queryKey: savedKeys.chats(user.id),
    queryFn: () => api.savedChats(),
  });
  const items = useMemo(
    () => importantItems(query.data?.pages, chatMap),
    [query.data, chatMap],
  );
  const groups = chats.data ?? [];
  const total = groups.reduce((sum, entry) => sum + entry.count, 0);
  return { query, chats, items, groups, total };
}
