import {
  decodeMentions,
  mentionedActorIDs,
  type ChatMember,
} from "@comamessenger/core";

export type PresenceMap = Record<string, "online" | "away" | "offline">;

/** Expands @all / @here into concrete actor ids in addition to explicit mentions. */
export function resolvedMentionActorIDs(
  source: string,
  members: ChatMember[],
  presence: PresenceMap,
) {
  const ids = new Set(mentionedActorIDs(source));
  const text = decodeMentions(source).text;
  if (/(^|\s)@all\b/i.test(text))
    members.forEach((member) => ids.add(member.actor_id));
  if (/(^|\s)@here\b/i.test(text))
    members
      .filter((member) => presence[member.actor_id] === "online")
      .forEach((member) => ids.add(member.actor_id));
  return [...ids];
}
