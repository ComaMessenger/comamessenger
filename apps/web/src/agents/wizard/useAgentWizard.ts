import { useState } from "react";
import type { Agent, MessengerAPI } from "@comamessenger/core";
import { useTranslation } from "react-i18next";
import { messageOf } from "../../errors";
import {
  type AgentLaunch,
  type AgentTemplate as Template,
  recipeTriggerRequests,
} from "../agentTemplates";
import { emptyDraft, type Draft } from "../shared/draft";

export const wizardStepCount = 5;

function defaultLaunch(template: Template): AgentLaunch {
  return template === "summarizer"
    ? "schedule"
    : template === "qa"
      ? "mention"
      : template === "onboarding"
        ? "member_join"
        : "manual";
}

export function useAgentWizard({
  api,
  template,
  onCreated,
}: {
  api: MessengerAPI;
  template: Template;
  onCreated(agent: Agent): Promise<void>;
}) {
  const { t } = useTranslation();
  const [step, setStep] = useState(1);
  const [draft, setDraft] = useState<Draft>(() => ({
    ...emptyDraft(template),
    display_name: t(`agentTemplate_${template}`),
    description:
      template === "custom" ? "" : t(`agentTemplateDescription_${template}`),
  }));
  const [sourceChatIDs, setSourceChatIDs] = useState<string[]>([]);
  const [destinationChatID, setDestinationChatID] = useState("");
  const [launch, setLaunch] = useState<AgentLaunch>(defaultLaunch(template));
  const [command, setCommand] = useState("summarize");
  const [scheduleTime, setScheduleTime] = useState("09:00");
  const [timezone, setTimezone] = useState(
    Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
  );
  const [citations, setCitations] = useState(template !== "custom");
  const [fallback, setFallback] = useState(t("agentWizardFallbackDefault"));
  const [tone, setTone] = useState(t("agentWizardToneFriendly"));
  const [customInstructions, setCustomInstructions] = useState("");
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  function selectTemplate(value: Template) {
    const next = emptyDraft(value);
    setDraft({
      ...next,
      display_name: t(`agentTemplate_${value}`),
      description:
        value === "custom" ? "" : t(`agentTemplateDescription_${value}`),
    });
    setLaunch(defaultLaunch(value));
    setCitations(value !== "custom");
  }
  function next() {
    setError("");
    if (step === 1 && (!draft.display_name.trim() || !draft.handle.trim())) {
      setError(t("agentWizardIdentityRequired"));
      return;
    }
    if (step === 2 && (sourceChatIDs.length === 0 || !destinationChatID)) {
      setError(t("agentTemplateChatRequired"));
      return;
    }
    if (step === 3 && draft.recipe === "custom" && !customInstructions.trim()) {
      setError(t("agentWizardInstructionsRequired"));
      return;
    }
    setStep((current) => Math.min(wizardStepCount, current + 1));
  }
  function description(): string {
    const base =
      draft.recipe === "custom"
        ? customInstructions.trim()
        : t(`agentTemplateDescription_${draft.recipe}`);
    const policy = [
      citations ? t("agentWizardInstructionCitations") : "",
      draft.recipe === "qa" && fallback.trim()
        ? t("agentWizardInstructionFallback", { fallback: fallback.trim() })
        : "",
      draft.recipe === "onboarding"
        ? t("agentWizardInstructionTone", { tone })
        : "",
    ].filter(Boolean);
    return [base, ...policy].join("\n\n");
  }
  async function create() {
    setPending(true);
    setError("");
    let created: Agent | null = null;
    try {
      const chatIDs = [...new Set([...sourceChatIDs, destinationChatID])];
      const input = draft.llm_connection_id
        ? {
            ...draft,
            description: description(),
            chat_ids: chatIDs,
            enabled: false,
            provider: "",
            endpoint_url: "",
          }
        : {
            ...draft,
            description: description(),
            chat_ids: chatIDs,
            enabled: false,
            llm_connection_id: undefined,
          };
      created = await api.createAgent(input);
      const existing = await api.agentTriggers(created.id);
      await Promise.all(
        existing.map((trigger) =>
          api.deleteAgentTrigger(created!.id, trigger.id),
        ),
      );
      const [hour, minute] = scheduleTime.split(":").map(Number);
      for (const trigger of recipeTriggerRequests(draft.recipe, {
        launch,
        destinationChatID,
        command,
        hour,
        minute,
        timezone,
      })) {
        await api.createAgentTrigger(created.id, trigger);
      }
      await onCreated(created);
    } catch (cause) {
      if (created) {
        try {
          await api.deleteAgent(created.id);
        } catch {
          // The incomplete draft remains visible and recoverable if cleanup fails.
        }
      }
      setError(messageOf(cause));
    } finally {
      setPending(false);
    }
  }
  return {
    step,
    setStep,
    draft,
    setDraft,
    sourceChatIDs,
    setSourceChatIDs,
    destinationChatID,
    setDestinationChatID,
    launch,
    setLaunch,
    command,
    setCommand,
    scheduleTime,
    setScheduleTime,
    timezone,
    setTimezone,
    citations,
    setCitations,
    fallback,
    setFallback,
    tone,
    setTone,
    customInstructions,
    setCustomInstructions,
    error,
    pending,
    selectTemplate,
    next,
    create,
  };
}

export type AgentWizardState = ReturnType<typeof useAgentWizard>;
