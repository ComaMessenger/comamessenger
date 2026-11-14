import { useEffect, useRef, useState, type FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type {
  Agent,
  AgentLlmConnection,
  ArchitectMessage,
  ArchitectSession,
  ArchitectTestExample,
  Chat,
  MessengerAPI,
} from "@comamessenger/core";
import {
  ArrowLeft,
  ChevronDown,
  Eye,
  PlugZap,
  RotateCcw,
  Send,
  Sparkles,
  Wrench,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  Avatar,
  Button,
  Chip,
  EmptyState,
  IconButton,
  InlineError,
  Skeleton,
  Spinner,
  cx,
} from "../../ui";
import { CheckResult } from "../check/CheckResult";
import { useAgentCheck } from "../check/useAgentCheck";
import type { AgentAccess } from "../shared/access";
import { formatCost } from "../shared/format";
import { Passport } from "./Passport";
import { useArchitect, type ArchitectProblem } from "./useArchitect";
import "./architect.css";

/**
 * `/agents/architect` and `/agents/:id/architect`: the conversation on the
 * left, the passport of the saved draft on the right (above the conversation
 * on a phone, folded).
 */
export function ArchitectPage({
  api,
  agentID,
  agents,
  chats,
  connections,
  access,
  timezone,
  refetchAgents,
  navigate,
}: {
  api: MessengerAPI;
  agentID: string | null;
  agents: Agent[];
  chats: Chat[];
  connections: AgentLlmConnection[];
  access: AgentAccess;
  timezone: string;
  refetchAgents(): Promise<unknown>;
  navigate(to: string): void;
}) {
  const { t, i18n } = useTranslation();
  const locale = i18n.language.startsWith("en") ? "en" : "ru";
  const queryClient = useQueryClient();
  const architect = useArchitect({
    api,
    agentID,
    locale,
    onDraft: (next: ArchitectSession) => {
      // The passport shows the saved draft: reread it after every answer.
      void refetchAgents();
      if (next.agent_id)
        void queryClient.invalidateQueries({
          queryKey: ["agent-triggers", next.agent_id],
        });
      // A new draft gets its own address so a reload resumes the same talk.
      if (!agentID && next.agent_id)
        navigate(`/agents/${next.agent_id}/architect`);
    },
  });
  const { session, problem, loading, sending } = architect;
  const draftID = session?.agent_id ?? agentID;
  const agent = agents.find((item) => item.id === draftID);
  const [draft, setDraft] = useState("");
  const [passportOpen, setPassportOpen] = useState(false);
  const bottom = useRef<HTMLDivElement>(null);

  const messageCount = session?.messages.length ?? 0;
  useEffect(() => {
    bottom.current?.scrollIntoView?.({ block: "end" });
  }, [messageCount, sending]);

  async function submit(text: string) {
    const value = text.trim();
    if (!value) return;
    if (await architect.send(value)) setDraft("");
    else setDraft(value);
  }

  if (!access.canBuild)
    return (
      <EmptyState title={t("errorForbidden")} hint={t("agentCheckNoRights")} />
    );
  if (loading && !session) return <Skeleton />;
  if (problem?.kind === "connection")
    return (
      <div className="architect-empty">
        <EmptyState
          icon={<PlugZap />}
          title={t("architectNoConnectionTitle")}
          hint={
            access.canIntegrate
              ? t("architectNoConnectionText")
              : t("architectNoConnectionAsk")
          }
          action={
            access.canIntegrate ? (
              <Button
                variant="primary"
                onClick={() => navigate("/agents/connections")}
              >
                {t("architectNoConnectionAction")}
              </Button>
            ) : undefined
          }
        />
      </div>
    );
  if (!session)
    return (
      <div className="architect-empty">
        <InlineError
          title={problemText(t, problem)}
          onRetry={() => void architect.retry()}
          retryLabel={t("architectRetry")}
        />
      </div>
    );

  const last = session.messages[session.messages.length - 1];
  const waitingForAnswer =
    last?.role === "assistant" && last.kind === "question";
  const finished = session.messages.some((message) => message.kind === "done");
  const open = session.status === "active";
  const left = session.max_questions - session.questions_asked;

  return (
    <div className="architect">
      <header className="architect__bar">
        <IconButton
          label={t("architectBack")}
          onClick={() => navigate(agentID ? `/agents/${agentID}` : "/agents")}
        >
          <ArrowLeft />
        </IconButton>
        <span className="architect__avatar" aria-hidden="true">
          <Sparkles />
        </span>
        <div className="architect__title">
          <h2>{t("architectTitle")}</h2>
          <span>
            {agent && agentID
              ? t("architectLeadExisting", { name: agent.display_name })
              : t("architectLead")}
          </span>
        </div>
        <Button
          variant="ghost"
          size="sm"
          disabled={Boolean(sending)}
          onClick={() => {
            setDraft("");
            void architect.restart();
          }}
        >
          <RotateCcw />
          {t("architectRestart")}
        </Button>
      </header>

      <div className="architect__layout">
        <aside
          className={cx(
            "architect__passport",
            passportOpen && "architect__passport--open",
          )}
          aria-label={t("passportTitle")}
        >
          <div className="architect__passport-sticky">
            <button
              type="button"
              className="architect__passport-toggle"
              aria-expanded={passportOpen}
              onClick={() => setPassportOpen((value) => !value)}
            >
              <span>
                <strong>{t("passportTitle")}</strong>
                <small>{t("passportLead")}</small>
              </span>
              <ChevronDown aria-hidden="true" />
            </button>
            <div className="architect__passport-body">
              <Passport
                api={api}
                agent={agent}
                chats={chats}
                connections={connections}
                timezone={timezone}
              />
            </div>
          </div>
        </aside>

        <section className="architect__talk" aria-label={t("architectTitle")}>
          <ol className="architect__messages">
            {session.messages.map((message, index) => (
              <MessageBubble
                key={message.id}
                message={message}
                answerable={
                  open &&
                  !sending &&
                  index === session.messages.length - 1 &&
                  waitingForAnswer
                }
                onPick={(option) => void submit(option)}
              />
            ))}
            {sending && (
              <>
                <li className="architect-bubble architect-bubble--me">
                  <span className="architect-bubble__text">{sending}</span>
                </li>
                <li className="architect-bubble" role="status">
                  <span className="architect-bubble__text architect-bubble__text--pending">
                    <Spinner />
                    {t("architectThinking")}
                  </span>
                </li>
              </>
            )}
          </ol>

          {finished && agent && (
            <ArchitectCheck
              api={api}
              agent={agent}
              chats={chats}
              examples={session.test_examples}
              navigate={navigate}
            />
          )}

          {problem && (
            <InlineError
              title={problemText(t, problem)}
              onRetry={
                problem.kind === "model" && draft
                  ? () => void submit(draft)
                  : undefined
              }
              retryLabel={t("architectRetry")}
            />
          )}

          {open ? (
            <form
              className="architect__composer"
              onSubmit={(event: FormEvent) => {
                event.preventDefault();
                void submit(draft);
              }}
            >
              {!finished && (
                <p className="architect__hint">
                  {t("architectQuestionsLeft", { count: Math.max(left, 0) })}
                </p>
              )}
              <div className="architect__input">
                <label className="visually-hidden" htmlFor="architect-input">
                  {t("architectInputLabel")}
                </label>
                <textarea
                  id="architect-input"
                  rows={2}
                  maxLength={4000}
                  value={draft}
                  disabled={Boolean(sending)}
                  placeholder={t("architectInputPlaceholder")}
                  onChange={(event) => setDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !event.shiftKey) {
                      event.preventDefault();
                      void submit(draft);
                    }
                  }}
                />
                <IconButton
                  label={t("architectSend")}
                  type="submit"
                  disabled={!draft.trim() || Boolean(sending)}
                >
                  <Send />
                </IconButton>
              </div>
              {session.connection.name && (
                <p className="architect__note">
                  {t("architectDataNote", { name: session.connection.name })}
                  {Number(session.usage.cost) > 0
                    ? ` ${t("architectUsage", {
                        cost: formatCost(
                          session.usage.cost,
                          session.usage.currency,
                          i18n.language,
                        ),
                      })}`
                    : ""}
                </p>
              )}
            </form>
          ) : (
            <div className="architect__over">
              <p>
                {session.status === "expired"
                  ? t("architectExpired")
                  : t("architectClosed")}
              </p>
              <Button
                variant="primary"
                onClick={() => void architect.restart()}
              >
                <RotateCcw />
                {t("architectRestart")}
              </Button>
            </div>
          )}
          <div ref={bottom} />
        </section>
      </div>
    </div>
  );
}

