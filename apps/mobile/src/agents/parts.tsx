import type { ReactNode } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { AlertTriangle, ChevronRight } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import {
  formatDateTime,
  formatTime,
  humanStatusLabel,
  runFailed,
  runSentence,
  statusTone,
  type Agent,
  type AgentRun,
  type Chat,
  type HumanStatus,
} from "@comamessenger/core";
import { radius, spacing, type ThemeTokens } from "@comamessenger/tokens";
import { useTheme } from "@/lib/theme";
import { Avatar } from "@/ui/Avatar";
import { Button } from "@/ui/Button";
import { Text } from "@/ui/Text";

export function toneColors(
  theme: ThemeTokens,
  tone: "success" | "warning" | "danger" | "neutral",
) {
  switch (tone) {
    case "success":
      return { color: theme.successText, background: theme.successSoft };
    case "warning":
      return { color: theme.warning, background: theme.warningSoft };
    case "danger":
      return { color: theme.danger, background: theme.dangerSoft };
    default:
      return { color: theme.muted, background: theme.surfaceSelected };
  }
}

/** A small coloured label: the human status of an agent or of a run. */
export function Pill({
  label,
  tone,
  testID,
}: {
  label: string;
  tone: "success" | "warning" | "danger" | "neutral";
  testID?: string;
}) {
  const theme = useTheme();
  const colors = toneColors(theme, tone);
  return (
    <View
      testID={testID}
      style={[styles.pill, { backgroundColor: colors.background }]}
    >
      <View style={[styles.pillDot, { backgroundColor: colors.color }]} />
      <Text size={12} weight="semibold" style={{ color: colors.color }}>
        {label}
      </Text>
    </View>
  );
}

/** Human status chip; «needs attention» carries its reason in words. */
export function AgentStatusPill({
  status,
  withReason = false,
  testID,
}: {
  status: HumanStatus;
  withReason?: boolean;
  testID?: string;
}) {
  const { t } = useTranslation();
  return (
    <View style={styles.statusLine}>
      <Pill
        testID={testID}
        label={humanStatusLabel(t, status)}
        tone={statusTone(status)}
      />
      {withReason && status.kind === "attention" ? (
        <Text tone="danger" size={12.5} style={styles.shrink}>
          {t(status.reason)}
        </Text>
      ) : null}
    </View>
  );
}

/** One agent in a list: avatar, name and status, its task and its chats. */
export function AgentRow({
  agent,
  status,
  task,
  places,
  onPress,
  testID,
}: {
  agent: Agent;
  status: HumanStatus;
  task: string;
  places: string;
  onPress(): void;
  testID?: string;
}) {
  const { t } = useTranslation();
  const theme = useTheme();
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={[
        agent.display_name,
        humanStatusLabel(t, status),
        task,
        places,
      ].join(", ")}
      onPress={onPress}
      style={({ pressed }) => [
        styles.agentRow,
        pressed && { backgroundColor: theme.surfaceSelected },
      ]}
    >
      <Avatar
        name={agent.display_name}
        seed={agent.id}
        actorID={agent.id}
        avatarVersion={agent.avatar_version}
        size={44}
        agent
      />
      <View style={styles.grow}>
        <Text weight="semibold" size={16} numberOfLines={1}>
          {agent.display_name}
        </Text>
        <AgentStatusPill status={status} withReason />
        <Text size={14} numberOfLines={2} style={styles.task}>
          {task}
        </Text>
        <Text tone="muted" size={13} numberOfLines={1}>
          {places}
        </Text>
      </View>
      <ChevronRight size={20} color={theme.subtle} />
    </Pressable>
  );
}

const today = (value: string) =>
  new Date(value).toDateString() === new Date().toDateString();

/** A line of the activity feed: time, agent and what it did, in words. */
export function RunRow({
  run,
  agent,
  chats,
  onPress,
  testID,
}: {
  run: AgentRun;
  agent: Agent | undefined;
  chats: readonly Chat[];
  onPress(): void;
  testID?: string;
}) {
  const { t, i18n } = useTranslation();
  const theme = useTheme();
  const failed = runFailed(run);
  const name = agent?.display_name ?? t("agentUnknown");
  const sentence = runSentence(t, run, chats);
  const time = today(run.created_at)
    ? formatTime(run.created_at, i18n.language)
    : formatDateTime(run.created_at, i18n.language);
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={`${time}, ${name} ${sentence}`}
      onPress={onPress}
      style={({ pressed }) => [
        styles.runRow,
        pressed && { backgroundColor: theme.surfaceSelected },
      ]}
    >
      <Text tone="muted" size={12.5} style={styles.time}>
        {time}
      </Text>
      <Avatar
        name={name}
        seed={run.agent_id}
        actorID={run.agent_id}
        avatarVersion={agent?.avatar_version}
        size={28}
        agent
      />
      <Text
        size={14.5}
        style={[styles.grow, failed && { color: theme.dangerText }]}
      >
        <Text weight="semibold" size={14.5}>
          {name}
        </Text>{" "}
        {sentence}
      </Text>
      <ChevronRight size={18} color={theme.subtle} />
    </Pressable>
  );
}

