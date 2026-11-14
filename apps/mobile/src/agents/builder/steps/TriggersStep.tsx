import { useState } from "react";
import { ActivityIndicator, StyleSheet, Switch, View } from "react-native";
import { useQuery } from "@tanstack/react-query";
import { router } from "expo-router";
import { ArrowRight, Pencil, Plus, Trash2 } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import {
  describeRule,
  triggerTypes,
  type AgentTrigger,
  type TriggerType,
} from "@comamessenger/core";
import { spacing } from "@comamessenger/tokens";
import { messageOf } from "@/lib/errors";
import { useTheme } from "@/lib/theme";
import { useSignedIn } from "@/session/SessionProvider";
import { IconButton } from "@/ui/IconButton";
import { Notice } from "@/ui/Notice";
import { PickerSheet } from "@/ui/PickerSheet";
import { ActionRow, Divider, SettingsGroup } from "@/ui/Settings";
import { Text } from "@/ui/Text";
import { useAgentBuilder } from "../AgentBuilderProvider";
import { Note } from "../controls";
import { agentBuilderPaths, agentKeys } from "../data";
import { StepScreen } from "../StepScreen";

/** Workspace webhooks builders may start an agent by; none without access. */
export function useWebhooks() {
  const { api } = useSignedIn();
  return useQuery({
    queryKey: agentKeys.webhooks,
    queryFn: () => api.integrationWebhooks(),
    retry: false,
  });
}

/**
 * Step 5 (web block «Когда включается»): launch rules read as sentences.
 * Rules are stored by the server at once, separately from the draft, as on
 * the web; an edit opens its own screen.
 */
export function TriggersStep() {
  const { t } = useTranslation();
  const theme = useTheme();
  const { api } = useSignedIn();
  const builder = useAgentBuilder();
  const { agent, chats, timezone, triggers } = builder;
  const editable = builder.access.canBuild;
  const webhooks = useWebhooks();
  const [choosing, setChoosing] = useState(false);
  const [pending, setPending] = useState("");
  const [error, setError] = useState("");
  const webhookNames = new Map(
    (webhooks.data ?? []).map((hook) => [hook.id, hook.name]),
  );
  const released = (webhooks.data ?? []).filter(
    (hook) => hook.agent_use_allowed,
  );
  const offered = triggerTypes.filter(
    (type) => type !== "webhook" || released.length > 0,
  );

  async function act(id: string, work: () => Promise<unknown>) {
    setPending(id);
    setError("");
    try {
      await work();
      await triggers.refetch();
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setPending("");
    }
  }

  const open = (params: { triggerId?: string; type?: TriggerType }) =>
    router.push({ pathname: agentBuilderPaths.rule(agent.id), params });

  return (
    <StepScreen
      step="triggers"
      title={t("agentBlockTriggers")}
      lead={t("agentBlockTriggersHint")}
    >
      {error ? <Notice title={error} /> : null}
      <SettingsGroup title={t("agentStepTriggersRules")}>
        {triggers.isPending ? (
          <ActivityIndicator style={styles.pad} color={theme.muted} />
        ) : null}
        {triggers.isError && !triggers.data ? (
          <View style={styles.pad}>
            <Notice
              title={messageOf(triggers.error)}
              actionLabel={t("retry")}
              onAction={() => void triggers.refetch()}
            />
          </View>
        ) : null}
        {triggers.data?.length === 0 ? (
          <Text tone="muted" size={15} style={styles.pad}>
            {t("agentRulesEmpty")}
          </Text>
        ) : null}
        {(triggers.data ?? []).map((trigger, index) => (
          <View key={trigger.id}>
            {index > 0 && <Divider />}
            <RuleRow
              trigger={trigger}
              sentence={describeRule(t, trigger, chats, timezone, webhookNames)}
              editable={editable}
              busy={pending === trigger.id}
              onToggle={(enabled) =>
                void act(trigger.id, () =>
                  api.updateAgentTrigger(agent.id, trigger.id, { enabled }),
                )
              }
              onEdit={() => open({ triggerId: trigger.id })}
              onDelete={() =>
                void act(trigger.id, () =>
                  api.deleteAgentTrigger(agent.id, trigger.id),
                )
              }
            />
          </View>
        ))}
        {editable ? (
          <>
            {(triggers.data?.length ?? 0) > 0 && <Divider />}
            <ActionRow
              testID="agent-rule-add"
              icon={Plus}
              label={t("agentRuleAdd")}
              onPress={() => setChoosing(true)}
            />
          </>
        ) : null}
      </SettingsGroup>
      <Note>{t("agentStepTriggersNote")}</Note>
      <PickerSheet<TriggerType | "">
        visible={choosing}
        title={t("agentRuleChoose")}
        value=""
        testID="agent-rule-type"
        options={offered.map((type) => ({
          value: type,
          label: t(`agentRuleType_${type}`),
        }))}
        onSelect={(type) => {
          if (type) open({ type });
        }}
        onClose={() => setChoosing(false)}
      />
    </StepScreen>
  );
}

function RuleRow({
  trigger,
  sentence,
  editable,
  busy,
  onToggle,
  onEdit,
  onDelete,
}: {
  trigger: AgentTrigger;
  sentence: { when: string; then: string };
  editable: boolean;
  busy: boolean;
  onToggle(enabled: boolean): void;
  onEdit(): void;
  onDelete(): void;
}) {
  const { t } = useTranslation();
  const theme = useTheme();
  const configurable =
    trigger.type !== "mention" &&
    trigger.type !== "every_message" &&
    trigger.type !== "manual";
  return (
    <View
      style={[styles.rule, !trigger.enabled && styles.off]}
      testID={`agent-rule-${trigger.type}`}
    >
      <View style={styles.sentence}>
        <Text size={15.5} weight="medium">
          {sentence.when}
        </Text>
        {sentence.then ? (
          <View style={styles.then}>
            <ArrowRight size={14} color={theme.muted} />
            <Text tone="muted" size={14} style={styles.grow}>
              {sentence.then}
            </Text>
          </View>
        ) : null}
      </View>
      <View style={styles.actions}>
        {busy ? <ActivityIndicator color={theme.muted} /> : null}
        {editable && configurable ? (
          <IconButton
            label={t("agentRuleEdit")}
            disabled={busy}
            onPress={onEdit}
            icon={(color) => <Pencil size={18} color={color} />}
          />
        ) : null}
        {editable ? (
          <IconButton
            label={t("agentRuleDelete")}
            disabled={busy}
            onPress={onDelete}
            icon={(color) => <Trash2 size={18} color={color} />}
          />
        ) : null}
        <Switch
          accessibilityLabel={t("agentRuleEnabled", { rule: sentence.when })}
          value={trigger.enabled}
          disabled={!editable || busy}
          onValueChange={onToggle}
          trackColor={{ true: theme.primary, false: theme.borderStrong }}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  pad: { padding: spacing[4] },
  rule: {
    paddingLeft: spacing[4],
    paddingRight: spacing[3],
    paddingVertical: spacing[3],
    gap: spacing[2],
  },
  off: { opacity: 0.6 },
  sentence: { gap: spacing[1] },
  then: { flexDirection: "row", alignItems: "center", gap: spacing[1] },
  actions: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "flex-end",
    gap: spacing[1],
  },
  grow: { flex: 1 },
});
