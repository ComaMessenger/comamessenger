import type { Chat, MessengerAPI } from "@comamessenger/core";
import {
  BookOpen,
  MessagesSquare,
  Paperclip,
  Search,
  Users,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { Switch, Tag } from "../../ui";
import {
  knowledgeSources,
  type Capabilities,
  type KnowledgeSource,
} from "../shared/capabilities";
import { chatName } from "../shared/format";
import { BlockLine, BuilderBlock } from "./BuilderBlock";
import { KnowledgeCollectionPicker } from "./KnowledgeCollectionPicker";

const sourceIcons: Record<KnowledgeSource, typeof Search> = {
  search: Search,
  files: Paperclip,
  members: Users,
};

/** Block 2: where the agent takes information from. */
export function KnowledgeBlock({
  api,
  chats,
  chatIDs,
  capabilities,
  collectionIDs,
  onCapabilities,
  onCollections,
}: {
  api: MessengerAPI;
  chats: Chat[];
  chatIDs: string[];
  capabilities: Capabilities;
  collectionIDs: string[];
  onCapabilities(value: Capabilities): void;
  onCollections(ids: string[]): void;
}) {
  const { t } = useTranslation();
  const names = chatIDs
    .map((id) => chats.find((chat) => chat.id === id))
    .filter((chat): chat is Chat => Boolean(chat))
    .map(chatName);
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
        hint={names.length ? names.join(", ") : t("agentKnowsChatsEmpty")}
      >
        <Tag>{t("agentAlways")}</Tag>
      </BlockLine>
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
        onChange={onCollections}
      />
    </BuilderBlock>
  );
}
