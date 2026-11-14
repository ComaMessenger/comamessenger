import { needDone, recipeNeedPlace } from "@comamessenger/core";
import type { Agent, AgentRecipe } from "@comamessenger/core";
import { CheckCircle2, Circle, Sparkles } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { BuilderAnchor } from "../routes";
import type { Draft } from "../shared/draft";
import { blockID } from "./BuilderBlock";

const needAnchor: Record<
  AgentRecipe["needs"][number]["kind"],
  BuilderAnchor
> = recipeNeedPlace;

export { needDone };

/**
 * The top of a builder opened from a catalog role: what the role does, what
 * is left to choose before it can work and the defaults its instructions
 * were written with. Everything comes from the Core recipe.
 */
export function RecipeSetup({
  recipe,
  agent,
  draft,
}: {
  recipe: AgentRecipe;
  agent: Agent;
  draft: Draft;
}) {
  const { t } = useTranslation();
  const left = recipe.needs.filter((need) => !needDone(need, draft, agent));
  return (
    <section
      className="agent-recipe-setup"
      aria-labelledby="agent-recipe-setup-title"
    >
      <header className="agent-recipe-setup__head">
        <span className="agent-block__marker" aria-hidden="true">
          <Sparkles />
        </span>
        <span>
          <h3 id="agent-recipe-setup-title">
            {t("agentRecipeSetupTitle", { role: recipe.name })}
          </h3>
          <p>{recipe.summary}</p>
        </span>
      </header>
      <p className="agent-recipe-setup__status" role="status">
        {left.length > 0
          ? t("agentRecipeSetupLeft", { count: left.length })
          : t("agentRecipeSetupDone")}
      </p>
      <ul className="agent-recipe-setup__needs">
        {recipe.needs.map((need) => {
          const done = needDone(need, draft, agent);
          return (
            <li key={need.kind} data-done={done}>
              {done ? (
                <CheckCircle2 aria-hidden="true" />
              ) : (
                <Circle aria-hidden="true" />
              )}
              <span>
                <span className="visually-hidden">
                  {done ? t("agentRecipeNeedDone") : t("agentRecipeNeedOpen")}
                  {": "}
                </span>
                <a
                  href={`#${blockID(needAnchor[need.kind])}`}
                  onClick={(event) => {
                    event.preventDefault();
                    document
                      .getElementById(blockID(needAnchor[need.kind]))
                      ?.scrollIntoView({ behavior: "smooth", block: "start" });
                  }}
                >
                  {need.label}
                </a>
                {!need.required && (
                  <small> · {t("agentRecipeNeedOptional")}</small>
                )}
                <small>{need.hint}</small>
              </span>
            </li>
          );
        })}
      </ul>
      <div className="agent-recipe-setup__how">
        <h4>{t("agentRecipeHowTitle")}</h4>
        <ul>
          {recipe.triggers.map((trigger) => (
            <li key={trigger.summary}>{trigger.summary}</li>
          ))}
        </ul>
        {recipe.params.length > 0 && (
          <>
            <h4>{t("agentRecipeDefaultsTitle")}</h4>
            <dl>
              {recipe.params.map((param) => (
                <div key={param.key}>
                  <dt>{param.label}</dt>
                  <dd>{param.value}</dd>
                </div>
              ))}
            </dl>
            <p className="agent-muted">{t("agentRecipeDefaultsHint")}</p>
          </>
        )}
      </div>
    </section>
  );
}
