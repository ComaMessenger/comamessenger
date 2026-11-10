import { useQueries, useQuery } from "@tanstack/react-query";
import type {
  Chat,
  KnowledgeDocument,
  MessengerAPI,
} from "@comamessenger/core";
import {
  BookOpen,
  MessagesSquare,
  Paperclip,
  Search,
  Sheet,
  Users,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { collectionsKey, documentsKey } from "../../knowledge/shared";
import { SelectField, Switch } from "../../ui";
import {
  knowledgeSources,
  type Capabilities,
  type KnowledgeSource,
} from "../shared/capabilities";
import { BlockLine, BuilderBlock } from "./BuilderBlock";
import { ChatListEditor } from "./ChatListEditor";
import { KnowledgeCollectionPicker } from "./KnowledgeCollectionPicker";

const sourceIcons: Record<KnowledgeSource, typeof Search> = {
  search: Search,
  files: Paperclip,
  members: Users,
};

/** Spreadsheets `query_table` can read: CSV and XLSX files. */
export function isSpreadsheet(document: KnowledgeDocument): boolean {
  const name = (document.file_name ?? document.title).toLowerCase();
  const mime = document.file_mime ?? "";
  return (
    document.kind === "file" &&
    (name.endsWith(".csv") ||
      name.endsWith(".xlsx") ||
      mime === "text/csv" ||
      mime ===
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
  );
}

/**
 * Block 2: where the agent takes information from — the chats it reads, its
 * own search, the knowledge base and spreadsheets from it.
 */
export function KnowledgeBlock({
  api,
  chats,
  readChatIDs,
  capabilities,
  collectionIDs,
  canManageKnowledge,
  tables,
  onReadChats,
  onCapabilities,
  onCollections,
  onTables,
}: {
  api: MessengerAPI;
  chats: Chat[];
  readChatIDs: string[];
  capabilities: Capabilities;
  collectionIDs: string[];
  canManageKnowledge: boolean;
  /** Whether the agent reads spreadsheets of its collections. */
  tables: boolean;
  onReadChats(ids: string[]): void;
  onCapabilities(value: Capabilities): void;
  onCollections(ids: string[]): void;
  onTables(value: boolean, collectionIDs: string[]): void;
}) {
  const { t } = useTranslation();
  const collections = useQuery({
    queryKey: collectionsKey,
    queryFn: () => api.knowledgeCollections(),
  });
  const documents = useQueries({
    queries: (collections.data ?? []).map((collection) => ({
      queryKey: documentsKey(collection.id),
      queryFn: () => api.knowledgeDocuments(collection.id),
    })),
  });
  const spreadsheets = documents
    .flatMap((query) => query.data ?? [])
    .filter(isSpreadsheet);
  const bound = spreadsheets.filter((document) =>
    collectionIDs.includes(document.collection_id),
  );
  const collectionName = (id: string) =>
    collections.data?.find((collection) => collection.id === id)?.name ?? "";
  return (
    <BuilderBlock
      anchor="knowledge"
      marker="2"
      title={t("agentBlockKnowledge")}
      hint={t("agentBlockKnowledgeHint")}
    >
      <BlockLine
        icon={<MessagesSquare />}
        title={t("agentKnowsChats")}
        hint={t("agentKnowsChatsHint")}
      />
      <ChatListEditor
        name="agent-read-chat-add"
        chats={chats}
        chatIDs={readChatIDs}
        emptyText={t("agentKnowsChatsEmpty")}
        addLabel={t("agentKnowsChatsAdd")}
        onChange={onReadChats}
      />
      {knowledgeSources.map((source) => {
        const Icon = sourceIcons[source];
        const checked = capabilities.sources.includes(source);
        return (
          <BlockLine
            key={source}
            icon={<Icon />}
            title={t(`agentSource_${source}`)}
            hint={t(`agentSourceHint_${source}`)}
          >
            <Switch
              label={t(`agentSource_${source}`)}
              checked={checked}
              onChange={(value) =>
                onCapabilities({
                  ...capabilities,
                  sources: value
                    ? [...capabilities.sources, source]
                    : capabilities.sources.filter((item) => item !== source),
                })
              }
            />
          </BlockLine>
        );
      })}
      <div className="agent-block__sub">
        <BookOpen aria-hidden="true" />
        <span>
          <strong>{t("agentKnowledgeBase")}</strong>
          <small>{t("agentKnowledgeBaseHint")}</small>
        </span>
      </div>
      <KnowledgeCollectionPicker
        api={api}
        selected={collectionIDs}
        canManage={canManageKnowledge}
        onChange={onCollections}
      />
      <BlockLine
        icon={<Sheet />}
        title={t("agentTables")}
        hint={
          bound.length
            ? t("agentTablesList", {
                names: bound.map((document) => document.title).join(", "),
              })
            : t("agentTablesNone")
        }
      >
        <Switch
          label={t("agentTables")}
          checked={tables}
          onChange={(value) => onTables(value, collectionIDs)}
        />
      </BlockLine>
      {spreadsheets.some(
        (document) => !collectionIDs.includes(document.collection_id),
      ) && (
        <SelectField
          required={false}
          label={t("agentTablesAdd")}
          name="agent-table-add"
          value=""
          onChange={(event) => {
            const chosen = spreadsheets.find(
              (document) => document.id === event.target.value,
            );
            if (chosen)
              onTables(true, [...collectionIDs, chosen.collection_id]);
          }}
        >
          <option value="">{t("agentTablesChoose")}</option>
          {spreadsheets
            .filter(
              (document) => !collectionIDs.includes(document.collection_id),
            )
            .map((document) => (
              <option key={document.id} value={document.id}>
                {t("agentTableOption", {
                  name: document.title,
                  collection: collectionName(document.collection_id),
                })}
              </option>
            ))}
        </SelectField>
      )}
    </BuilderBlock>
  );
}
