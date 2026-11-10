import { Zap } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Field } from "../../../ui";
import type { AgentWizardState } from "../useAgentWizard";

export function WizardPurposeStep({ wizard }: { wizard: AgentWizardState }) {
  const { t } = useTranslation();
  const { draft, setDraft, selectTemplate } = wizard;
  return (
    <div className="agent-wizard__step">
      <div>
        <h3>{t("agentWizardPurpose")}</h3>
        <p>{t("agentWizardPurposeHint")}</p>
      </div>
      <div className="agent-wizard__templates">
        {(["summarizer", "qa", "onboarding", "custom"] as const).map((item) => (
          <button
            key={item}
            className={draft.recipe === item ? "active" : ""}
            onClick={() => selectTemplate(item)}
          >
            <Zap />
            <strong>{t(`agentTemplate_${item}`)}</strong>
            <small>{t(`agentTemplateShort_${item}`)}</small>
          </button>
        ))}
      </div>
      <div className="settings-form-grid agent-wizard__identity">
        <Field
          label={t("displayName")}
          name="wizard-agent-name"
          value={draft.display_name}
          onChange={(event) =>
            setDraft({ ...draft, display_name: event.target.value })
          }
        />
        <small>{t("agentWizardHandleGenerated")}</small>
      </div>
    </div>
  );
}
