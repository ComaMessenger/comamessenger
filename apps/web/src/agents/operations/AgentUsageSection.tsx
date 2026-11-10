import { useTranslation } from "react-i18next";
import { SettingsSection } from "../../settings/components/SettingsPrimitives";
import type { AgentOperationsState } from "./useAgentOperations";

export function AgentUsageSection({
  usage,
}: {
  usage: AgentOperationsState["usage"]["data"];
}) {
  const { t } = useTranslation();
  return (
    <SettingsSection
      title={t("agentUsage")}
      description={t("agentUsageHint")}
      wide
    >
      <div className="agent-stat-grid">
        <span>
          <small>{t("today")}</small>
          <strong>${usage?.daily_cost ?? "0"}</strong>
        </span>
        <span>
          <small>{t("thisMonth")}</small>
          <strong>${usage?.monthly_cost ?? "0"}</strong>
        </span>
        <span>
          <small>{t("runs")}</small>
          <strong>{usage?.monthly_runs ?? 0}</strong>
        </span>
        <span>
          <small>{t("tokens")}</small>
          <strong>
            {(usage?.daily_input_tokens ?? 0) +
              (usage?.daily_output_tokens ?? 0)}
          </strong>
        </span>
      </div>
    </SettingsSection>
  );
}
