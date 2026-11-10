import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Plus } from "lucide-react";
import { APIError, type ChatAgent, type ChatMember } from "@comamessenger/core";
import { Avatar, Button, InlineError, SkeletonRow, cx } from "../ui";
import { hasPermission } from "../settings";
import { useMessenger } from "../shell/MessengerContext";
import { useToast } from "../shell/ToastProvider";
import { chatAgentsKey, useChatAgents } from "./useChatAgents";
import { describeActions, describeReads, describeTriggers } from "./describe";

const statusKey = {
  active: "acStatusActive",
  paused: "acStatusPaused",
  draft: "acStatusDraft",
  needs_attention: "acStatusAttention",
} as const;

/**
 * "Agents in this chat" inside the chat info dialog: what each agent reads,
 * what it may do and when it starts, with pause and settings for managers.
 */
export function ChatAgentsSection({
  chatID,
  members,
  onNavigate,
}: {
  chatID: string;
  members: ChatMember[];
  onNavigate(path: string): void;
}) {
  const { t } = useTranslation();
  const { user } = useMessenger();
  const { query, agents, hasAgents } = useChatAgents(chatID, members);
  const canBuild = hasPermission(user, "agents.build");
  if (!hasAgents && !canBuild) return null;
  return (
    <div className="chat-info__section chat-agents">
      <span className="chat-info__label">{t("acPanelTitle")}</span>
      {hasAgents && query.isLoading ? (
        <SkeletonRow avatar={32} />
      ) : hasAgents && query.isError ? (
        <InlineError title={t("acPanelLoadFailed")} retryLabel={t("retry")} onRetry={() => void query.refetch()} />
      ) : agents.length === 0 ? (
        <p className="chat-info__hint">{t("acPanelEmpty")}</p>
      ) : (
        <ul className="chat-agents__list">
          {agents.map((agent) => (
            <ChatAgentCard key={agent.agent_id} chatID={chatID} agent={agent} canBuild={canBuild} onNavigate={onNavigate} />
          ))}
        </ul>
      )}
      {canBuild && (
        <Button size="sm" variant="ghost" className="chat-agents__add" onClick={() => onNavigate("/agents")}>
          <Plus aria-hidden="true" />
          {t("acAddAgent")}
        </Button>
      )}
    </div>
  );
}

function ChatAgentCard({
  chatID,
  agent,
  canBuild,
  onNavigate,
}: {
  chatID: string;
  agent: ChatAgent;
  canBuild: boolean;
  onNavigate(path: string): void;
}) {
  const { t, i18n } = useTranslation();
  const { api } = useMessenger();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [pending, setPending] = useState(false);
  const reads = describeReads(agent, t);
  const actions = describeActions(agent, t);
  const triggers = describeTriggers(agent, t, i18n.language);
  const paused = agent.status === "paused";

  async function toggle() {
    setPending(true);
    try {
      if (paused) await api.resumeAgent(agent.agent_id);
      else await api.pauseAgent(agent.agent_id);
      toast({ message: t(paused ? "acResumed" : "acPaused", { name: agent.display_name }) });
      await queryClient.invalidateQueries({ queryKey: chatAgentsKey(chatID) });
    } catch (cause) {
      toast({
        message: cause instanceof APIError && cause.code === "agent_not_ready" ? t("acNotReady") : t("actionFailed"),
        tone: "danger",
      });
    } finally {
      setPending(false);
    }
  }

  return (
    <li className="chat-agents__item">
      <div className="chat-agents__head">
        <Avatar
          name={agent.display_name}
          seed={agent.agent_id}
          actorID={agent.agent_id}
          avatarVersion={agent.avatar_version}
          agent
          size="sm"
        />
        <span className="chat-agents__name">
          <strong className="truncate">{agent.display_name}</strong>
          {agent.description && <small className="clamp-2">{agent.description}</small>}
        </span>
        <span className={cx("agent-state", agent.status === "active" ? "agent-state--success" : "agent-state--neutral")}>
          {t(statusKey[agent.status])}
        </span>
      </div>
      <dl className="chat-agents__facts">
        <div>
          <dt>{t("acStarts")}</dt>
          <dd>{triggers.join("; ")}</dd>
        </div>
        {reads.length > 0 && (
          <div>
            <dt>{t("acReads")}</dt>
            <dd>{reads.join(", ")}</dd>
          </div>
        )}
        <div>
          <dt>{t("acDoes")}</dt>
          <dd>{actions.join(", ")}</dd>
        </div>
      </dl>
      {(agent.can_manage || canBuild) && (
        <div className="chat-agents__actions">
          {canBuild && (
            <Button size="sm" onClick={() => onNavigate(`/agents/${agent.agent_id}`)}>
              {t("acConfigure")}
            </Button>
          )}
          {agent.can_manage && (agent.status === "active" || paused) && (
            <Button size="sm" variant="ghost" pending={pending} onClick={() => void toggle()}>
              {paused ? t("acResume") : t("acPause")}
            </Button>
          )}
        </div>
      )}
    </li>
  );
}
