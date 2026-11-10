import type { MessengerAPI } from "@comamessenger/core";
import { Play } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "../../ui";
import { SettingsSection } from "../../settings/components/SettingsPrimitives";
import { agentRunErrorText } from "../shared/format";
import type { AgentOperationsState } from "./useAgentOperations";

export function AgentRunsSection({
  api,
  operations,
}: {
  api: MessengerAPI;
  operations: AgentOperationsState;
}) {
  const { t } = useTranslation();
  const { runs, selectedRun, setSelectedRun, action } = operations;
  return (
    <SettingsSection
      title={t("agentRuns")}
      description={t("agentRunsHint")}
      wide
    >
      <div className="agent-record-list">
        {(runs.data?.runs ?? []).map((run) => (
          <button key={run.id} onClick={() => setSelectedRun(run)}>
            <Play />
            <span>
              <strong>
                {t(`agentRunStatus_${run.status}`)} · {run.model}
              </strong>
              <small>
                {run.correlation_id}
                {run.error_code
                  ? ` · ${agentRunErrorText(t, run.error_code)}`
                  : ""}
              </small>
            </span>
            <time>{new Date(run.created_at).toLocaleString()}</time>
          </button>
        ))}
      </div>
      {selectedRun && (
        <div className="agent-run-detail">
          <dl>
            <div>
              <dt>{t("runStatus")}</dt>
              <dd>{t(`agentRunStatus_${selectedRun.status}`)}</dd>
            </div>
            <div>
              <dt>{t("model")}</dt>
              <dd>{selectedRun.model}</dd>
            </div>
            <div>
              <dt>{t("correlationID")}</dt>
              <dd>{selectedRun.correlation_id}</dd>
            </div>
            <div>
              <dt>{t("createdAt")}</dt>
              <dd>{new Date(selectedRun.created_at).toLocaleString()}</dd>
            </div>
            {selectedRun.error_code && (
              <div>
                <dt>{t("errorCode")}</dt>
                <dd>{agentRunErrorText(t, selectedRun.error_code)}</dd>
              </div>
            )}
          </dl>
          {["queued", "running"].includes(selectedRun.status) && (
            <Button
              onClick={() =>
                void action(async () => {
                  const canceled = await api.cancelAgentRun(selectedRun.id);
                  setSelectedRun(canceled);
                })
              }
            >
              {t("cancel")}
            </Button>
          )}
        </div>
      )}
    </SettingsSection>
  );
}
