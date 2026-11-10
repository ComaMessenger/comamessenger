import { Activity, LayoutGrid, Plug } from "lucide-react";
import { useTranslation } from "react-i18next";
import { countLabel } from "../ui";
import type { AgentAccess } from "./shared/access";

const tabs = [
  ["overview", "/agents", LayoutGrid],
  ["activity", "/agents/activity", Activity],
  ["connections", "/agents/connections", Plug],
] as const;

export function AgentPlatformHeader({
  globalTab,
  access: { canBuild, canPublish, canApprove, canObserve, canIntegrate },
  pendingApprovals,
  navigate,
}: {
  globalTab: "overview" | "activity" | "connections" | null;
  access: AgentAccess;
  pendingApprovals: number;
  navigate(to: string): void;
}) {
  const { t } = useTranslation();
  return (
    <header className="agent-platform__header">
      <div>
        <h1>{t("agentsTitle")}</h1>
        <p>{t("agentPlatformLead")}</p>
      </div>
      <nav aria-label={t("agentPlatformNavigation")}>
        {tabs
          .filter(([id]) =>
            id === "connections"
              ? canIntegrate
              : id === "activity"
                ? canObserve || canApprove
                : canBuild || canPublish || canObserve,
          )
          .map(([id, target, Icon]) => (
            <button
              key={id}
              className={globalTab === id ? "active" : ""}
              aria-current={globalTab === id ? "page" : undefined}
              onClick={() => navigate(target)}
            >
              <Icon />
              <span>{t(`agentNav_${id}`)}</span>
              {id === "activity" && pendingApprovals > 0 && (
                <span
                  className="agent-platform__count"
                  aria-label={t("agentPendingCount", {
                    count: pendingApprovals,
                  })}
                >
                  {countLabel(pendingApprovals)}
                </span>
              )}
            </button>
          ))}
      </nav>
    </header>
  );
}
