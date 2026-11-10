import type { Agent } from "@comamessenger/core";
import { Bot, Plus, Zap } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "../../ui";
import type { AgentTemplate as Template } from "../agentTemplates";

/** Left column: create buttons, built-in templates and the agent list. */
export function AgentCatalog({
  agents,
  selectedID,
  canBuild,
  onChooseTemplate,
  navigate,
}: {
  agents: Agent[];
  selectedID: string | null;
  canBuild: boolean;
  onChooseTemplate(template: Template): void;
  navigate(to: string): void;
}) {
  const { t } = useTranslation();
  return (
    <aside className="agent-catalog">
      {canBuild && (
        <>
          <Button variant="primary" onClick={() => onChooseTemplate("custom")}>
            <Plus />
            {t("createAgent")}
          </Button>
          <div className="agent-template-row">
            {(["summarizer", "qa", "onboarding"] as const).map((item) => (
              <button key={item} onClick={() => onChooseTemplate(item)}>
                <Zap />
                <span>{t(`agentTemplate_${item}`)}</span>
              </button>
            ))}
          </div>
        </>
      )}
      {agents.map((agent) => (
        <button
          key={agent.id}
          className={selectedID === agent.id ? "active" : ""}
          aria-current={selectedID === agent.id ? "page" : undefined}
          onClick={() => navigate(`/agents/${agent.id}`)}
        >
          <Bot />
          <span>
            <strong>{agent.display_name}</strong>
            <small>
              @{agent.handle} · {agent.enabled ? t("enabled") : t("disabled")}
            </small>
          </span>
        </button>
      ))}
    </aside>
  );
}
