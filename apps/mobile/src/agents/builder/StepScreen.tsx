import type { ReactNode } from "react";
import {
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { router } from "expo-router";
import { useTranslation } from "react-i18next";
import { agentBuilderSteps, type AgentBuilderStep } from "@comamessenger/core";
import { spacing } from "@comamessenger/tokens";
import { useTheme } from "@/lib/theme";
import { AutosaveStatus } from "@/settings/AutosaveStatus";
import { settingsContent } from "@/settings/SettingsScreen";
import { Button } from "@/ui/Button";
import { Notice } from "@/ui/Notice";
import { ScreenHeader } from "@/ui/ScreenHeader";
import { Text } from "@/ui/Text";
import { ProgressBar } from "./controls";
import { useAgentBuilder } from "./AgentBuilderProvider";

/** Messages of the builder above a form: restored edits, errors, results. */
export function BuilderMessages() {
  const { t } = useTranslation();
  const builder = useAgentBuilder();
  return (
    <>
      <AutosaveStatus
        phase={builder.autosave.phase}
        error={builder.autosave.error}
        onRetry={builder.autosave.retry}
      />
      {builder.restored === "applied" ? (
        <Notice
          tone="neutral"
          title={t("agentRestoredTitle")}
          hint={t("agentRestoredHint")}
          actionLabel={t("agentRestoredOk")}
          onAction={builder.dismissRestored}
        />
      ) : builder.restored === "conflict" ? (
        <Notice
          tone="neutral"
          title={t("agentRestoredConflictTitle")}
          hint={t("agentRestoredConflictHint")}
          actionLabel={t("agentRestoredApply")}
          onAction={builder.applyRestored}
        />
      ) : null}
      {builder.error ? <Notice title={builder.error} /> : null}
      {builder.notice ? <Notice tone="success" title={builder.notice} /> : null}
      {!builder.access.canBuild ? (
        <Notice
          tone="neutral"
          title={t("agentBuildNoRights")}
          hint={t("agentBuildNoRightsHint")}
        />
      ) : null}
    </>
  );
}

/**
 * One step of the builder: its place among the six, the form and «Назад /
 * Далее» at the bottom. Moving between steps changes the step of this screen,
 * so the header's back returns to the list of steps.
 */
export function StepScreen({
  step,
  title,
  lead,
  children,
  next,
  canLeave = () => true,
}: {
  step: AgentBuilderStep;
  title: string;
  lead: string;
  children: ReactNode;
  /** Replaces «Далее» (the last step publishes). */
  next?: ReactNode;
  /** Checks the step before «Далее»; false keeps the person here. */
  canLeave?(): boolean;
}) {
  const { t } = useTranslation();
  const theme = useTheme();
  const builder = useAgentBuilder();
  const index = agentBuilderSteps.indexOf(step);
  const go = (target: AgentBuilderStep) => {
    builder.clearMessages();
    router.setParams({ step: target });
  };
  return (
    <SafeAreaView
      testID={`agent-step-${step}`}
      edges={["bottom"]}
      style={[styles.screen, { backgroundColor: theme.canvas }]}
    >
      <ScreenHeader
        title={title}
        subtitle={t("agentStepOf", {
          step: index + 1,
          total: agentBuilderSteps.length,
          name: builder.draft.display_name || builder.agent.display_name,
        })}
        backTestID="agent-step-close"
      />
      <View style={[styles.progress, { backgroundColor: theme.surface }]}>
        <ProgressBar
          value={index + 1}
          total={agentBuilderSteps.length}
          label={t("agentStepProgress", {
            step: index + 1,
            total: agentBuilderSteps.length,
          })}
        />
      </View>
      <KeyboardAvoidingView
        style={styles.screen}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <ScrollView
          key={step}
          contentContainerStyle={styles.content}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="interactive"
        >
          <BuilderMessages />
          <Text tone="muted" size={14.5} style={styles.lead}>
            {lead}
          </Text>
          {children}
        </ScrollView>
        <View
          style={[
            styles.footer,
            { borderTopColor: theme.border, backgroundColor: theme.surface },
          ]}
        >
          {index > 0 ? (
            <View style={styles.footerButton}>
              <Button
                testID="agent-step-back"
                variant="secondary"
                label={t("agentStepBack")}
                onPress={() => go(agentBuilderSteps[index - 1]!)}
              />
            </View>
          ) : null}
          <View style={styles.footerButton}>
            {next ?? (
              <Button
                testID="agent-step-next"
                label={t("agentStepNext")}
                onPress={() => {
                  if (canLeave()) go(agentBuilderSteps[index + 1]!);
                }}
              />
            )}
          </View>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  progress: { paddingHorizontal: spacing[4], paddingBottom: spacing[2] },
  content: { ...settingsContent, paddingBottom: spacing[8] },
  lead: { paddingHorizontal: spacing[1] },
  footer: {
    flexDirection: "row",
    gap: spacing[3],
    paddingHorizontal: spacing[4],
    paddingTop: spacing[3],
    paddingBottom: spacing[2],
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  footerButton: { flex: 1 },
});
