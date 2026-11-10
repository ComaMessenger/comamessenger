import type {
  Agent,
  AgentToolConfirmation,
  Chat,
} from "@comamessenger/core";
import {
  AlertTriangle,
  BookOpen,
  FileText,
  MessageSquareText,
  Plus,
  ShieldCheck,
  Sparkles,
  UserRoundPlus,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { Avatar, Button } from "../../ui";
import type { AgentTemplate } from "../agentTemplates";
import type { AgentAccess } from "../shared/access";
import { AgentStatus } from "../shared/AgentStatus";
import { toolLabel } from "../shared/format";
import { humanStatus } from "../shared/status";
import { agentPlaces, agentTask } from "../shared/summary";

const roles = [
  ["summarizer", FileText],
  ["qa", BookOpen],
  ["onboarding", UserRoundPlus],
] as const;

/** `/agents`: what agents exist, what waits for people, where to start. */
export function AgentCatalog({
  agents,
  chats,
  approvals,
  access,
  onCreate,
  navigate,
}: {
  agents: Agent[];
  chats: Chat[];
  approvals: AgentToolConfirmation[];
  access: AgentAccess;
  onCreate(template: AgentTemplate): void;
  navigate(to: string): void;
}) {
  const { t } = useTranslation();
  const { canBuild, canApprove } = access;
  const pendingByAgent = new Map<string, number>();
  for (const approval of approvals)
    pendingByAgent.set(
      approval.agent_id,
      (pendingByAgent.get(approval.agent_id) ?? 0) + 1,
    );
  const working = agents.filter(
    (agent) => humanStatus(agent).kind === "working",
  ).length;
  const nameOf = (id: string) =>
    agents.find((agent) => agent.id === id)?.display_name ?? t("agentUnknown");
  return (
    <div className="agent-page">
      <div className="agent-page__head">
        <div>
          <h2>
            {t("agentCatalogTitle")}
            {agents.length > 0 && (
              <small>{t("agentWorkingCount", { count: working })}</small>
            )}
          </h2>
          <p>{t("agentCatalogLead")}</p>
        </div>
        {canBuild && (
          <Button variant="primary" onClick={() => onCreate("custom")}>
            <Plus />
            {t("agentBuildManually")}
          </Button>
        )}
      </div>

      {canApprove && approvals.length > 0 && (
        <div className="agent-attention" role="status">
          <AlertTriangle aria-hidden="true" />
          <span>
            <strong>
              {t("agentApprovalsWaiting", { count: approvals.length })}
            </strong>{" "}
            {approvals
              .slice(0, 2)
              .map(
                (approval) =>
                  `${nameOf(approval.agent_id)}: ${toolLabel(t, approval.tool_name).toLowerCase()}`,
              )
              .join("; ")}
            {approvals.length > 2 ? "…" : ""}
          </span>
          <Button size="sm" onClick={() => navigate("/agents/approvals")}>
            {t("agentApprovalsOpen")}
          </Button>
        </div>
      )}

      {agents.length > 0 ? (
        <section className="agent-section" aria-label={t("agentCatalogTitle")}>
          <div className="agent-card-grid">
            {agents.map((agent) => {
              const status = humanStatus(agent, pendingByAgent.get(agent.id));
              return (
                <button
                  key={agent.id}
                  className="agent-card"
                  onClick={() => navigate(`/agents/${agent.id}`)}
                >
                  <span className="agent-card__head">
                    <Avatar
                      name={agent.display_name}
                      seed={agent.id}
                      actorID={agent.id}
                      avatarVersion={agent.avatar_version}
                      agent
                    />
                    <span>
                      <strong>{agent.display_name}</strong>
                      <AgentStatus status={status} withReason />
                    </span>
                  </span>
                  <span className="agent-card__task">{agentTask(t, agent)}</span>
                  <span className="agent-card__foot">
                    <span>{agentPlaces(t, agent, chats)}</span>
                    <span>
                      {agent.published_version
                        ? t("agentVersionShort", {
                            version: agent.published_version,
                          })
                        : t("agentNotPublished")}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
        </section>
      ) : (
        <section className="agent-intro">
          <span className="agent-intro__icon" aria-hidden="true">
            <Sparkles />
          </span>
          <div>
            <h3>{t("agentIntroTitle")}</h3>
            <p>{t("agentIntroText")}</p>
            {canBuild ? (
              <ol>
                <li>
                  <MessageSquareText aria-hidden="true" />
                  {t("agentIntroStep1")}
                </li>
                <li>
                  <ShieldCheck aria-hidden="true" />
                  {t("agentIntroStep2")}
                </li>
                <li>
                  <Sparkles aria-hidden="true" />
                  {t("agentIntroStep3")}
                </li>
              </ol>
            ) : (
              <p>{t("agentIntroReadOnly")}</p>
            )}
          </div>
        </section>
      )}

      {canBuild && (
        <section className="agent-section">
          <div className="agent-section__title">
            <h3>{t("agentRolesTitle")}</h3>
            <span>{t("agentRolesLead")}</span>
          </div>
          <div className="agent-role-grid">
            {roles.map(([role, Icon]) => (
              <button
                key={role}
                className="agent-role"
                onClick={() => onCreate(role)}
              >
                <span className="agent-role__icon" data-role={role}>
                  <Icon aria-hidden="true" />
                </span>
                <strong>{t(`agentTemplate_${role}`)}</strong>
                <span>{t(`agentRoleTask_${role}`)}</span>
                <q>{t(`agentRoleExample_${role}`)}</q>
              </button>
            ))}
            <button className="agent-role" onClick={() => onCreate("custom")}>
              <span className="agent-role__icon" data-role="custom">
                <Plus aria-hidden="true" />
              </span>
              <strong>{t("agentRoleCustom")}</strong>
              <span>{t("agentRoleCustomTask")}</span>
              <q>{t("agentRoleExample_custom")}</q>
            </button>
          </div>
        </section>
      )}
    </div>
  );
}
