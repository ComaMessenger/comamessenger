import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { useStore } from "zustand";
import type { ClientMessage, Message } from "@comamessenger/core";
import { useMessenger } from "../shell/MessengerContext";

const emptyMessages: ClientMessage[] = [];

export type ThreadPreview = {
  /** Distinct reply authors, most recent first (at most three). */
  participantIDs: string[];
  /** ISO timestamp of the latest reply, if any reply is known. */
  lastReplyAt: string | null;
};

/**
 * Lazily loads a thread so the feed can show who replied and when — the API
 * exposes only `thread_reply_count` on the root message (see redesign/messenger.md).
 * The query key is shared with ThreadPanel, so opening the thread costs nothing extra;
 * realtime replies come from the store and are merged in without refetching.
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
  return useMemo(() => {
    const replies = new Map<string, Message>();
    for (const message of [...(loaded ?? []), ...stored]) {
      if (message.thread_root_id === root.id && !message.deleted_at) replies.set(message.id, message);
    }
    const ordered = [...replies.values()].sort((a, b) => b.created_seq - a.created_seq);
    const participantIDs: string[] = [];
    for (const reply of ordered) {
      if (!participantIDs.includes(reply.actor_id)) participantIDs.push(reply.actor_id);
      if (participantIDs.length === 3) break;
    }
    return { participantIDs, lastReplyAt: ordered[0]?.created_at ?? null };
  }, [loaded, root.id, stored]);
}
