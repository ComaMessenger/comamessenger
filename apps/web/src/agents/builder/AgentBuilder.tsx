import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type {
  Agent,
  AgentLlmConnection,
  Chat,
  MessengerAPI,
} from "@comamessenger/core";
import { ArrowLeft, Pause, Play, Save, Send } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Avatar, Button, FormError, IconButton, InlineSuccess } from "../../ui";
import { AgentCheckPanel } from "../check/AgentCheckPanel";
import type { BuilderAnchor } from "../routes";
import type { AgentAccess } from "../shared/access";
import { AgentStatus } from "../shared/AgentStatus";
import {
  capabilitiesOf,
  scopesFor,
  type Capabilities,
} from "../shared/capabilities";
import { humanStatus } from "../shared/status";
import { AdvancedSettings } from "./AdvancedSettings";
import { blockID } from "./BuilderBlock";
import { IdentityBlock } from "./IdentityBlock";
import { KnowledgeBlock } from "./KnowledgeBlock";
import { ModelBlock } from "./ModelBlock";
import { PlacesBlock } from "./PlacesBlock";
import { SkillsBlock } from "./SkillsBlock";
import { TriggersBlock } from "./TriggersBlock";
import { publishBlockers, useAgentBuilder } from "./useAgentBuilder";
import { ExternalSystems } from "./ExternalSystems";
import { draftChatIDs } from "../shared/draft";

/**
 * The agent builder: one page of blocks with the check on the right. It is
 * mounted per agent (`key={agent.id}`), so its state never leaks between
 * agents.
 */
