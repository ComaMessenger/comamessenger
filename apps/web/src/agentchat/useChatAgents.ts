import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { chatCommands, type ChatMember } from "@comamessenger/core";
import { useMessenger } from "../shell/MessengerContext";

export function chatAgentsKey(chatID: string) {
  return ["chat-agents", chatID] as const;
}

/** Agents of a chat; requested only when an agent is among the members. */
export function useChatAgents(chatID: string, members: ChatMember[]) {
  const { api } = useMessenger();
  const hasAgents = members.some((member) => member.type === "agent");
  const query = useQuery({
    queryKey: chatAgentsKey(chatID),
    queryFn: () => api.chatAgents(chatID),
    enabled: hasAgents,
    staleTime: 60_000,
  });
  const agents = hasAgents ? (query.data ?? []) : [];
  const commands = useMemo(() => chatCommands(agents), [agents]);
  return { query, agents, commands, hasAgents };
}
