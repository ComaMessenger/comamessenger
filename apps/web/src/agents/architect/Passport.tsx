import type { ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import type {
  Agent,
  AgentLlmConnection,
  Chat,
  MessengerAPI,
} from "@comamessenger/core";
import { CheckCircle2, Circle, ShieldCheck } from "lucide-react";
import { useTranslation } from "react-i18next";
import { collectionsKey } from "../../knowledge/shared";
import { capabilitiesOf } from "../shared/capabilities";
import { chatName } from "../shared/format";
import { agentTask } from "../shared/summary";
import { describeRule } from "../shared/triggers";

/*
 * The passport reads the saved draft from the server (agent, launch rules,
 * chats, collections) — never what the model said it did. An empty item
 * means the draft has nothing there yet.
 */
export function Passport({
  api,
  agent,
  chats,
  connections,
  timezone,
}: {
  api: MessengerAPI;
  agent: Agent | undefined;
  chats: Chat[];
  connections: AgentLlmConnection[];
  timezone: string;
}) {
  const { t } = useTranslation();
  const triggers = useQuery({
    queryKey: ["agent-triggers", agent?.id],
    queryFn: () => api.agentTriggers(agent!.id),
    enabled: Boolean(agent),
  });
  const collections = useQuery({
    queryKey: collectionsKey,
    queryFn: () => api.knowledgeCollections(),
    enabled: Boolean(agent?.knowledge_collection_ids?.length),
  });

  const capabilities = agent ? capabilitiesOf(agent.allowed_scopes) : null;
  const collectionIDs = agent?.knowledge_collection_ids ?? [];
  const knownCollections = collectionIDs
    .map((id) => collections.data?.find((item) => item.id === id)?.name)
    .filter((name): name is string => Boolean(name));
  const hiddenCollections = collections.data
    ? collectionIDs.length - knownCollections.length
    : 0;
  const knownChats = (agent?.chat_ids ?? [])
    .map((id) => chats.find((chat) => chat.id === id))
    .filter((chat): chat is Chat => Boolean(chat));
  const hiddenChats = (agent?.chat_ids.length ?? 0) - knownChats.length;
  const connection = connections.find(
    (item) => item.id === agent?.llm_connection_id,
  );
  const rules = (triggers.data ?? []).filter((rule) => rule.enabled);

  const knows: string[] = [];
  if (capabilities) {
    for (const source of capabilities.sources)
      knows.push(t(`agentSource_${source}`));
    if (knownCollections.length > 0)
      knows.push(
        t("passportKnowledge", { names: knownCollections.join(", ") }),
      );
    if (hiddenCollections > 0)
      knows.push(t("passportHiddenItems", { count: hiddenCollections }));
  }

  const items: Array<{ key: string; title: string; body: ReactNode }> = [
    {
      key: "who",
      title: t("passportWho"),
      body: agent ? (
        <>
          <strong>{agent.display_name}</strong> — {agentTask(t, agent)}
        </>
      ) : null,
    },
    {
      key: "knows",
      title: t("passportKnows"),
      body: knows.length > 0 ? knows.join("; ") : null,
    },
    {
      key: "can",
      title: t("passportCan"),
      body: capabilities
        ? capabilities.skills.length > 0
          ? capabilities.skills
              .map((skill) => t(`agentSkill_${skill}`))
              .join("; ")
          : t("passportOnlyReads")
        : null,
    },
    {
      key: "when",
      title: t("passportWhen"),
      body:
        rules.length > 0 ? (
          <ul>
            {rules.map((rule) => {
              const sentence = describeRule(t, rule, chats, timezone);
              return (
                <li key={rule.id}>
                  {sentence.when}
                  {sentence.then ? ` → ${sentence.then}` : ""}
                </li>
              );
            })}
          </ul>
        ) : null,
    },
    {
      key: "where",
      title: t("passportWhere"),
      body:
        knownChats.length > 0 || hiddenChats > 0
          ? [
              knownChats.map(chatName).join(", "),
              hiddenChats > 0
                ? t("passportHiddenItems", { count: hiddenChats })
                : "",
            ]
              .filter(Boolean)
              .join(" ")
          : null,
    },
    {
      key: "model",
      title: t("passportModel"),
      body:
        agent && connection ? (
          <>
            {t("passportModelText", {
              name: connection.name,
              model: agent.model || connection.default_model,
            })}
            <small>
              {agent.external_data_sharing_approved
                ? t("passportApproved")
                : t("passportApprovalNeeded")}
            </small>
          </>
        ) : null,
    },
  ];
  const done = items.filter((item) => item.body !== null).length;

  return (
    <div className="architect-passport">
      <div className="architect-passport__progress">
        <span>{t("passportProgress", { done, total: items.length })}</span>
        <div
          className="architect-progress"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={items.length}
          aria-valuenow={done}
          aria-label={t("passportTitle")}
        >
          <i style={{ width: `${(done / items.length) * 100}%` }} />
        </div>
      </div>
      <ul className="architect-passport__items">
        {items.map((item) => (
          <li
            key={item.key}
            className={item.body !== null ? "is-done" : undefined}
            data-item={item.key}
          >
            {item.body !== null ? (
              <CheckCircle2 aria-hidden="true" />
            ) : (
              <Circle aria-hidden="true" />
            )}
            <div>
              <b>{item.title}</b>
              <span>{item.body ?? <em>{t("passportEmpty")}</em>}</span>
            </div>
          </li>
        ))}
      </ul>
      {agent && (
        <p className="architect-passport__rights">
          <ShieldCheck aria-hidden="true" />
          <span>{t("passportRights")}</span>
        </p>
      )}
    </div>
  );
}
