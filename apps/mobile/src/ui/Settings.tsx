import type { ReactNode } from "react";
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Switch,
  View,
} from "react-native";
import { Check, ChevronRight, type LucideIcon } from "lucide-react-native";
import { radius, spacing } from "@comamessenger/tokens";
import { useTheme } from "@/lib/theme";
import { Text } from "./Text";

export function SettingsGroup({
  title,
  hint,
  children,
}: {
  title?: string;
  hint?: string;
  children: ReactNode;
}) {
  const theme = useTheme();
  return (
    <View style={styles.section}>
      {title ? (
        <Text tone="muted" size={13} weight="medium" style={styles.caption}>
          {title}
        </Text>
      ) : null}
      <View
        style={[
          styles.group,
          { backgroundColor: theme.surface, borderColor: theme.border },
        ]}
      >
        {children}
      </View>
      {hint ? (
        <Text tone="subtle" size={13} style={styles.caption}>
          {hint}
        </Text>
      ) : null}
    </View>
  );
}

export function SwitchRow({
  label,
  hint,
  value,
  disabled,
  onChange,
  testID,
}: {
  label: string;
  /** Second line under the label. */
  hint?: string;
  value: boolean;
  disabled?: boolean;
  onChange(value: boolean): void;
  testID?: string;
}) {
  const theme = useTheme();
  // The whole row toggles, as in system settings.
  return (
    <Pressable
      testID={testID}
      accessibilityRole="switch"
      accessibilityLabel={label}
      accessibilityHint={hint}
      accessibilityState={{ checked: value, disabled }}
      disabled={disabled}
      onPress={() => onChange(!value)}
      style={({ pressed }) => [
        styles.row,
        disabled && styles.disabled,
        pressed && { backgroundColor: theme.surfaceSelected },
      ]}
    >
      <View style={styles.grow}>
        <Text size={16}>{label}</Text>
        {hint ? (
          <Text tone="muted" size={13.5}>
            {hint}
          </Text>
        ) : null}
      </View>
      <Switch
        importantForAccessibility="no"
        accessibilityElementsHidden
        value={value}
        disabled={disabled}
        onValueChange={onChange}
        trackColor={{ true: theme.primary, false: theme.borderStrong }}
      />
    </Pressable>
  );
}

/** One of several options; the selected one carries a check mark. */
export function ChoiceRow({
  label,
  selected,
  onPress,
  testID,
}: {
  label: string;
  selected: boolean;
  onPress(): void;
  testID?: string;
}) {
  const theme = useTheme();
  return (
    <Pressable
      testID={testID}
      accessibilityRole="radio"
      accessibilityState={{ checked: selected }}
      onPress={onPress}
      style={({ pressed }) => [
        styles.row,
        pressed && { backgroundColor: theme.surfaceSelected },
      ]}
    >
      <Text size={16} style={styles.grow}>
        {label}
      </Text>
      {selected && <Check size={20} color={theme.primary} />}
    </Pressable>
  );
}

/**
 * A row that opens a screen or a picker: icon, label with an optional second
 * line, the current value on the right and a chevron.
 */
export function NavRow({
  label,
  hint,
  value,
  icon: Icon,
  onPress,
  testID,
  accessibilityHint,
  disabled,
}: {
  label: string;
  hint?: string;
  value?: string;
  icon?: LucideIcon;
  onPress(): void;
  testID?: string;
  accessibilityHint?: string;
  disabled?: boolean;
}) {
  const theme = useTheme();
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={[label, value, hint].filter(Boolean).join(", ")}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.row,
        disabled && styles.disabled,
        pressed && { backgroundColor: theme.surfaceSelected },
      ]}
    >
      {Icon ? <Icon size={20} color={theme.muted} /> : null}
      <View style={styles.grow}>
        <Text size={16} weight={Icon ? "medium" : "regular"}>
          {label}
        </Text>
        {hint ? (
          <Text tone="muted" size={13.5}>
            {hint}
          </Text>
        ) : null}
      </View>
      {value ? (
        <Text tone="muted" size={15} numberOfLines={1} style={styles.value}>
          {value}
        </Text>
      ) : null}
      {disabled ? null : <ChevronRight size={20} color={theme.subtle} />}
    </Pressable>
  );
}

/** A text button spanning the row: «Сменить пароль», «Отозвать». */
export function ActionRow({
  label,
  tone = "primary",
  icon: Icon,
  pending,
  disabled,
  onPress,
  testID,
  hint,
}: {
  label: string;
  tone?: "primary" | "danger" | "default";
  icon?: LucideIcon;
  pending?: boolean;
  disabled?: boolean;
  onPress(): void;
  testID?: string;
  hint?: string;
}) {
  const theme = useTheme();
  const color =
    tone === "danger"
      ? theme.danger
      : tone === "primary"
        ? theme.primary
        : theme.foreground;
  const inactive = disabled || pending;
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityHint={hint}
      accessibilityState={{ disabled: inactive, busy: pending }}
      disabled={inactive}
      onPress={onPress}
      style={({ pressed }) => [
        styles.row,
        disabled && styles.disabled,
        pressed && { backgroundColor: theme.surfaceSelected },
      ]}
    >
      {Icon ? <Icon size={20} color={color} /> : null}
      <Text weight="medium" size={16} style={[styles.grow, { color }]}>
        {label}
      </Text>
      {pending ? <ActivityIndicator color={theme.muted} /> : null}
    </Pressable>
  );
}

/** A read-only label and value. */
export function InfoRow({
  label,
  value,
  testID,
}: {
  label: string;
  value: string;
  testID?: string;
}) {
  return (
    <View
      testID={testID}
      accessible
      accessibilityLabel={`${label}, ${value}`}
      style={styles.row}
    >
      <Text size={16} style={styles.grow}>
        {label}
      </Text>
      <Text tone="muted" size={15} numberOfLines={2} style={styles.value}>
        {value}
      </Text>
    </View>
  );
}

/** Padding for free content inside a group (fields, previews). */
export function GroupBody({ children }: { children: ReactNode }) {
  return <View style={styles.body}>{children}</View>;
}

export function Divider() {
  const theme = useTheme();
  return <View style={[styles.divider, { backgroundColor: theme.border }]} />;
}

const styles = StyleSheet.create({
  section: { gap: spacing[2] },
  caption: { paddingHorizontal: spacing[1] },
  group: { borderWidth: 1, borderRadius: radius.lg, overflow: "hidden" },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing[3],
    minHeight: 52,
    paddingHorizontal: spacing[4],
    paddingVertical: spacing[2],
  },
  grow: { flex: 1 },
  disabled: { opacity: 0.5 },
  divider: { height: StyleSheet.hairlineWidth, marginLeft: spacing[4] },
  value: { maxWidth: "50%", textAlign: "right" },
  body: { padding: spacing[4], gap: spacing[4] },
});
