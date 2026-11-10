import type { Chat } from "@comamessenger/core";
import { useTranslation } from "react-i18next";
import { BuilderBlock } from "./BuilderBlock";
import { ChatListEditor } from "./ChatListEditor";

/**
 * Block 5: chats the agent posts to. Where it reads is block 2; the server
 * checks both on every tool call.
 */
export function PlacesBlock({
  chats,
  chatIDs,
  onChange,
}: {
  chats: Chat[];
  chatIDs: string[];
  onChange(ids: string[]): void;
}) {
  const { t } = useTranslation();
  return (
    <BuilderBlock
      anchor="places"
      marker="5"
      title={t("agentBlockPlaces")}
      hint={t("agentBlockPlacesHint")}
    >
      <ChatListEditor
        name="agent-place-add"
        chats={chats}
        chatIDs={chatIDs}
        emptyText={t("agentPlacesEmpty")}
        addLabel={t("agentPlaceAdd")}
        onChange={onChange}
      />
    </BuilderBlock>
  );
}
