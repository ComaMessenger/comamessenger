import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { useStore } from "zustand";
import {
  threadPreview,
  type ClientMessage,
  type Message,
  type ThreadPreview,
} from "@comamessenger/core";
import { useMessenger } from "@/messenger/MessengerProvider";
import { useSignedIn } from "@/session/SessionProvider";

const noMessages: ClientMessage[] = [];

/**
 * Who replied in the thread under `root` and when, as on the web. The thread
 * query key is the one the thread screen uses, so opening it costs nothing;
 * realtime replies come from the store.
 */
export function useThreadPreview(
  root: Message,
  enabled: boolean,
): ThreadPreview {
  const { api } = useSignedIn();
  const { store } = useMessenger();
  const stored = useStore(
    store,
    (state) => state.messages[root.chat_id] ?? noMessages,
  );
  const active = enabled && root.thread_reply_count > 0 && !root.deleted_at;
  const query = useQuery({
    queryKey: ["thread", root.id],
    queryFn: () => api.thread(root.id),
    enabled: active,
    staleTime: 60_000,
  });
  const loaded = query.data?.messages;
  return useMemo(
    () => threadPreview(root.id, active ? [loaded, stored] : []),
    [active, loaded, root.id, stored],
  );
}
