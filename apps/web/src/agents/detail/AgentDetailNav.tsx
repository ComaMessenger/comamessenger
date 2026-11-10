import type { Agent } from "@comamessenger/core";
import {
  Activity,
  Bot,
  FlaskConical,
  KeyRound,
  LayoutGrid,
  Plug,
  Zap,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import type { AgentDetailSection } from "../routes";
import type { AgentAccess } from "../shared/access";

const sections = [
  ["overview", LayoutGrid],
  ["behavior", Bot],
  ["knowledge", KeyRound],
  ["automations", Zap],
  ["test", FlaskConical],
  ["activity", Activity],
  ["settings", Plug],
] as const;

export function AgentDetailNav({
  agent,
  section: current,
  access: { canBuild, canPublish, canObserve },
  navigate,
}: {
  agent: Agent;
  section: AgentDetailSection;
  access: AgentAccess;
  navigate(to: string): void;
}) {
  const { t } = useTranslation();
  return (
    <nav className="agent-detail-nav" aria-label={t("agentDetailNavigation")}>
      {sections
        .filter(([section]) =>
          section === "activity"
            ? canObserve
            : section === "overview"
              ? canBuild || canPublish || canObserve
              : canBuild,
        )
        .map(([section, Icon]) => (
          <button
            key={section}
            className={current === section ? "active" : ""}
            aria-current={current === section ? "page" : undefined}
            onClick={() =>
              navigate(
                section === "overview"
                  ? `/agents/${agent.id}`
                  : `/agents/${agent.id}/${section}`,
              )
            }
          >
            <Icon />
            <span>{t(`agentTab_${section}`)}</span>
          </button>
        ))}
    </nav>
  );
}
