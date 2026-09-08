import { useQuery } from "@tanstack/react-query";
import type { ChatMember } from "@comamessenger/core";
import { useMessenger } from "../shell/MessengerContext";

const none: ChatMember[] = [];

/** Members of a chat, sharing the cache key Conversation uses. */
export function useChatMembers(chatID: string | undefined) {
  const { api } = useMessenger();
  const query = useQuery({
    queryKey: ["chat-members", chatID],
    queryFn: () => api.members(chatID!),
    enabled: Boolean(chatID),
    staleTime: 5 * 60_000,
  });
  return { members: query.data ?? none, query };
}
