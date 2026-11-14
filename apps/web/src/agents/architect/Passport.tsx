import type { ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { passportItems } from "@comamessenger/core";
import type {
  Agent,
  AgentLlmConnection,
  Chat,
  MessengerAPI,
} from "@comamessenger/core";
import { CheckCircle2, Circle, ShieldCheck } from "lucide-react";
import { useTranslation } from "react-i18next";
import { collectionsKey } from "../../knowledge/shared";

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

  const items: Array<{ key: string; title: string; body: ReactNode }> =
    passportItems(t, {
      agent,
      chats,
      connections,
      collections: collections.data,
      triggers: triggers.data,
      timezone,
    }).map((item) => ({
      key: item.key,
      title: t(item.title),
      body:
        item.body === null ? null : item.key === "who" ? (
          <>
            <strong>{item.name}</strong> — {item.body}
          </>
        ) : item.key === "when" ? (
          <ul>
            {item.rules?.map((rule) => (
              <li key={rule}>{rule}</li>
            ))}
          </ul>
        ) : item.key === "model" ? (
          <>
            {item.body}
            <small>
              {item.approved
                ? t("passportApproved")
                : t("passportApprovalNeeded")}
            </small>
          </>
        ) : (
          item.body
        ),
    }));
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
