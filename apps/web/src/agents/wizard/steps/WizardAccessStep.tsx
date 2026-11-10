import type { Chat } from "@comamessenger/core";
import { useTranslation } from "react-i18next";
import { SelectField } from "../../../ui";
import { chatName } from "../../shared/format";
import type { AgentWizardState } from "../useAgentWizard";

export function WizardAccessStep({
  wizard,
  chats,
}: {
  wizard: AgentWizardState;
  chats: Chat[];
}) {
  const { t } = useTranslation();
  const {
    sourceChatIDs,
    setSourceChatIDs,
    destinationChatID,
    setDestinationChatID,
  } = wizard;
  return (
    <div className="agent-wizard__step">
      <div>
        <h3>{t("agentWizardAccess")}</h3>
        <p>{t("agentWizardSourcesHint")}</p>
      </div>
      <strong>{t("agentWizardSources")}</strong>
      <div className="agent-wizard__chats">
        {chats.map((chat) => (
          <label key={chat.id}>
            <input
              type="checkbox"
              checked={sourceChatIDs.includes(chat.id)}
              onChange={(event) =>
                setSourceChatIDs(
                  event.target.checked
                    ? [...sourceChatIDs, chat.id]
                    : sourceChatIDs.filter((id) => id !== chat.id),
                )
              }
            />
            <span>{chatName(chat)}</span>
          </label>
        ))}
      </div>
      <SelectField
        label={t("agentWizardDestination")}
        name="wizard-agent-destination"
        value={destinationChatID}
        onChange={(event) => setDestinationChatID(event.target.value)}
      >
        <option value="">{t("agentWizardChooseDestination")}</option>
        {chats.map((chat) => (
          <option key={chat.id} value={chat.id}>
            {chatName(chat)}
          </option>
        ))}
      </SelectField>
    </div>
  );
}
