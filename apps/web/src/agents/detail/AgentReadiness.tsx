import type { Agent } from "@comamessenger/core";
import { useTranslation } from "react-i18next";
import { Badge } from "../../ui";

export function AgentReadiness({ agent }: { agent: Agent }) {
  const { t } = useTranslation();
  return (
    <div className="agent-readiness">
      <span>
        <strong>{t("agentReadiness")}</strong>
        <small>{t(`agentReadinessState_${agent.readiness.state}`)}</small>
      </span>
      <Badge tone={agent.readiness.ready ? "success" : "neutral"}>
        {agent.readiness.ready ? t("ready") : t("needsSetup")}
      </Badge>
      {agent.readiness.blockers.length > 0 && (
        <ul>
          {agent.readiness.blockers.map((blocker) => (
            <li key={blocker}>{t(`agentReadiness_${blocker}`)}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
