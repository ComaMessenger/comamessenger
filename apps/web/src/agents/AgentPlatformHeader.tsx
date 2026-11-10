import { Activity, LayoutGrid, Plug, ShieldCheck } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { AgentGlobalSection } from "./routes";
import type { AgentAccess } from "./shared/access";

const tabs = [
  ["overview", "/agents", LayoutGrid],
  ["connections", "/agents/connections", Plug],
  ["approvals", "/agents/approvals", ShieldCheck],
  ["activity", "/agents/activity", Activity],
] as const;

export function AgentPlatformHeader({
  globalTab,
  access: { canBuild, canPublish, canApprove, canObserve, canIntegrate },
  navigate,
}: {
  globalTab: AgentGlobalSection | null;
  access: AgentAccess;
  navigate(to: string): void;
}) {
  const { t } = useTranslation();
  return (
    <header className="agent-platform__header">
      <div>
        <h1>{t("agentsTitle")}</h1>
        <p>{t("agentPlatformHint")}</p>
      </div>
      <nav aria-label={t("agentPlatformNavigation")}>
        {tabs
          .filter(([id]) =>
            id === "connections"
              ? canIntegrate
              : id === "approvals"
                ? canApprove
                : id === "activity"
                  ? canObserve
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
              <span>{t(`agentTab_${id}`)}</span>
            </button>
          ))}
      </nav>
    </header>
  );
}
