import type { AgentLlmConnection } from "@comamessenger/core";
import { ShieldCheck } from "lucide-react";
import { useTranslation } from "react-i18next";
import { SelectField } from "../../../ui";
import { SettingsToggle } from "../../../settings/components/SettingsPrimitives";
import type { AgentWizardState } from "../useAgentWizard";

export function WizardConnectionStep({
  wizard,
  connections,
}: {
  wizard: AgentWizardState;
  connections: AgentLlmConnection[];
}) {
  const { t } = useTranslation();
  const { draft, setDraft } = wizard;
  return (
    <div className="agent-wizard__step">
      <div>
        <h3>{t("agentWizardConnection")}</h3>
        <p>{t("agentWizardConnectionHint")}</p>
      </div>
      <SelectField
        required={false}
        label={t("agentConnectionsTitle")}
        name="wizard-agent-connection"
        value={draft.llm_connection_id ?? ""}
        onChange={(event) => {
          const connection = connections.find(
            (item) => item.id === event.target.value,
          );
          setDraft({
            ...draft,
            llm_connection_id: connection?.id ?? "",
            provider: connection?.provider ?? draft.provider,
            endpoint_url: connection?.endpoint_url ?? "",
            model: connection?.default_model || draft.model || "",
          });
        }}
      >
        <option value="">{t("agentConnectionChooseLater")}</option>
        {connections
          .filter((connection) => connection.enabled)
          .map((connection) => (
            <option key={connection.id} value={connection.id}>
              {connection.name} · {connection.default_model}
            </option>
          ))}
      </SelectField>
      <SettingsToggle
        label={t("agentWizardExternalData")}
        hint={t("agentWizardExternalDataHint")}
        checked={draft.external_data_sharing_approved}
        onChange={(value) =>
          setDraft({ ...draft, external_data_sharing_approved: value })
        }
      />
      <div className="agent-wizard__notice">
        <ShieldCheck />
        <span>{t("agentWizardSafeStart")}</span>
      </div>
    </div>
  );
}
