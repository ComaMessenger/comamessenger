import { StyleSheet, View } from "react-native";
import { router } from "expo-router";
import {
  BookOpen,
  CheckCircle2,
  Circle,
  Clock,
  ListChecks,
  MessagesSquare,
  Settings2,
  Sparkles,
  Wrench,
  UserRound,
  type LucideIcon,
} from "lucide-react-native";
import { useTranslation } from "react-i18next";
import {
  agentBuilderSteps,
  agentTask,
  draftChatIDs,
  agentBuilderState,
  stepFilled,
  type AgentBuilderStep,
} from "@comamessenger/core";
import { spacing } from "@comamessenger/tokens";
import { useTheme } from "@/lib/theme";
import { SettingsScreen } from "@/settings/SettingsScreen";
import { Avatar } from "@/ui/Avatar";
import { Button } from "@/ui/Button";
import { Divider, NavRow, SettingsGroup } from "@/ui/Settings";
import { Text } from "@/ui/Text";
import { useAgentBuilder } from "./AgentBuilderProvider";
import { ProgressBar } from "./controls";
import { agentBuilderPaths } from "./data";
import { RecipeSetup } from "./publish";
import { BuilderMessages } from "./StepScreen";

const stepIcons: Record<AgentBuilderStep, LucideIcon> = {
  role: UserRound,
  places: MessagesSquare,
  knowledge: BookOpen,
  skills: Wrench,
  triggers: Clock,
  review: ListChecks,
};

export const stepTitleKeys: Record<AgentBuilderStep, string> = {
  role: "agentBlockIdentity",
  places: "agentStepPlaces",
  knowledge: "agentBlockKnowledge",
  skills: "agentBlockSkills",
  triggers: "agentBlockTriggers",
  review: "agentStepReview",
};

/**
 * The agent's page in the builder: its state, what a catalog role still
 * needs and the six steps with what is set in each. A new and a published
 * agent are edited through the same steps.
 */
export function BuilderHub() {
  const { t, i18n } = useTranslation();
  const theme = useTheme();
  const builder = useAgentBuilder();
  const { agent, draft, triggers, recipe } = builder;
  const filled = agentBuilderSteps.filter((step) =>
    stepFilled(step, draft, triggers.data),
  ).length;
  const state = agentBuilderState(agent, builder.dirty, i18n.language);
  const open = (step: AgentBuilderStep) =>
    router.push(agentBuilderPaths.step(agent.id, step));
  const summary = (step: AgentBuilderStep): string | undefined => {
    switch (step) {
      case "role":
        return draft.description?.trim()
          ? agentTask(
              t,
              { ...agent, description: draft.description },
              recipe ? [recipe] : undefined,
            )
          : t("agentNoTask");
      case "places": {
        const count = draftChatIDs(draft).length;
        return count ? t("agentPlacesCount", { count }) : t("agentPlacesNone");
      }
      case "knowledge": {
        const count = (draft.knowledge_collection_ids ?? []).length;
        return count
          ? t("agentStepKnowledgeCount", { count })
          : t("agentStepKnowledgeChatsOnly");
      }
      case "skills":
        return builder.capabilities.skills.length
          ? builder.capabilities.skills
              .map((skill) => t(`agentSkill_${skill}`))
              .join(", ")
          : t("passportOnlyReads");
      case "triggers": {
        const count = (triggers.data ?? []).filter(
          (rule) => rule.enabled,
        ).length;
        return count
          ? t("agentStepRulesCount", { count })
          : t("agentRulesEmpty");
      }
      case "review":
        return builder.blockers.length + builder.problems.length
          ? t("agentStepBlockersCount", {
              count: builder.blockers.length + builder.problems.length,
            })
          : t("agentStepReady");
    }
  };
  return (
    <SettingsScreen
      title={draft.display_name || agent.display_name}
      subtitle={t("agentBuilderTitle")}
      testID="agent-builder-hub"
    >
      <View style={styles.head}>
        <Avatar
          name={draft.display_name || agent.display_name}
          seed={agent.id}
          actorID={agent.id}
          avatarVersion={agent.avatar_version}
          size={56}
          agent
        />
        <View style={styles.grow}>
          <Text weight="semibold" size={18} numberOfLines={2}>
            {draft.display_name || agent.display_name}
          </Text>
          <Text tone="muted" size={14} testID="agent-builder-state">
            {t(state.key, state.values)}
          </Text>
        </View>
      </View>
      <BuilderMessages />
      <View style={styles.progress}>
        <Text tone="muted" size={13.5}>
          {t("agentStepsFilled", {
            done: filled,
            total: agentBuilderSteps.length - 1,
          })}
        </Text>
        <ProgressBar
          value={filled}
          total={agentBuilderSteps.length - 1}
          label={t("agentBuilderTitle")}
        />
      </View>
      <RecipeSetup onOpen={open} />
      <SettingsGroup title={t("agentStepsTitle")}>
        {agentBuilderSteps.map((step, index) => {
          const done = stepFilled(step, draft, triggers.data);
          const Icon =
            step === "review" ? stepIcons[step] : done ? CheckCircle2 : Circle;
          return (
            <View key={step}>
              {index > 0 && <Divider />}
              <NavRow
                testID={`agent-hub-step-${step}`}
                icon={Icon ?? stepIcons[step]}
                label={`${index + 1}. ${t(stepTitleKeys[step])}`}
                hint={summary(step)}
                onPress={() => open(step)}
              />
            </View>
          );
        })}
      </SettingsGroup>
      <Button
        testID="agent-hub-start"
        label={filled === 0 ? t("agentStepsStart") : t("agentStepsContinue")}
        onPress={() =>
          open(
            agentBuilderSteps.find(
              (step) => !stepFilled(step, draft, triggers.data),
            ) ?? "review",
          )
        }
      />
      <SettingsGroup>
        {builder.access.canBuild ? (
          <>
            <NavRow
              testID="agent-hub-architect"
              icon={Sparkles}
              label={t("architectEditExisting")}
              onPress={() =>
                void builder.flush().then((saved) => {
                  if (saved)
                    router.push(agentBuilderPaths.editArchitect(agent.id));
                })
              }
            />
            <Divider />
          </>
        ) : null}
        <NavRow
          testID="agent-hub-advanced"
          icon={Settings2}
          label={t("agentAdvancedTitle")}
          hint={t("agentAdvancedLead")}
          onPress={() => router.push(agentBuilderPaths.advanced(agent.id))}
        />
      </SettingsGroup>
      <View style={{ height: spacing[2], backgroundColor: theme.canvas }} />
    </SettingsScreen>
  );
}

const styles = StyleSheet.create({
  head: { flexDirection: "row", alignItems: "center", gap: spacing[3] },
  progress: { gap: spacing[2] },
  grow: { flex: 1 },
});
