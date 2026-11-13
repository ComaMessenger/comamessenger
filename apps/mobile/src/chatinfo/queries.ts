import { useMemo } from "react";
import { useQuery, type QueryClient } from "@tanstack/react-query";
import type {
  ChatEventEffect,
  ChatViewer,
  Message,
  MessagePin,
  User,
} from "@comamessenger/core";
import { withCache } from "@/messenger/cache";
import { useSignedIn } from "@/session/SessionProvider";

/**
 * Query keys shared with the conversation screen: `members` and `pins` hold
 * the same data there, so a change made here shows in the open chat.
 */
export const chatKeys = {
  members: (chatID: string) => ["members", chatID] as const,
  pins: (chatID: string) => ["pins", chatID] as const,
  pinnedMessages: (chatID: string) => ["pinned-messages", chatID] as const,
};

/** Refreshes what a realtime event changed in a chat's details. */
export function invalidateChatDetails(
  queryClient: QueryClient,
  effect: ChatEventEffect,
) {
  if (effect.members)
    void queryClient.invalidateQueries({
      queryKey: chatKeys.members(effect.chatID),
    });
  if (effect.pins) {
    void queryClient.invalidateQueries({
      queryKey: chatKeys.pins(effect.chatID),
    });
    void queryClient.invalidateQueries({
      queryKey: chatKeys.pinnedMessages(effect.chatID),
    });
  }
}

export function viewerOf(user: User): ChatViewer {
  return {
    actorID: user.id,
    orgRole: user.role,
    permissions: user.permissions ?? [],
  };
}

export function useChatMembers(chatID: string) {
  const { api } = useSignedIn();
  const query = useQuery({
    queryKey: chatKeys.members(chatID),
    queryFn: () => withCache(`members:${chatID}`, () => api.members(chatID)),
    staleTime: 60_000,
  });
  const members = useMemo(() => query.data ?? [], [query.data]);
  return { members, query };
}

export type PinnedEntry = { pin: MessagePin; message: Message | undefined };

/**
 * Pinned messages of a chat with their text. The pins endpoint returns ids
 * only; each message comes from its context window, as on the web.
 */
export function usePinnedMessages(chatID: string) {
  const { api } = useSignedIn();
  const pins = useQuery({
    queryKey: chatKeys.pins(chatID),
    queryFn: () => api.pins(chatID),
    staleTime: 30_000,
  });
  const ids = (pins.data ?? []).map((pin) => pin.message_id).join(",");
  const entries = useQuery({
    queryKey: [...chatKeys.pinnedMessages(chatID), ids],
    enabled: pins.isSuccess,
    queryFn: () =>
      Promise.all(
        (pins.data ?? []).map(async (pin): Promise<PinnedEntry> => {
          try {
            const window = await api.messageContext(pin.message_id, 3);
            return {
              pin,
              message: window.messages.find(
                (item) => item.id === pin.message_id,
              ),
            };
          } catch {
            return { pin, message: undefined };
          }
        }),
      ),
    staleTime: 30_000,
  });
  return {
    count: pins.data?.length ?? 0,
    entries: entries.data ?? [],
    loading: pins.isLoading || (pins.isSuccess && entries.isLoading),
    failed: pins.isError,
    refetch: () => void pins.refetch(),
  };
}
