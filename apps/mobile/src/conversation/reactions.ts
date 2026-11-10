import {
  useQuery,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import type {
  ClientMessage,
  MessengerAPI,
  Reaction,
} from "@comamessenger/core";

export const quickReactions = ["👍", "❤️", "😂", "🎉", "👀", "🙏"];

export type ReactionGroup = { emoji: string; count: number; own: boolean };

export function reactionsKey(messageID: string) {
  return ["reactions", messageID] as const;
}

/** Messages still in the outbox have no server id to react to. */
function persisted(message: ClientMessage) {
  return !message.delivery || message.delivery === "sent";
}

/** Adds the reaction, or removes it when the user already reacted with it. */
export async function toggleReaction(
  api: MessengerAPI,
  queryClient: QueryClient,
  messageID: string,
  emoji: string,
  ownID: string,
) {
  const key = reactionsKey(messageID);
  const reactions =
    queryClient.getQueryData<Reaction[]>(key) ??
    (await api.reactions(messageID));
  const own = reactions.some(
    (reaction) => reaction.emoji === emoji && reaction.actor_id === ownID,
  );
  if (own) await api.unreact(messageID, emoji);
  else await api.react(messageID, emoji);
  await queryClient.invalidateQueries({ queryKey: key });
}

export function useReactions(
  api: MessengerAPI,
  message: ClientMessage,
  ownID: string,
) {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: reactionsKey(message.id),
    queryFn: () => api.reactions(message.id),
    enabled: persisted(message) && !message.deleted_at,
  });
  const reactions = query.data ?? [];
  const groups: ReactionGroup[] = [];
  for (const reaction of reactions) {
    const group = groups.find((item) => item.emoji === reaction.emoji);
    if (group) {
      group.count += 1;
      group.own ||= reaction.actor_id === ownID;
    } else
      groups.push({
        emoji: reaction.emoji,
        count: 1,
        own: reaction.actor_id === ownID,
      });
  }
  const toggle = (emoji: string) =>
    toggleReaction(api, queryClient, message.id, emoji, ownID);
  return { groups, toggle };
}