export function AgentBuilder({
  api,
  agent,
  access,
  chats,
  connections,
  timezone,
  anchor,
  refetchAgents,
  navigate,
}: {
  api: MessengerAPI;
  agent: Agent;
  access: AgentAccess;
  chats: Chat[];
  connections: AgentLlmConnection[];
  timezone: string;
  anchor: BuilderAnchor;
  refetchAgents(): Promise<unknown>;
  navigate(to: string): void;
}) {
  const { t, i18n } = useTranslation();
  const { canBuild, canPublish, canIntegrate } = access;
  const builder = useAgentBuilder({ api, agent, refetchAgents });
  const { draft, setDraft, dirty, pending } = builder;
  const [advancedOpen, setAdvancedOpen] = useState(anchor === "advanced");
  const triggers = useQuery({
    queryKey: ["agent-triggers", agent.id],
    queryFn: () => api.agentTriggers(agent.id),
  });
  const capabilities = useMemo(
    () => capabilitiesOf(draft.allowed_scopes),
    [draft.allowed_scopes],
  );
  const blockers = publishBlockers(agent, draft, triggers.data, connections);
  const nothingToPublish = !dirty && !agent.has_unpublished_changes;
  const publishReason = !canPublish
    ? t("agentPublishNoRights")
    : nothingToPublish
      ? agent.published_version
        ? t("agentPublishUpToDate")
        : null
      : null;

  useEffect(() => {
    if (anchor === "top") return;
    if (anchor === "advanced") setAdvancedOpen(true);
    const frame = window.requestAnimationFrame(() =>
      document
        .getElementById(blockID(anchor))
        ?.scrollIntoView({ block: "start" }),
    );
    return () => window.cancelAnimationFrame(frame);
  }, [anchor]);

  function setCapabilities(value: Capabilities) {
    setDraft({
      ...draft,
      allowed_scopes: scopesFor({
        capabilities: value,
        hasKnowledge: (draft.knowledge_collection_ids ?? []).length > 0,
        current: draft.allowed_scopes,
      }),
    });
  }
  const chatIDs = draftChatIDs(draft);
  const readChatIDs = draft.read_chat_ids ?? draft.chat_ids;
  const writeChatIDs = draft.write_chat_ids ?? draft.chat_ids;
  function setChats(read: string[], write: string[]) {
    setDraft({
      ...draft,
      read_chat_ids: read,
      write_chat_ids: write,
      chat_ids: [...new Set([...read, ...write])].sort(),
    });
  }
  function setTables(enabled: boolean, collectionIDs: string[]) {
    setDraft({
      ...draft,
      knowledge_collection_ids: collectionIDs,
      allowed_scopes: scopesFor({
        capabilities,
        hasKnowledge: collectionIDs.length > 0,
        hasTables: enabled,
        current: draft.allowed_scopes,
      }),
    });
  }
  function setCollections(ids: string[]) {
    setDraft({
      ...draft,
      knowledge_collection_ids: ids,
      allowed_scopes: scopesFor({
        capabilities,
        hasKnowledge: ids.length > 0,
        current: draft.allowed_scopes,
      }),
    });
  }

  const status = humanStatus(agent);
  const publishedAt = agent.published_at
    ? new Date(agent.published_at).toLocaleDateString(i18n.language, {
        day: "numeric",
        month: "long",
      })
    : "";

  return (
    <div className="agent-builder">
      <header className="agent-builder__bar" id={blockID("top")}>
        <IconButton
          label={t("agentBackToCatalog")}
          onClick={() => navigate("/agents")}
        >
          <ArrowLeft />
        </IconButton>
        <Avatar
          name={agent.display_name}
          seed={agent.id}
          actorID={agent.id}
          avatarVersion={agent.avatar_version}
          agent
        />
        <div className="agent-builder__title">
          <h2>{agent.display_name}</h2>
          <span>
            <AgentStatus status={status} />
            <small>
              {dirty
                ? t("agentStateUnsaved")
                : agent.published_version
                  ? agent.has_unpublished_changes
                    ? t("agentStateDraftDiffers", {
                        version: agent.published_version,
                      })
                    : t("agentStatePublished", {
                        version: agent.published_version,
                        date: publishedAt,
                      })
                  : t("agentStateNeverPublished")}
            </small>
          </span>
        </div>
        <div className="agent-builder__actions">
          {canBuild && dirty && (
            <Button
              variant="ghost"
              pending={pending === "save"}
              disabled={Boolean(pending)}
              onClick={() => void builder.save()}
            >
              <Save />
              {t("agentSaveDraft")}
            </Button>
          )}
          {canPublish && agent.operational_status === "active" && !dirty && (
            <Button
              variant="ghost"
              pending={pending === "pause"}
              disabled={Boolean(pending)}
              onClick={() => void builder.pause()}
            >
              <Pause />
              {t("agentPause")}
            </Button>
          )}
          {canPublish && agent.operational_status === "paused" && !dirty && (
            <Button
              variant="ghost"
              pending={pending === "resume"}
              disabled={Boolean(pending) || blockers.length > 0}
              onClick={() => void builder.resume()}
            >
              <Play />
              {t("agentResume")}
            </Button>
          )}
          <Button
            variant="primary"
            pending={pending === "publish"}
            disabled={
              Boolean(pending) ||
              !canPublish ||
              nothingToPublish ||
              blockers.length > 0
            }
            aria-describedby="agent-publish-reason"
            onClick={() => void builder.publish()}
          >
            <Send />
            {t("agentPublish")}
          </Button>
        </div>
      </header>
      <div
        id="agent-publish-reason"
        className={
          publishReason
            ? "agent-builder__reasons agent-builder__reasons--quiet"
            : "agent-builder__reasons"
        }
      >
        {publishReason ? (
          <p>{publishReason}</p>
        ) : blockers.length > 0 ? (
          <>
            <p>{t("agentPublishNeeds")}</p>
            <ul className="agent-reasons">
              {blockers.map((blocker) => (
                <li key={blocker.key}>
                  <a
                    href={`#${blockID(blocker.anchor)}`}
                    onClick={(event) => {
                      event.preventDefault();
                      if (blocker.anchor === "advanced") setAdvancedOpen(true);
                      document
                        .getElementById(blockID(blocker.anchor))
                        ?.scrollIntoView({
                          behavior: "smooth",
                          block: "start",
                        });
                    }}
                  >
                    {t(`agentBlocker_${blocker.key}`)}
                  </a>
                </li>
              ))}
            </ul>
          </>
        ) : null}
      </div>
      <div className="agent-builder__messages">
        <FormError message={builder.error} />
        {builder.notice && <InlineSuccess title={builder.notice} />}
      </div>
      <div className="agent-builder__layout">
        <div className="agent-builder__blocks">
          <fieldset disabled={!canBuild} className="agent-fieldset">
            <IdentityBlock agent={agent} draft={draft} onChange={setDraft} />
            <KnowledgeBlock
              api={api}
              chats={chats}
              readChatIDs={readChatIDs}
              capabilities={capabilities}
              collectionIDs={draft.knowledge_collection_ids ?? []}
              canManageKnowledge={access.canManageKnowledge}
              tables={draft.allowed_scopes.includes("tables:read")}
              onReadChats={(ids) => setChats(ids, writeChatIDs)}
              onCapabilities={setCapabilities}
              onCollections={setCollections}
              onTables={setTables}
            />
            <SkillsBlock
              capabilities={capabilities}
              onChange={setCapabilities}
              policy={draft.confirmation_policy}
              locked={agent.confirmation_locked}
              onPolicy={(confirmation_policy) =>
                setDraft({ ...draft, confirmation_policy })
              }
            >
              <ExternalSystems
                api={api}
                bindings={draft.mcp_bindings ?? []}
                onChange={(mcp_bindings) => setDraft({ ...draft, mcp_bindings })}
              />
            </SkillsBlock>
            <TriggersBlock
              api={api}
              agent={agent}
              chats={chats}
              chatIDs={writeChatIDs}
              triggers={triggers}
              timezone={timezone}
            />
            <PlacesBlock
              chats={chats}
              chatIDs={writeChatIDs}
              onChange={(ids) =>
                setChats(
                  // A new place is also read: the agent sees the chat it
                  // answers in. Removing it from sources is block 2.
                  [
                    ...readChatIDs,
                    ...ids.filter(
                      (id) => !writeChatIDs.includes(id) && !readChatIDs.includes(id),
                    ),
                  ],
                  ids,
                )
              }
            />
            {agent.kind === "builtin" && (
              <ModelBlock
                api={api}
                draft={draft}
                chats={chats}
                connections={connections}
                capabilities={capabilities}
                canIntegrate={canIntegrate}
                onChange={setDraft}
                navigate={navigate}
              />
            )}
          </fieldset>
          <AdvancedSettings
            api={api}
            agent={agent}
            draft={draft}
            builder={builder}
            open={advancedOpen}
            onToggle={setAdvancedOpen}
            canBuild={canBuild}
            canPublish={canPublish}
            navigate={navigate}
            refetchAgents={refetchAgents}
          />
        </div>
        <aside className="agent-builder__check" id={blockID("check")}>
          <AgentCheckPanel
            api={api}
            agent={agent}
            chats={chats}
            chatIDs={chatIDs}
            blockers={blockers}
            canCheck={canBuild}
            prepare={builder.saveIfDirty}
          />
        </aside>
      </div>
    </div>
  );
}
