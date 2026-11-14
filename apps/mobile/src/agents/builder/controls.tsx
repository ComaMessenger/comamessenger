import type { ReactNode } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { Lock, ShieldCheck } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import type { AgentConfirmationMode } from "@comamessenger/core";
import { radius, spacing } from "@comamessenger/tokens";
import { useTheme } from "@/lib/theme";
import { Text } from "@/ui/Text";

/** A pill that is chosen or not: tone, week days, answer options, examples. */
export function Chip({
  label,
  selected = false,
  onPress,
  accessibilityLabel,
  testID,
  outline = false,
  disabled,
}: {
  label: string;
  selected?: boolean;
  onPress(): void;
  accessibilityLabel?: string;
  testID?: string;
  /** An answer to tap rather than a state to switch. */
  outline?: boolean;
  disabled?: boolean;
}) {
  const theme = useTheme();
  return (
    <Pressable
      testID={testID}
      accessibilityRole={outline ? "button" : "checkbox"}
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={
        outline ? { disabled } : { checked: selected, disabled }
      }
      disabled={disabled}
      onPress={onPress}
      hitSlop={{ top: 4, bottom: 4 }}
      style={({ pressed }) => [
        styles.chip,
        {
          backgroundColor: selected
            ? theme.action
            : pressed
              ? theme.surfaceSelected
              : outline
                ? theme.surface
                : theme.sidebar,
          borderColor: outline
            ? theme.primary
            : selected
              ? theme.action
              : theme.border,
          opacity: disabled ? 0.5 : 1,
        },
      ]}
    >
      <Text
        size={14.5}
        weight="medium"
        style={{
          color: selected
            ? theme.onAction
            : outline
              ? theme.primary
              : theme.foreground,
        }}
      >
        {label}
      </Text>
    </Pressable>
  );
}

export function ChipRow({ children }: { children: ReactNode }) {
  return <View style={styles.chips}>{children}</View>;
}

/** Two or three exclusive options in one pill (the web's Segmented). */
export function Segmented<T extends string>({
  label,
  value,
  items,
  onChange,
  testID,
}: {
  /** Screen reader name of the whole choice. */
  label: string;
  value: T;
  items: Array<{ id: T; label: string; icon?: ReactNode }>;
  onChange(value: T): void;
  testID?: string;
}) {
  const theme = useTheme();
  return (
    <View
      accessibilityRole="radiogroup"
      accessibilityLabel={label}
      testID={testID}
      style={[
        styles.segmented,
        { backgroundColor: theme.sidebar, borderColor: theme.border },
      ]}
    >
      {items.map((item) => {
        const selected = item.id === value;
        return (
          <Pressable
            key={item.id}
            testID={testID ? `${testID}-${item.id}` : undefined}
            accessibilityRole="radio"
            accessibilityLabel={item.label}
            accessibilityState={{ checked: selected }}
            onPress={() => onChange(item.id)}
            style={[
              styles.segment,
              selected && {
                backgroundColor: theme.surface,
                borderColor: theme.borderStrong,
              },
            ]}
          >
            {item.icon}
            <Text
              size={13.5}
              weight={selected ? "semibold" : "medium"}
              numberOfLines={1}
              style={{ color: selected ? theme.foreground : theme.muted }}
            >
              {item.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

/**
 * «Сам» or «После подтверждения» for one action. A mode the server always
 * enforces is shown with a lock, not offered.
 */
export function ModeChoice({
  label,
  mode,
  locked,
  lockedReason,
  onChange,
  testID,
}: {
  label: string;
  mode: AgentConfirmationMode;
  locked: boolean;
  lockedReason: string;
  onChange(mode: AgentConfirmationMode): void;
  testID?: string;
}) {
  const { t } = useTranslation();
  const theme = useTheme();
  if (locked)
    return (
      <View
        accessible
        accessibilityLabel={`${label}: ${t("agentMode_confirm")}. ${lockedReason}`}
        style={[styles.locked, { backgroundColor: theme.warningSoft }]}
        testID={testID}
      >
        <Lock size={14} color={theme.foreground} />
        <Text size={13.5} weight="medium">
          {t("agentMode_confirm")}
        </Text>
      </View>
    );
  return (
    <Segmented<AgentConfirmationMode>
      testID={testID}
      label={t("agentModeChoice", { action: label })}
      value={mode}
      onChange={onChange}
      items={[
        { id: "auto", label: t("agentMode_self") },
        {
          id: "confirm",
          label: t("agentMode_confirm"),
          icon: <ShieldCheck size={14} color={theme.muted} />,
        },
      ]}
    />
  );
}

/** Thin bar of a progress: steps passed, passport items filled. */
export function ProgressBar({
  value,
  total,
  label,
}: {
  value: number;
  total: number;
  label: string;
}) {
  const theme = useTheme();
  return (
    <View
      accessibilityRole="progressbar"
      accessibilityLabel={label}
      accessibilityValue={{ min: 0, max: total, now: value }}
      style={[styles.track, { backgroundColor: theme.border }]}
    >
      <View
        style={[
          styles.fill,
          {
            backgroundColor: theme.primary,
            width: `${total ? Math.min(100, (value / total) * 100) : 0}%`,
          },
        ]}
      />
    </View>
  );
}

/** A quiet line with an icon under a group: notes and safety explanations. */
export function Note({
  icon,
  children,
}: {
  icon?: ReactNode;
  children: string;
}) {
  return (
    <View style={styles.note}>
      {icon}
      <Text tone="muted" size={13.5} style={styles.grow}>
        {children}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  chip: {
    minHeight: 36,
    paddingHorizontal: spacing[3],
    paddingVertical: spacing[1] + 2,
    borderRadius: radius.full,
    borderWidth: 1,
    justifyContent: "center",
  },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: spacing[2] },
  segmented: {
    flexDirection: "row",
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    padding: 2,
    gap: 2,
    alignSelf: "flex-start",
  },
  segment: {
    minHeight: 34,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing[1],
    paddingHorizontal: spacing[3],
    borderRadius: radius.sm,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "transparent",
  },
  locked: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing[1],
    paddingHorizontal: spacing[3],
    minHeight: 34,
    borderRadius: radius.md,
    alignSelf: "flex-start",
  },
  track: { height: 4, borderRadius: 2, overflow: "hidden" },
  fill: { height: 4, borderRadius: 2 },
  note: {
    flexDirection: "row",
    gap: spacing[2],
    alignItems: "flex-start",
    paddingHorizontal: spacing[1],
  },
  grow: { flex: 1 },
});