/** A figure of the day: runs, waiting actions, failures, spending. */
export function StatTile({
  value,
  label,
  danger = false,
  testID,
}: {
  value: string;
  label: string;
  danger?: boolean;
  testID?: string;
}) {
  const theme = useTheme();
  return (
    <View
      testID={testID}
      accessible
      accessibilityLabel={`${value} ${label}`}
      style={[
        styles.tile,
        {
          backgroundColor: danger ? theme.dangerSoft : theme.surface,
          borderColor: danger ? theme.dangerBorder : theme.border,
        },
      ]}
    >
      <Text
        weight="bold"
        size={20}
        numberOfLines={1}
        adjustsFontSizeToFit
        style={danger ? { color: theme.danger } : undefined}
      >
        {value}
      </Text>
      <Text tone="muted" size={12.5}>
        {label}
      </Text>
    </View>
  );
}

/** «2 actions wait for a decision» with a way to them. */
export function AttentionBanner({
  title,
  text,
  actionLabel,
  onAction,
  testID,
}: {
  title: string;
  text?: string;
  actionLabel: string;
  onAction(): void;
  testID?: string;
}) {
  const theme = useTheme();
  return (
    <View
      testID={testID}
      accessibilityRole="summary"
      style={[
        styles.banner,
        { backgroundColor: theme.warningSoft, borderColor: theme.border },
      ]}
    >
      <View style={styles.bannerHead}>
        <AlertTriangle size={18} color={theme.warning} />
        <View style={styles.grow}>
          <Text weight="semibold" size={15}>
            {title}
          </Text>
          {text ? (
            <Text tone="muted" size={13.5}>
              {text}
            </Text>
          ) : null}
        </View>
      </View>
      <Button
        testID={testID ? `${testID}-open` : undefined}
        variant="secondary"
        label={actionLabel}
        onPress={onAction}
      />
    </View>
  );
}

/** Caption over a block, with an optional link on the right. */
export function SectionTitle({
  title,
  trailing,
}: {
  title: string;
  trailing?: ReactNode;
}) {
  return (
    <View style={styles.sectionTitle}>
      <Text
        accessibilityRole="header"
        tone="muted"
        size={13}
        weight="medium"
        style={styles.grow}
      >
        {title}
      </Text>
      {trailing}
    </View>
  );
}

export function TextLink({
  label,
  onPress,
  testID,
}: {
  label: string;
  onPress(): void;
  testID?: string;
}) {
  return (
    <Pressable
      testID={testID}
      accessibilityRole="link"
      hitSlop={10}
      onPress={onPress}
    >
      <Text tone="primary" size={13.5} weight="medium">
        {label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  grow: { flex: 1 },
  shrink: { flexShrink: 1 },
  pill: {
    flexDirection: "row",
    alignItems: "center",
    alignSelf: "flex-start",
    gap: 5,
    borderRadius: radius.full,
    paddingHorizontal: 8,
    paddingVertical: 2,
  },
  pillDot: { width: 6, height: 6, borderRadius: 3 },
  statusLine: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: 6,
    marginTop: 2,
  },
  agentRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: spacing[3],
    paddingHorizontal: spacing[4],
    paddingVertical: spacing[3],
  },
  task: { marginTop: 4 },
  runRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing[2],
    paddingHorizontal: spacing[4],
    paddingVertical: spacing[3],
  },
  time: { width: 46 },
  tile: {
    flexGrow: 1,
    flexBasis: "45%",
    borderWidth: 1,
    borderRadius: radius.lg,
    padding: spacing[3],
    gap: 2,
  },
  banner: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.lg,
    padding: spacing[3],
    gap: spacing[3],
  },
  bannerHead: { flexDirection: "row", gap: spacing[2] },
  sectionTitle: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: spacing[1],
  },
});
