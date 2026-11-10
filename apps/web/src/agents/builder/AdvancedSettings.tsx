import type { Agent, MessengerAPI } from "@comamessenger/core";
import { ChevronDown, Settings2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Field } from "../../ui";
import { orderedScopes } from "../shared/capabilities";
import type { Draft } from "../shared/draft";
import { blockID } from "./BuilderBlock";
import { AgentDangerZone } from "./AgentDangerZone";
import { AgentKeys } from "./AgentKeys";
import { VersionHistory } from "./VersionHistory";
import type { AgentBuilderState } from "./useAgentBuilder";

type NumberKey =
  | "max_output_tokens"
  | "max_tool_iterations"
  | "per_chat_concurrency"
  | "rate_limit_per_minute"
  | "execution_timeout_seconds";

const numberFields: Array<[NumberKey, string, number]> = [
  ["max_output_tokens", "maxOutputTokens", 2048],
  ["max_tool_iterations", "maxToolIterations", 8],
  ["per_chat_concurrency", "perChatConcurrency", 1],
  ["rate_limit_per_minute", "rateLimit", 60],
  ["execution_timeout_seconds", "executionTimeout", 600],
];

/**
 * Everything technical lives here and is collapsed by default: model,
 * address, limits, the derived permissions, keys, versions and removal.
 */
export function AdvancedSettings({
  api,
  agent,
  draft,
  builder,
  open,
  onToggle,
  canBuild,
  canPublish,
  navigate,
  refetchAgents,
}: {
  api: MessengerAPI;
  agent: Agent;
  draft: Draft;
  builder: AgentBuilderState;
  open: boolean;
  onToggle(open: boolean): void;
  canBuild: boolean;
  canPublish: boolean;
  navigate(to: string): void;
  refetchAgents(): Promise<unknown>;
}) {
  const { t } = useTranslation();
  const set = (patch: Partial<Draft>) => builder.setDraft({ ...draft, ...patch });
  return (
    <details
      id={blockID("advanced")}
      className="agent-advanced-block"
      open={open}
      onToggle={(event) => onToggle(event.currentTarget.open)}
    >
      <summary>
        <Settings2 aria-hidden="true" />
        <span>
          <strong>{t("agentAdvancedTitle")}</strong>
          <small>{t("agentAdvancedLead")}</small>
        </span>
        <ChevronDown aria-hidden="true" />
      </summary>
      {open && (
        <div className="agent-advanced-block__body">
          <fieldset disabled={!canBuild} className="agent-fieldset">
            <section>
              <h4>{t("agentAdvancedModel")}</h4>
              <div className="agent-form-row">
                <Field
                  label={t("model")}
                  name="agent-model"
                  value={draft.model ?? ""}
                  onChange={(event) => set({ model: event.target.value })}
                />
                <Field
                  label={t("agentHandle")}
                  name="agent-handle"
                  prefix="@"
                  value={draft.handle}
                  hint={t("agentHandleHint")}
                  onChange={(event) =>
                    set({ handle: event.target.value.toLowerCase() })
                  }
                />
              </div>
            </section>
            <section>
              <h4>{t("agentLimits")}</h4>
              <p className="agent-muted">{t("agentLimitsLead")}</p>
              <div className="agent-form-row">
                <Field
                  required={false}
                  inputMode="decimal"
                  label={t("agentDailyBudget")}
                  name="daily-budget"
                  value={draft.daily_cost_limit ?? ""}
                  placeholder={t("agentNoLimit")}
                  onChange={(event) =>
                    set({ daily_cost_limit: event.target.value })
                  }
                />
                <Field
                  required={false}
                  inputMode="decimal"
                  label={t("agentMonthlyBudget")}
                  name="monthly-budget"
                  value={draft.monthly_cost_limit ?? ""}
                  placeholder={t("agentNoLimit")}
                  onChange={(event) =>
                    set({ monthly_cost_limit: event.target.value })
                  }
                />
                {numberFields.map(([key, label, fallback]) => (
                  <Field
                    key={key}
                    type="number"
                    label={t(label)}
                    name={`agent-${key}`}
                    value={draft[key] ?? fallback}
                    onChange={(event) =>
                      set({ [key]: Number(event.target.value) })
                    }
                  />
                ))}
              </div>
            </section>
            <section>
              <h4>{t("agentPermissionsTitle")}</h4>
              <p className="agent-muted">{t("agentPermissionsDerived")}</p>
              <ul className="agent-scope-list">
                {orderedScopes
                  .filter((scope) => draft.allowed_scopes.includes(scope))
                  .map((scope) => (
                    <li key={scope}>
                      <code>{scope}</code>
                      <span>{t(`agentScope_${scope.replace(":", "_")}`)}</span>
                    </li>
                  ))}
              </ul>
            </section>
          </fieldset>
          {canBuild && (agent.kind === "external" || !agent.llm_connection_id) && (
            <AgentKeys api={api} agent={agent} onChanged={refetchAgents} />
          )}
          <VersionHistory
            api={api}
            agent={agent}
            canPublish={canPublish}
            pending={Boolean(builder.pending)}
            onRollback={(versionID) => void builder.rollback(versionID)}
          />
          {canBuild && (
            <AgentDangerZone
              api={api}
              agent={agent}
              navigate={navigate}
              refetchAgents={refetchAgents}
            />
          )}
        </div>
      )}
    </details>
  );
}
