import type { Agent, AgentRecipe, Chat } from "@comamessenger/core";
import { chatName, type Translate } from "./format";
import { recipeOf } from "./recipes";

/**
 * The task of an agent in one phrase. Built-in recipes left with their stock
 * instruction get the recipe summary from Core; otherwise the first sentence
 * of the instruction, bounded for a card.
 */
export function agentTask(
  t: Translate,
  agent: Agent,
  recipes?: readonly AgentRecipe[],
): string {
  const description = (agent.description ?? "").trim();
  const recipe = recipeOf(recipes, agent);
  if (recipe && (!description || description === recipe.instructions.trim()))
    return recipe.summary;
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
