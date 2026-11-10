import { useQuery } from "@tanstack/react-query";
import type { Agent, MessengerAPI } from "@comamessenger/core";
import { Activity, Bot } from "lucide-react";
import { useTranslation } from "react-i18next";
import { formatProductDuration } from "../shared/format";

export function AgentActivityDirectory({
  api,
  agents,
  navigate,
}: {
  api: MessengerAPI;
  agents: Agent[];
  navigate(to: string): void;
}) {
  const { t } = useTranslation();
  const metrics = useQuery({
    queryKey: ["agent-product-metrics"],
    queryFn: () => api.agentProductMetrics(),
  });
  return (
    <div className="agent-global-page">
      <div className="agent-global-page__title">
        <div>
          <h2>{t("agentActivityTitle")}</h2>
          <p>{t("agentActivityDescription")}</p>
        </div>
      </div>
      {metrics.data && (
        <div className="agent-stat-grid">
          <span>
            <small>{t("agentMetricPublished")}</small>
            <strong>
              {metrics.data.agents_published} / {metrics.data.agents_total}
            </strong>
          </span>
          <span>
            <small>{t("agentMetricTestRuns")}</small>
            <strong>{metrics.data.test_runs_total}</strong>
          </span>
          <span>
            <small>{t("agentMetricTestFailures")}</small>
            <strong>{metrics.data.test_runs_failed}</strong>
          </span>
          <span>
            <small>{t("agentMetricTimeToTest")}</small>
            <strong>
              {formatProductDuration(
                metrics.data.average_seconds_to_first_test,
              )}
            </strong>
          </span>
          <span>
            <small>{t("agentMetricTimeToPublish")}</small>
            <strong>
              {formatProductDuration(
                metrics.data.average_seconds_to_first_publish,
              )}
            </strong>
          </span>
        </div>
      )}
      {agents.length ? (
        <div className="agent-directory-grid">
          {agents.map((agent) => (
            <button
              key={agent.id}
              onClick={() => navigate(`/agents/${agent.id}/activity`)}
            >
              <Activity />
              <span>
                <strong>{agent.display_name}</strong>
                <small>
                  @{agent.handle} ·{" "}
                  {t(`agentReadinessState_${agent.readiness.state}`)}
                </small>
              </span>
            </button>
          ))}
        </div>
      ) : (
        <div className="agent-empty-state">
          <Bot />
          <h3>{t("agentsEmptyTitle")}</h3>
          <p>{t("agentsEmptyHint")}</p>
        </div>
      )}
    </div>
  );
}
