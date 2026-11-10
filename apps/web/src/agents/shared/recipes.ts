import { useQuery } from "@tanstack/react-query";
import type { Agent, AgentRecipe, MessengerAPI } from "@comamessenger/core";
import { useTranslation } from "react-i18next";

/*
 * Built-in roles come from Core (`GET /agents/recipes`) in the interface
 * language: names, instructions, scopes, rules and check examples. The client
 * keeps no copy of recipe texts.
 */
export function useRecipes(api: MessengerAPI, enabled = true) {
  const { i18n } = useTranslation();
  const locale = i18n.resolvedLanguage ?? i18n.language ?? "en";
  return useQuery({
    queryKey: ["agent-recipes", locale],
    queryFn: () => api.agentRecipes(locale),
    enabled,
    staleTime: Infinity,
  });
}

export function recipeOf(
  recipes: readonly AgentRecipe[] | undefined,
  agent: Pick<Agent, "recipe">,
): AgentRecipe | undefined {
  if (agent.recipe === "custom") return undefined;
  return recipes?.find((recipe) => recipe.id === agent.recipe);
}
