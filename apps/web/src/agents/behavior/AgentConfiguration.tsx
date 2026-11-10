import type { AgentLlmConnection, Chat } from "@comamessenger/core";
import { Bot, ChevronDown } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Field, SelectField, TextareaField } from "../../ui";
import {
  SettingsSection,
  SettingsToggle,
} from "../../settings/components/SettingsPrimitives";
import { agentScopes as scopes, type Draft } from "../shared/draft";
import { chatName } from "../shared/format";

export function AgentConfiguration({
  draft,
  chats,
  connections,
  onChange,
}: {
  draft: Draft;
  chats: Chat[];
  connections: AgentLlmConnection[];
  onChange(value: Draft): void;
}) {
  const { t } = useTranslation();
  const number = (
    key:
      | "max_output_tokens"
      | "max_tool_iterations"
      | "max_chain_depth"
      | "per_chat_concurrency"
      | "rate_limit_per_minute"
      | "provider_rate_limit_per_minute"
      | "execution_timeout_seconds",
    value: string,
  ) => onChange({ ...draft, [key]: Number(value) });
  return (
    <>
      <SettingsSection
        title={t("agentIdentity")}
        description={t("agentIdentityHint")}
        icon={<Bot />}
        wide
      >
        <div className="settings-form-grid">
          <Field
            label={t("displayName")}
            name="agent-name"
            value={draft.display_name}
            onChange={(e) =>
              onChange({ ...draft, display_name: e.target.value })
            }
          />
          <Field
            label={t("handle")}
            name="agent-handle"
            value={draft.handle}
            onChange={(e) =>
              onChange({ ...draft, handle: e.target.value.toLowerCase() })
            }
          />
        </div>
        <TextareaField
          label={t("agentInstructions")}
          name="agent-description"
          rows={5}
          value={draft.description ?? ""}
          onChange={(e) => onChange({ ...draft, description: e.target.value })}
        />
        <SettingsToggle
          label={t("agentEnabled")}
          hint={t("agentEnabledHint")}
          checked={draft.enabled}
          onChange={(enabled) => onChange({ ...draft, enabled })}
        />
      </SettingsSection>
      <SettingsSection
        title={t("agentChats")}
        description={t("agentChatsHint")}
        wide
      >
        <div className="agent-check-grid">
          {chats.map((chat) => (
            <label key={chat.id}>
              <input
                type="checkbox"
                checked={draft.chat_ids.includes(chat.id)}
                onChange={(e) =>
                  onChange({
                    ...draft,
                    chat_ids: e.target.checked
                      ? [...draft.chat_ids, chat.id]
                      : draft.chat_ids.filter((id) => id !== chat.id),
                  })
                }
              />
              <span>{chatName(chat)}</span>
            </label>
          ))}
        </div>
      </SettingsSection>
      <details className="agent-advanced">
        <summary>
          <span>
            <strong>{t("agentAdvanced")}</strong>
            <small>{t("agentAdvancedHint")}</small>
          </span>
          <ChevronDown />
        </summary>
        <div className="agent-advanced__content">
          <SettingsSection
            title={t("agentProviderSettings")}
            description={t("agentProviderSettingsHint")}
            wide
          >
            <div className="settings-form-grid">
              <SelectField
                required={false}
                label={t("agentConnectionsTitle")}
                name="agent-connection"
                value={draft.llm_connection_id ?? ""}
                onChange={(event) => {
                  const connection = connections.find(
                    (item) => item.id === event.target.value,
                  );
                  onChange({
                    ...draft,
                    llm_connection_id: connection?.id ?? "",
                    provider: connection?.provider ?? draft.provider,
                    endpoint_url: connection?.endpoint_url ?? "",
                    model: connection?.default_model || draft.model || "",
                  });
                }}
              >
                <option value="">{t("agentConnectionChoose")}</option>
                {connections
                  .filter((connection) => connection.enabled)
                  .map((connection) => (
                    <option key={connection.id} value={connection.id}>
                      {connection.name} · {connection.default_model}
                    </option>
                  ))}
              </SelectField>
              <Field
                label={t("model")}
                name="agent-model"
                value={draft.model ?? ""}
                onChange={(e) => onChange({ ...draft, model: e.target.value })}
              />
            </div>
            <SettingsToggle
              label={t("externalDataSharing")}
              hint={t("externalDataSharingHint")}
              checked={draft.external_data_sharing_approved}
              onChange={(external_data_sharing_approved) =>
                onChange({ ...draft, external_data_sharing_approved })
              }
            />
          </SettingsSection>
          <SettingsSection
            title={t("agentPermissions")}
            description={t("agentPermissionsHint")}
            wide
          >
            <div className="agent-check-grid">
              {scopes.map((scope) => (
                <label key={scope}>
                  <input
                    type="checkbox"
                    checked={draft.allowed_scopes.includes(scope)}
                    onChange={(e) =>
                      onChange({
                        ...draft,
                        allowed_scopes: e.target.checked
                          ? [...draft.allowed_scopes, scope]
                          : draft.allowed_scopes.filter(
                              (item) => item !== scope,
                            ),
                      })
                    }
                  />
                  <span>{t(`agentScope_${scope.replace(":", "_")}`)}</span>
                </label>
              ))}
            </div>
          </SettingsSection>
          <SettingsSection
            title={t("agentLimits")}
            description={t("agentLimitsHint")}
            wide
          >
            <div className="settings-form-grid">
              <Field
                required={false}
                label={t("dailyBudget")}
                name="daily-budget"
                value={draft.daily_cost_limit ?? ""}
                onChange={(e) =>
                  onChange({ ...draft, daily_cost_limit: e.target.value })
                }
              />
              <Field
                required={false}
                label={t("monthlyBudget")}
                name="monthly-budget"
                value={draft.monthly_cost_limit ?? ""}
                onChange={(e) =>
                  onChange({ ...draft, monthly_cost_limit: e.target.value })
                }
              />
              <Field
                type="number"
                label={t("maxOutputTokens")}
                name="max-output"
                value={draft.max_output_tokens ?? 2048}
                onChange={(e) => number("max_output_tokens", e.target.value)}
              />
              <Field
                type="number"
                label={t("maxToolIterations")}
                name="max-tools"
                value={draft.max_tool_iterations ?? 8}
                onChange={(e) => number("max_tool_iterations", e.target.value)}
              />
              <Field
                type="number"
                label={t("perChatConcurrency")}
                name="concurrency"
                value={draft.per_chat_concurrency ?? 1}
                onChange={(e) => number("per_chat_concurrency", e.target.value)}
              />
              <Field
                type="number"
                label={t("rateLimit")}
                name="agent-rate"
                value={draft.rate_limit_per_minute ?? 60}
                onChange={(e) =>
                  number("rate_limit_per_minute", e.target.value)
                }
              />
              <Field
                type="number"
                label={t("executionTimeout")}
                name="execution-timeout"
                value={draft.execution_timeout_seconds ?? 600}
                onChange={(e) =>
                  number("execution_timeout_seconds", e.target.value)
                }
              />
            </div>
          </SettingsSection>
        </div>
      </details>
    </>
  );
}