function problemText(
  t: (key: string) => string,
  problem: ArchitectProblem | null,
): string {
  switch (problem?.kind) {
    case "model":
      return t("architectModelError");
    case "budget":
      return t("architectBudgetError");
    case "busy":
      return t("architectBusyError");
    case "expired":
      return t("architectExpired");
    case "other":
      return problem.message;
    default:
      return t("error");
  }
}

function MessageBubble({
  message,
  answerable,
  onPick,
}: {
  message: ArchitectMessage;
  answerable: boolean;
  onPick(option: string): void;
}) {
  const { t } = useTranslation();
  const mine = message.role === "user";
  // The server sends `assumptions: null` for a message without them.
  const assumptions = message.assumptions ?? [];
  const options = message.options ?? [];
  return (
    <li
      className={cx(
        "architect-bubble",
        mine && "architect-bubble--me",
        message.kind === "done" && "architect-bubble--done",
      )}
    >
      {!mine && (
        <span
          className="architect__avatar architect__avatar--sm"
          aria-hidden="true"
        >
          <Sparkles />
        </span>
      )}
      <div className="architect-bubble__body">
        <span className="architect-bubble__text">{message.text}</span>
        {assumptions.length > 0 && (
          <div className="architect-bubble__assumptions">
            <strong>{t("architectAssumptions")}</strong>
            <ul>
              {assumptions.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </div>
        )}
        {answerable && options.length > 0 && (
          <div className="architect-bubble__options">
            {options.map((option) => (
              <Chip key={option} outline onClick={() => onPick(option)}>
                {option}
              </Chip>
            ))}
          </div>
        )}
      </div>
      {mine && <Avatar name={t("architectYou")} size="sm" />}
    </li>
  );
}

/** Examples the Architect proposed, a sandbox check of one of them, and the way to the builder. */
function ArchitectCheck({
  api,
  agent,
  chats,
  examples,
  navigate,
}: {
  api: MessengerAPI;
  agent: Agent;
  chats: Chat[];
  examples: ArchitectTestExample[];
  navigate(to: string): void;
}) {
  const { t } = useTranslation();
  const check = useAgentCheck(api, agent);
  const [selected, setSelected] = useState<number | null>(null);
  const agentChats = chats.filter((chat) => agent.chat_ids.includes(chat.id));
  const ready = agent.external_data_sharing_approved && agentChats.length > 0;

  function run(index: number) {
    const example = examples[index];
    if (!example) return;
    const chatID =
      example.chat_id && agent.chat_ids.includes(example.chat_id)
        ? example.chat_id
        : agentChats[0]?.id;
    if (!chatID) return;
    setSelected(index);
    void check.start(chatID, example.prompt);
  }
  const ran = selected === null ? undefined : examples[selected];

  return (
    <section
      className="architect-check"
      aria-label={t("architectExamplesTitle")}
    >
      <h3>{t("architectExamplesTitle")}</h3>
      <p className="architect__hint">{t("architectExamplesHint")}</p>
      <ol>
        {examples.map((example, index) => (
          <li key={`${index}-${example.prompt}`}>
            <div>
              <q>{example.prompt}</q>
              <small>
                {t("architectExpectation", { text: example.expectation })}
              </small>
            </div>
            {ready && (
              <Button
                size="sm"
                variant={index === 0 ? "primary" : "secondary"}
                pending={check.pending && selected === index}
                disabled={check.pending}
                onClick={() => run(index)}
              >
                <Eye />
                {t("architectCheck")}
              </Button>
            )}
          </li>
        ))}
      </ol>
      {!ready && (
        <p className="architect-check__blocked">
          {agentChats.length === 0
            ? t("agentBlocker_chat_required")
            : t("passportApprovalNeeded")}
        </p>
      )}
      {check.error && <InlineError title={check.error} />}
      {check.run && ran && (
        <CheckResult
          api={api}
          run={check.run}
          chat={chats.find((chat) => chat.id === check.run?.chat_id)}
        />
      )}
      <div className="architect-check__actions">
        <Button
          variant={ready ? "secondary" : "primary"}
          onClick={() =>
            navigate(ready ? `/agents/${agent.id}` : `/agents/${agent.id}/test`)
          }
        >
          <Wrench />
          {t("architectOpenBuilder")}
        </Button>
      </div>
    </section>
  );
}
