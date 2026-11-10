import { useTranslation } from "react-i18next";
import { Field, SelectField, TextareaField } from "../../../ui";
import { SettingsToggle } from "../../../settings/components/SettingsPrimitives";
import type { AgentWizardState } from "../useAgentWizard";

export function WizardRecipeStep({ wizard }: { wizard: AgentWizardState }) {
  const { t } = useTranslation();
  const {
    draft,
    customInstructions,
    setCustomInstructions,
    fallback,
    setFallback,
    tone,
    setTone,
    citations,
    setCitations,
    launch,
    setLaunch,
    command,
    setCommand,
    scheduleTime,
    setScheduleTime,
    timezone,
    setTimezone,
  } = wizard;
  return (
    <div className="agent-wizard__step">
      <div>
        <h3>{t("agentWizardRecipeDetails")}</h3>
        <p>{t(`agentWizardRecipeHint_${draft.recipe}`)}</p>
      </div>
      {draft.recipe === "custom" && (
        <TextareaField
          label={t("agentWizardInstructions")}
          name="wizard-agent-instructions"
          rows={5}
          value={customInstructions}
          onChange={(event) => setCustomInstructions(event.target.value)}
        />
      )}
      {draft.recipe === "qa" && (
        <Field
          label={t("agentWizardFallback")}
          name="wizard-agent-fallback"
          value={fallback}
          onChange={(event) => setFallback(event.target.value)}
        />
      )}
      {draft.recipe === "onboarding" && (
        <SelectField
          label={t("agentWizardTone")}
          name="wizard-agent-tone"
          value={tone}
          onChange={(event) => setTone(event.target.value)}
        >
          <option value={t("agentWizardToneFriendly")}>
            {t("agentWizardToneFriendly")}
          </option>
          <option value={t("agentWizardToneConcise")}>
            {t("agentWizardToneConcise")}
          </option>
          <option value={t("agentWizardToneFormal")}>
            {t("agentWizardToneFormal")}
          </option>
        </SelectField>
      )}
      {draft.recipe !== "custom" && (
        <SettingsToggle
          label={t("agentWizardCitations")}
          hint={t("agentWizardCitationsHint")}
          checked={citations}
          onChange={setCitations}
        />
      )}
      <div className="agent-wizard__launches">
        {(draft.recipe === "onboarding"
          ? (["member_join", "mention", "manual"] as const)
          : (["manual", "mention", "command", "schedule"] as const)
        ).map((item) => (
          <button
            key={item}
            className={launch === item ? "active" : ""}
            onClick={() => setLaunch(item)}
          >
            <strong>{t(`agentWizardLaunch_${item}`)}</strong>
            <small>{t(`agentWizardLaunchHint_${item}`)}</small>
          </button>
        ))}
      </div>
      {launch === "command" && (
        <Field
          label={t("agentWizardCommand")}
          name="wizard-agent-command"
          value={command}
          onChange={(event) => setCommand(event.target.value)}
        />
      )}
      {launch === "schedule" && (
        <div className="settings-form-grid">
          <Field
            label={t("agentWizardScheduleTime")}
            name="wizard-agent-schedule-time"
            type="time"
            value={scheduleTime}
            onChange={(event) => setScheduleTime(event.target.value)}
          />
          <Field
            label={t("timezone")}
            name="wizard-agent-timezone"
            value={timezone}
            onChange={(event) => setTimezone(event.target.value)}
          />
        </div>
      )}
    </div>
  );
}
