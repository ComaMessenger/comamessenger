import { Redirect, useLocalSearchParams } from "expo-router";
import { isAgentBuilderStep } from "@comamessenger/core";
import { KnowledgeStep } from "@/agents/builder/steps/KnowledgeStep";
import { PlacesStep } from "@/agents/builder/steps/PlacesStep";
import { ReviewStep } from "@/agents/builder/steps/ReviewStep";
import { RoleStep } from "@/agents/builder/steps/RoleStep";
import { SkillsStep } from "@/agents/builder/steps/SkillsStep";
import { TriggersStep } from "@/agents/builder/steps/TriggersStep";

export { RouteError as ErrorBoundary } from "@/ui/RouteError";

const screens = {
  role: RoleStep,
  places: PlacesStep,
  knowledge: KnowledgeStep,
  skills: SkillsStep,
  triggers: TriggersStep,
  review: ReviewStep,
};

/** One step of the builder; «Назад/Далее» change the step in place. */
export default function Route() {
  const { agentId, step } = useLocalSearchParams<{
    agentId: string;
    step: string;
  }>();
  if (!isAgentBuilderStep(step))
    return <Redirect href={`/agents/${encodeURIComponent(agentId)}/edit`} />;
  const Screen = screens[step];
  return <Screen />;
}
