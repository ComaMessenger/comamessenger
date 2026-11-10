import { KeyRound } from "lucide-react";
import { useTranslation } from "react-i18next";
import { SettingsSection } from "../../settings/components/SettingsPrimitives";

export function AgentKnowledgePlaceholder() {
  const { t } = useTranslation();
  return (
    <SettingsSection
      title={t("agentKnowledgeTitle")}
      description={t("agentKnowledgeDescription")}
      icon={<KeyRound />}
      wide
    >
      <div className="agent-empty-state agent-empty-state--compact">
        <KeyRound />
        <h3>{t("agentKnowledgeEmpty")}</h3>
        <p>{t("agentKnowledgeEmptyHint")}</p>
      </div>
    </SettingsSection>
  );
}
