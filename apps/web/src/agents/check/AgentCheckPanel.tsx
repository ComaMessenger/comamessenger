import { useState } from "react";
import { checkBlockerKeys, customExampleCount } from "@comamessenger/core";
import type {
  Agent,
  AgentRecipe,
  Chat,
  MessengerAPI,
} from "@comamessenger/core";
import { Eye, Play, Square } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  Avatar,
  Button,
  Chip,
  FormError,
  SelectField,
  Spinner,
  TextareaField,
} from "../../ui";
import type { PublishBlocker } from "../builder/useAgentBuilder";
import { blockID } from "../builder/BuilderBlock";
import { chatName } from "../shared/format";
import { CheckResult } from "./CheckResult";
import { useAgentCheck } from "./useAgentCheck";

const checkBlockers = checkBlockerKeys;

/**
 * The «Check» panel: ready examples of the role, the answer of the draft in
 * dry run and a human trace. Nothing is sent to chats.
 */
export function AgentCheckPanel({
  api,
  agent,
  recipe,
  chats,
  chatIDs,
  blockers,
  canCheck,
  prepare,
}: {
  api: MessengerAPI;
  agent: Agent;
  /** Ready examples and what a good answer does come from the recipe. */
  recipe?: AgentRecipe;
  chats: Chat[];
  /** Chats of the current draft. */
  chatIDs: string[];
  blockers: PublishBlocker[];
  canCheck: boolean;
  /** Saves unsaved edits so the check runs the draft people see. */
  prepare(): Promise<boolean>;
}) {
  const { t } = useTranslation();
  const check = useAgentCheck(api, agent);
  const agentChats = chats.filter((chat) => chatIDs.includes(chat.id));
  const [chatID, setChatID] = useState(agentChats[0]?.id ?? "");
  const [prompt, setPrompt] = useState("");
  const selectedChat =
    agentChats.find((chat) => chat.id === chatID) ?? agentChats[0];
  const blocking = blockers.filter((blocker) => checkBlockers.has(blocker.key));
  const examples = recipe
    ? recipe.checks
    : Array.from({ length: customExampleCount }, (_, index) => ({
        prompt: t(`agentExample_custom_${index + 1}`),
        expectations: [] as string[],
      }));
  const expected = examples.find(
    (example) => example.prompt === prompt,
  )?.expectations;

  async function start() {
    if (!selectedChat || !prompt.trim()) return;
    if (!(await prepare())) return;
    await check.start(selectedChat.id, prompt.trim());
  }

  return (
    <div className="agent-check">
      <header className="agent-check__head">
        <h3>{t("agentCheckTitle")}</h3>
        <p>{t("agentCheckLead")}</p>
      </header>
      {!canCheck ? (
        <p className="agent-muted">{t("agentCheckNoRights")}</p>
      ) : (
        <>
          <div
            className="agent-check__examples"
            role="group"
            aria-label={t("agentCheckExamples")}
          >
            <span>{t("agentCheckExamples")}</span>
            <div className="agent-chips">
              {examples.map((example) => (
                <Chip
                  key={example.prompt}
                  active={prompt === example.prompt}
                  onClick={() => setPrompt(example.prompt)}
                >
                  {example.prompt}
                </Chip>
              ))}
            </div>
            {expected && expected.length > 0 && (
              <div className="agent-check__expect">
                <span>{t("agentCheckExpect")}</span>
                <ul>
                  {expected.map((line) => (
                    <li key={line}>{line}</li>
                  ))}
                </ul>
              </div>
            )}
          </div>
          {agentChats.length > 1 && (
            <SelectField
              label={t("agentCheckChat")}
              name="agent-check-chat"
              value={selectedChat?.id ?? ""}
              onChange={(event) => setChatID(event.target.value)}
            >
              {agentChats.map((chat) => (
                <option key={chat.id} value={chat.id}>
                  {chatName(chat)}
                </option>
              ))}
            </SelectField>
          )}
          {selectedChat && agentChats.length === 1 && (
            <p className="agent-muted">
              {t("agentCheckInChat", { chat: chatName(selectedChat) })}
            </p>
          )}
          <TextareaField
            label={t("agentCheckMessage")}
            name="agent-check-message"
            rows={3}
            value={prompt}
            placeholder={t("agentCheckMessagePlaceholder")}
            onChange={(event) => setPrompt(event.target.value)}
          />
          {blocking.length > 0 && (
            <p className="agent-muted">{t("agentCheckNeeds")}</p>
          )}
          {blocking.length > 0 && (
            <ul className="agent-reasons">
              {blocking.map((blocker) => (
                <li key={blocker.key}>
                  <a
                    href={`#${blockID(blocker.anchor)}`}
                    onClick={(event) => {
                      event.preventDefault();
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
          )}
          <div className="agent-check__actions">
            {check.pending ? (
              <>
                <span className="agent-check__thinking" role="status">
                  <Spinner />
                  {t("agentCheckThinking")}
                </span>
                <Button size="sm" variant="ghost" onClick={check.stop}>
                  <Square />
                  {t("agentCheckStop")}
                </Button>
              </>
            ) : (
              <Button
                variant="primary"
                disabled={
                  blocking.length > 0 || !prompt.trim() || !selectedChat
                }
                onClick={() => void start()}
              >
                {check.run ? <Play /> : <Eye />}
                {check.run ? t("agentCheckAgain") : t("agentCheckRun")}
              </Button>
            )}
          </div>
          <FormError message={check.error} />
          {check.run && (
            <div className="agent-check__answer">
              <Avatar
                name={agent.display_name}
                seed={agent.id}
                actorID={agent.id}
                avatarVersion={agent.avatar_version}
                size="sm"
                agent
              />
              <CheckResult api={api} run={check.run} chat={selectedChat} />
            </div>
          )}
        </>
      )}
    </div>
  );
}
