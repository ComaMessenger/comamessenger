import type {
  Agent,
  AgentLlmConnection,
  Chat,
  MessengerAPI,
} from "@comamessenger/core";
import { Plus } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button, Dialog, FormError } from "../../ui";
import type { AgentTemplate as Template } from "../agentTemplates";
import { WizardAccessStep } from "./steps/WizardAccessStep";
import { WizardConnectionStep } from "./steps/WizardConnectionStep";
import { WizardPurposeStep } from "./steps/WizardPurposeStep";
import { WizardRecipeStep } from "./steps/WizardRecipeStep";
import { WizardReviewStep } from "./steps/WizardReviewStep";
import { useAgentWizard, wizardStepCount } from "./useAgentWizard";

export function AgentCreationWizard({
  api,
  template,
  chats,
  connections,
  onClose,
  onCreated,
}: {
  api: MessengerAPI;
  template: Template;
  chats: Chat[];
  connections: AgentLlmConnection[];
  onClose(): void;
  onCreated(agent: Agent): Promise<void>;
}) {
  const { t } = useTranslation();
  const wizard = useAgentWizard({ api, template, onCreated });
  const { step, setStep, error, pending, next, create } = wizard;
  return (
    <Dialog
      title={t("agentWizardTitle")}
      description={t("agentWizardStep", {
        current: step,
        total: wizardStepCount,
      })}
      onClose={onClose}
      className="agent-wizard-dialog"
    >
      <div className="agent-wizard">
        <div className="agent-wizard__progress" aria-hidden="true">
          {[1, 2, 3, 4, 5].map((item) => (
            <span key={item} className={item <= step ? "active" : ""} />
          ))}
        </div>
        {step === 1 && <WizardPurposeStep wizard={wizard} />}
        {step === 2 && <WizardAccessStep wizard={wizard} chats={chats} />}
        {step === 3 && <WizardRecipeStep wizard={wizard} />}
        {step === 4 && (
          <WizardConnectionStep wizard={wizard} connections={connections} />
        )}
        {step === 5 && (
          <WizardReviewStep
            wizard={wizard}
            chats={chats}
            connections={connections}
          />
        )}
        <FormError message={error} />
        <div className="ui-dialog__actions">
          {step > 1 && (
            <Button
              variant="ghost"
              disabled={pending}
              onClick={() => setStep(step - 1)}
            >
              {t("back")}
            </Button>
          )}
          <Button variant="ghost" disabled={pending} onClick={onClose}>
            {t("cancel")}
          </Button>
          {step < wizardStepCount ? (
            <Button variant="primary" onClick={next}>
              {t("continue")}
            </Button>
          ) : (
            <Button
              variant="primary"
              disabled={pending}
              onClick={() => void create()}
            >
              <Plus />
              {pending ? t("saving") : t("createAgent")}
            </Button>
          )}
        </div>
      </div>
    </Dialog>
  );
}
