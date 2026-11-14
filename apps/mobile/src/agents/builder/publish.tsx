import { StyleSheet, View } from "react-native";
import { AlertTriangle, CheckCircle2, Circle } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import {
  loosenedLabels,
  needDone,
  recipeNeedPlace,
  stepOfPlace,
  type AgentBuilderStep,
} from "@comamessenger/core";
import { radius, spacing } from "@comamessenger/tokens";
import { useTheme } from "@/lib/theme";
import { BottomSheet } from "@/ui/BottomSheet";
import { Button } from "@/ui/Button";
import { Divider, NavRow, SettingsGroup } from "@/ui/Settings";
import { Text } from "@/ui/Text";
import { useAgentBuilder } from "./AgentBuilderProvider";

/** Why «Опубликовать» is not available now, or null when it is. */
export function usePublishState() {
  const { t } = useTranslation();
  const builder = useAgentBuilder();
  const { agent, access, blockers, dirty } = builder;
  const nothingToPublish = !dirty && !agent.has_unpublished_changes;
  const reason = !access.canPublish
    ? t("agentPublishNoRights")
    : nothingToPublish && agent.published_version
      ? t("agentPublishUpToDate")
      : null;
  return {
    reason,
    disabled:
      Boolean(builder.pending) ||
      !access.canPublish ||
      nothingToPublish ||
      blockers.length > 0 ||
      builder.problems.length > 0,
  };
}

/** What stops the publish, each leading to the step that fixes it. */
export function BlockerList({
  onOpen,
}: {
  onOpen(step: AgentBuilderStep): void;
}) {
  const { t } = useTranslation();
  const theme = useTheme();
  const { blockers, problems } = useAgentBuilder();
  const items = [
    ...problems.map((problem) => ({
      key: `field-${problem.field}`,
      label: t(problem.key),
      step: stepOfPlace(problem.place),
    })),
    ...blockers.map((blocker) => ({
      key: blocker.key,
      label: t(`agentBlocker_${blocker.key}`),
      step: stepOfPlace(blocker.anchor),
    })),
  ];
  if (items.length === 0) return null;
  return (
    <SettingsGroup title={t("agentPublishNeeds")}>
      {items.map((item, index) => (
        <View key={item.key}>
          {index > 0 && <Divider />}
          <NavRow
            testID={`agent-blocker-${item.key}`}
            icon={AlertTriangle}
            label={item.label}
            onPress={() => onOpen(item.step)}
          />
        </View>
      ))}
      <View style={[styles.stripe, { backgroundColor: theme.warning }]} />
    </SettingsGroup>
  );
}

/**
 * Actions a publish would let run without a person, confirmed by the
 * publisher before publishing again.
 */
export function LoosenedSheet() {
  const { t } = useTranslation();
  const builder = useAgentBuilder();
  return (
    <BottomSheet
      visible={builder.loosened.length > 0}
      title={t("agentLoosenedTitle")}
      onClose={builder.cancelLoosened}
      testID="agent-loosened"
    >
      <View style={styles.sheet}>
        <Text tone="muted" size={15}>
          {t("agentLoosenedLead")}
        </Text>
        {loosenedLabels(t, builder.loosened).map((label) => (
          <Text key={label} size={15.5}>
            • {label}
          </Text>
        ))}
        <Button
          testID="agent-loosened-confirm"
          label={t("agentLoosenedConfirm")}
          pending={builder.pending === "publish"}
          onPress={() => void builder.publish(true)}
        />
        <Button
          variant="ghost"
          label={t("cancel")}
          onPress={builder.cancelLoosened}
        />
      </View>
    </BottomSheet>
  );
}

/**
 * The top of a builder opened from a catalog role: what is left to choose
 * before it can work and the defaults its instructions were written with.
 * Everything comes from the Core recipe.
 */
export function RecipeSetup({
  onOpen,
}: {
  onOpen(step: AgentBuilderStep): void;
}) {
  const { t } = useTranslation();
  const theme = useTheme();
  const { recipe, draft, agent } = useAgentBuilder();
  if (!recipe) return null;
  const left = recipe.needs.filter((need) => !needDone(need, draft, agent));
  return (
    <SettingsGroup
      title={t("agentRecipeSetupTitle", { role: recipe.name })}
      hint={recipe.summary}
    >
      <View style={styles.status}>
        <Text weight="medium" size={15} accessibilityLiveRegion="polite">
          {left.length > 0
            ? t("agentRecipeSetupLeft", { count: left.length })
            : t("agentRecipeSetupDone")}
        </Text>
      </View>
      {recipe.needs.map((need) => {
        const done = needDone(need, draft, agent);
        return (
          <View key={need.kind}>
            <Divider />
            <NavRow
              icon={done ? CheckCircle2 : Circle}
              label={
                need.required
                  ? need.label
                  : `${need.label} · ${t("agentRecipeNeedOptional")}`
              }
              hint={need.hint}
              accessibilityHint={
                done ? t("agentRecipeNeedDone") : t("agentRecipeNeedOpen")
              }
              onPress={() => onOpen(stepOfPlace(recipeNeedPlace[need.kind]))}
            />
          </View>
        );
      })}
      <Divider />
      <View style={styles.how}>
        <Text weight="semibold" size={14}>
          {t("agentRecipeHowTitle")}
        </Text>
        {recipe.triggers.map((trigger) => (
          <Text key={trigger.summary} tone="muted" size={14}>
            • {trigger.summary}
          </Text>
        ))}
        {recipe.params.length > 0 ? (
          <>
            <Text weight="semibold" size={14} style={styles.gap}>
              {t("agentRecipeDefaultsTitle")}
            </Text>
            {recipe.params.map((param) => (
              <View key={param.key} style={styles.param}>
                <Text tone="muted" size={14} style={styles.grow}>
                  {param.label}
                </Text>
                <Text size={14}>{param.value}</Text>
              </View>
            ))}
            <Text tone="subtle" size={13}>
              {t("agentRecipeDefaultsHint")}
            </Text>
          </>
        ) : null}
      </View>
      <View style={[styles.stripe, { backgroundColor: theme.primary }]} />
    </SettingsGroup>
  );
}

const styles = StyleSheet.create({
  stripe: {
    position: "absolute",
    left: 0,
    top: 0,
    bottom: 0,
    width: 3,
    borderTopLeftRadius: radius.lg,
    borderBottomLeftRadius: radius.lg,
  },
  sheet: { padding: spacing[4], gap: spacing[3] },
  status: { paddingHorizontal: spacing[4], paddingVertical: spacing[3] },
  how: { padding: spacing[4], gap: spacing[1] },
  gap: { marginTop: spacing[2] },
  param: { flexDirection: "row", gap: spacing[2] },
  grow: { flex: 1 },
});
