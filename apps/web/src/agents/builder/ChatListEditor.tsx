import type { Chat } from "@comamessenger/core";
import { useTranslation } from "react-i18next";
import { Chip, SelectField } from "../../ui";
import { chatName } from "../shared/format";

/** Chips of chosen chats with a select to add one more. */
export function ChatListEditor({
  name,
  chats,
  chatIDs,
  emptyText,
  addLabel,
  onChange,
}: {
  name: string;
  chats: Chat[];
  chatIDs: string[];
  emptyText: string;
  addLabel: string;
  onChange(ids: string[]): void;
}) {
  const { t } = useTranslation();
  const available = chats.filter((chat) => !chatIDs.includes(chat.id));
  return (
    <>
      {chatIDs.length > 0 ? (
        <div className="agent-chips">
          {chatIDs.map((id) => {
            const chat = chats.find((item) => item.id === id);
            const label = chat ? chatName(chat) : t("agentChatHidden");
            return (
              <Chip
                key={id}
                active
                onRemove={() => onChange(chatIDs.filter((item) => item !== id))}
                removeLabel={t("agentPlaceRemove", { name: label })}
              >
                {label}
              </Chip>
            );
          })}
        </div>
      ) : (
        <p className="agent-block__empty">{emptyText}</p>
      )}
      {available.length > 0 && (
        <SelectField
          required={false}
          label={addLabel}
          name={name}
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
    </>
  );
}
