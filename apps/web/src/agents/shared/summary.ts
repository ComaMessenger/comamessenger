import type { Agent, Chat } from "@comamessenger/core";
import { templateDescriptions } from "./draft";
import { chatName, type Translate } from "./format";

/**
 * The task of an agent in one phrase. Built-in recipes left with their stock
 * instruction get the localized role phrase; otherwise the first sentence of
 * the instruction, bounded for a card.
 */
export function agentTask(t: Translate, agent: Agent): string {
  const description = (agent.description ?? "").trim();
  if (agent.recipe !== "custom") {
    const stock = [
      templateDescriptions[agent.recipe],
      t(`agentTemplateDescription_${agent.recipe}`),
    ];
    if (!description || stock.some((text) => description.startsWith(text)))
      return t(`agentRoleTask_${agent.recipe}`);
  }
  if (!description) return t("agentNoTask");
  const first = description.split(/(?<=[.!?…])\s+/)[0] ?? description;
  return first.length > 160 ? `${first.slice(0, 157).trimEnd()}…` : first;
}

/** Where the agent works, as short chat names. */
export function agentPlaces(t: Translate, agent: Agent, chats: Chat[]): string {
  const names = agent.chat_ids
    .map((id) => chats.find((chat) => chat.id === id))
    .filter((chat): chat is Chat => Boolean(chat))
    .map(chatName);
  if (names.length === 0)
    return agent.chat_ids.length
      ? t("agentPlacesCount", { count: agent.chat_ids.length })
      : t("agentPlacesNone");
  if (names.length <= 2) return names.join(", ");
  return t("agentPlacesMore", {
    names: names.slice(0, 2).join(", "),
    count: names.length - 2,
  });
}
