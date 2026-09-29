import type { ReactNode } from "react";
import { Pressable, StyleSheet, Switch, View } from "react-native";
import { Check } from "lucide-react-native";
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
          {title.toLocaleUpperCase()}
        </Text>
      ) : null}
      <View style={[styles.group, { backgroundColor: theme.surface }]}>
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
  value,
  disabled,
  onChange,
}: {
  label: string;
  value: boolean;
  disabled?: boolean;
  onChange(value: boolean): void;
}) {
  const theme = useTheme();
  // The whole row toggles, as in system settings.
  return (
    <Pressable
      accessibilityRole="switch"
      accessibilityLabel={label}
      accessibilityState={{ checked: value, disabled }}
      disabled={disabled}
      onPress={() => onChange(!value)}
      style={[styles.row, disabled && styles.disabled]}
    >
      <Text size={17} style={styles.grow}>
        {label}
      </Text>
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
}: {
  label: string;
  selected: boolean;
  onPress(): void;
}) {
  const theme = useTheme();
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityState={{ checked: selected }}
      onPress={onPress}
      style={({ pressed }) => [
        styles.row,
        pressed && { backgroundColor: theme.surfaceSelected },
      ]}
    >
      <Text size={17} style={styles.grow}>
        {label}
      </Text>
      {selected && <Check size={20} color={theme.primary} />}
    </Pressable>
  );
}

export function Divider() {
  const theme = useTheme();
  return <View style={[styles.divider, { backgroundColor: theme.border }]} />;
}

const styles = StyleSheet.create({
  section: { gap: spacing[2] },
  caption: { paddingHorizontal: spacing[4] },
  group: { borderRadius: radius.xl, overflow: "hidden" },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing[3],
    minHeight: 52,
    paddingHorizontal: spacing[4],
  },
  grow: { flex: 1 },
  disabled: { opacity: 0.5 },
  divider: { height: StyleSheet.hairlineWidth, marginLeft: spacing[4] },
});
