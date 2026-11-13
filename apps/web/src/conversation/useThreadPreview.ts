import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { useStore } from "zustand";
import { threadPreview, type ClientMessage, type Message, type ThreadPreview as SharedThreadPreview } from "@comamessenger/core";
import { useMessenger } from "../shell/MessengerContext";

const emptyMessages: ClientMessage[] = [];

export type ThreadPreview = SharedThreadPreview & { loaded: boolean };

/**
 * Lazily loads a thread so the feed can show who replied and when — the API
 * exposes only `thread_reply_count` on the root message (see redesign/messenger.md).
 * The query key is shared with ThreadPanel, so opening the thread costs nothing extra;
 * realtime replies come from the store and are merged in without refetching.
 * The summary itself is shared with the mobile app (`threadPreview` in core).
 */
export function useThreadPreview(root: Message, enabled: boolean): ThreadPreview {
  const { api, store } = useMessenger();
  const stored = useStore(store, (state) => state.messages[root.chat_id] ?? emptyMessages);
  const query = useQuery({
    queryKey: ["thread", root.id],
    queryFn: () => api.thread(root.id),
    enabled: enabled && root.thread_reply_count > 0,
    staleTime: 60_000,
  });
  const loaded = query.data?.messages;
  return useMemo(
    () => ({ ...threadPreview(root.id, [loaded, stored]), loaded: loaded !== undefined }),
    [loaded, root.id, stored],
  );
}
