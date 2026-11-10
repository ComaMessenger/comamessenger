import type { AgentLlmConnection, Chat } from "@comamessenger/core";
import { ShieldCheck } from "lucide-react";
import { useTranslation } from "react-i18next";
import { chatName } from "../../shared/format";
import type { AgentWizardState } from "../useAgentWizard";

export function WizardReviewStep({
  wizard,
  chats,
  connections,
}: {
  wizard: AgentWizardState;
  chats: Chat[];
  connections: AgentLlmConnection[];
}) {
  const { t } = useTranslation();
  const { draft, sourceChatIDs, destinationChatID, launch } = wizard;
  return (
    <div className="agent-wizard__step">
      <div>
        <h3>{t("agentWizardReview")}</h3>
        <p>{t("agentWizardReviewHint")}</p>
      </div>
      <dl className="agent-wizard__summary">
        <div>
          <dt>{t("agentWizardTask")}</dt>
          <dd>{t(`agentTemplate_${draft.recipe}`)}</dd>
        </div>
        <div>
          <dt>{t("agentWizardSources")}</dt>
          <dd>
            {chats
              .filter((chat) => sourceChatIDs.includes(chat.id))
              .map(chatName)
              .join(", ")}
          </dd>
        </div>
        <div>
          <dt>{t("agentWizardDestination")}</dt>
          <dd>
            {chats.find((chat) => chat.id === destinationChatID)
              ? chatName(chats.find((chat) => chat.id === destinationChatID)!)
              : "—"}
          </dd>
        </div>
        <div>
          <dt>{t("agentWizardWhen")}</dt>
          <dd>{t(`agentWizardLaunch_${launch}`)}</dd>
        </div>
        <div>
          <dt>{t("agentConnectionsTitle")}</dt>
          <dd>
            {connections.find(
              (connection) => connection.id === draft.llm_connection_id,
            )?.name ?? t("agentConnectionChooseLater")}
          </dd>
        </div>
        <div>
          <dt>{t("agentWizardExternalData")}</dt>
          <dd>{draft.external_data_sharing_approved ? t("yes") : t("no")}</dd>
        </div>
      </dl>
      <div className="agent-wizard__notice">
        <ShieldCheck />
        <span>{t("agentWizardSafeStart")}</span>
      </div>
    </div>
  );
}
