import { useQuery } from "@tanstack/react-query";
import type {
  AgentLlmConnection,
  Chat,
  MessengerAPI,
} from "@comamessenger/core";
import { Cloud, Eye, Plug } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button, SelectField, Switch, cx } from "../../ui";
import type { Capabilities } from "../shared/capabilities";
import type { Draft } from "../shared/draft";
import { chatName } from "../shared/format";
import { BlockLine, BuilderBlock } from "./BuilderBlock";

/**
 * Block 6: the workspace model connection and, in one explicit sentence, what
 * leaves the workspace for the external model.
 */
export function ModelBlock({
  api,
  draft,
  chats,
  connections,
  capabilities,
  canIntegrate,
  onChange,
  navigate,
}: {
  api: MessengerAPI;
  draft: Draft;
  chats: Chat[];
  connections: AgentLlmConnection[];
  capabilities: Capabilities;
  canIntegrate: boolean;
  onChange(draft: Draft): void;
  navigate(to: string): void;
}) {
  const { t } = useTranslation();
  const enabled = connections.filter((connection) => connection.enabled);
  const current = connections.find(
    (connection) => connection.id === draft.llm_connection_id,
  );
  const collections = useQuery({
    queryKey: ["knowledge-collections"],
    queryFn: () => api.knowledgeCollections(),
    enabled: (draft.knowledge_collection_ids ?? []).length > 0,
  });
  const choose = (connection: AgentLlmConnection | undefined) =>
    onChange({
      ...draft,
      llm_connection_id: connection?.id ?? "",
      provider: connection?.provider ?? draft.provider,
      endpoint_url: connection ? "" : draft.endpoint_url,
      model: connection?.default_model || draft.model || "",
    });

  const chatNames = draft.chat_ids
    .map((id) => chats.find((chat) => chat.id === id))
    .filter((chat): chat is Chat => Boolean(chat))
    .map((chat) => `«${chatName(chat)}»`);
  const collectionNames = (draft.knowledge_collection_ids ?? []).map(
    (id) =>
      `«${collections.data?.find((item) => item.id === id)?.name ?? t("agentKnowledgeUnavailable")}»`,
  );
  const parts = [
    chatNames.length
      ? t("agentDataChats", { chats: chatNames.join(", ") })
      : t("agentDataNoChats"),
    capabilities.sources.includes("files") ? t("agentDataFiles") : "",
    capabilities.sources.includes("members") ? t("agentDataMembers") : "",
    collectionNames.length
      ? t("agentDataKnowledge", { collections: collectionNames.join(", ") })
      : "",
  ].filter(Boolean);

  return (
    <BuilderBlock
      anchor="model"
      marker={<Cloud />}
      title={t("agentBlockModel")}
      hint={t("agentBlockModelHint")}
    >
      {enabled.length === 0 && !current ? (
        <BlockLine
          icon={<Plug />}
          title={t("agentModelMissing")}
          hint={
            canIntegrate
              ? t("agentModelMissingHint")
              : t("agentModelMissingAskAdmin")
          }
        >
          {canIntegrate && (
            <Button size="sm" onClick={() => navigate("/agents/connections")}>
              {t("agentModelConnect")}
            </Button>
          )}
        </BlockLine>
      ) : enabled.length > 1 || !current ? (
        <SelectField
          label={t("agentModelConnection")}
          name="agent-model-connection"
          value={draft.llm_connection_id ?? ""}
          onChange={(event) =>
            choose(enabled.find((item) => item.id === event.target.value))
          }
        >
          <option value="">{t("agentModelChoose")}</option>
          {enabled.map((connection) => (
            <option key={connection.id} value={connection.id}>
              {connection.name}
            </option>
          ))}
        </SelectField>
      ) : null}
      {current && (
        <BlockLine
          icon={<Cloud />}
          title={current.name}
          hint={t("agentModelExternal")}
        >
          <span
            className={cx(
              "agent-status",
              `agent-status--${
                !current.enabled
                  ? "danger"
                  : current.health_status === "healthy"
                    ? "success"
                    : current.health_status === "unhealthy"
                      ? "danger"
                      : "neutral"
              }`,
            )}
          >
            <i aria-hidden="true" />
            {current.enabled
              ? t(`agentModelHealth_${current.health_status}`)
              : t("agentModelDisabled")}
          </span>
        </BlockLine>
      )}
      <div className="agent-consent">
        <BlockLine
          title={t("agentDataConsent")}
          hint={t("agentDataConsentHint")}
        >
          <Switch
            label={t("agentDataConsent")}
            checked={draft.external_data_sharing_approved}
            onChange={(value) =>
              onChange({ ...draft, external_data_sharing_approved: value })
            }
          />
        </BlockLine>
        <p className="agent-notice">
          <Eye aria-hidden="true" />
          <span>{t("agentDataSentence", { parts: parts.join("; ") })}</span>
        </p>
      </div>
    </BuilderBlock>
  );
}
