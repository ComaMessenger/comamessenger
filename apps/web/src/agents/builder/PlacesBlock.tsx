import type { Chat } from "@comamessenger/core";
import { useTranslation } from "react-i18next";
import { Chip, SelectField } from "../../ui";
import { chatName } from "../shared/format";
import { BuilderBlock } from "./BuilderBlock";

/** Block 5: chats the agent is a member of; it reads and writes only there. */
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
  const available = chats.filter((chat) => !chatIDs.includes(chat.id));
  return (
    <BuilderBlock
      anchor="places"
      marker="5"
      title={t("agentBlockPlaces")}
      hint={t("agentBlockPlacesHint")}
    >
      {chatIDs.length > 0 ? (
        <div className="agent-chips">
          {chatIDs.map((id) => {
            const chat = chats.find((item) => item.id === id);
            const name = chat ? chatName(chat) : t("agentChatHidden");
            return (
              <Chip
                key={id}
                active
                onRemove={() => onChange(chatIDs.filter((item) => item !== id))}
                removeLabel={t("agentPlaceRemove", { name })}
              >
                {name}
              </Chip>
            );
          })}
        </div>
      ) : (
        <p className="agent-block__empty">{t("agentPlacesEmpty")}</p>
      )}
      {available.length > 0 && (
        <SelectField
          required={false}
          label={t("agentPlaceAdd")}
          name="agent-place-add"
          value=""
          onChange={(event) => {
            if (event.target.value) onChange([...chatIDs, event.target.value]);
          }}
        >
          <option value="">{t("agentChooseChat")}</option>
          {available.map((chat) => (
            <option key={chat.id} value={chat.id}>
              {chatName(chat)}
            </option>
          ))}
        </SelectField>
      )}
    </BuilderBlock>
  );
}
