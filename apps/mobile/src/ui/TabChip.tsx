import type { ReactNode } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { useTheme } from "@/lib/theme";
import { Text } from "./Text";

/**
 * Pill tab of a horizontal strip (chat folders, chat filter of «Important»).
 * Selected: the dark `action` fill, as in the prototype.
 */
export function TabChip({
  label,
  selected,
  dot,
  count,
  icon,
  dashed,
  accessibilityLabel,
  accessibilityHint,
  testID,
  onPress,
  onLongPress,
}: {
  label?: string;
  selected?: boolean;
  /** Folder colour shown as a dot before the label. */
  dot?: string;
  count?: number;
  /** Replaces the label: a square icon-only chip. */
  icon?: ReactNode;
  dashed?: boolean;
  accessibilityLabel?: string;
  accessibilityHint?: string;
  testID?: string;
  onPress(): void;
  onLongPress?(): void;
}) {
  const theme = useTheme();
  const color = selected ? theme.onAction : theme.muted;
  return (
    <Pressable
      testID={testID}
      accessibilityRole={icon ? "button" : "tab"}
      accessibilityState={icon ? undefined : { selected: Boolean(selected) }}
      accessibilityLabel={accessibilityLabel}
      accessibilityHint={accessibilityHint}
      accessibilityActions={
        onLongPress ? [{ name: "longpress", label: accessibilityHint }] : []
      }
      onAccessibilityAction={(event) => {
        if (event.nativeEvent.actionName === "longpress") onLongPress?.();
      }}
      onPress={onPress}
      onLongPress={onLongPress}
      delayLongPress={350}
      hitSlop={{ top: 5, bottom: 5 }}
      style={({ pressed }) => [
        styles.chip,
        icon ? styles.square : null,
        {
          backgroundColor: selected
            ? theme.action
            : pressed
              ? theme.surfaceSelected
              : theme.surface,
          borderColor: selected ? theme.action : theme.border,
          borderStyle: dashed ? "dashed" : "solid",
        },
      ]}
    >
      {icon ?? (
        <>
          {dot ? <View style={[styles.dot, { backgroundColor: dot }]} /> : null}
          <Text weight="medium" size={14} numberOfLines={1} style={{ color }}>
            {label}
          </Text>
          {count ? (
            <Text weight="semibold" size={12} style={[styles.count, { color }]}>
              {count > 99 ? "99+" : count}
            </Text>
          ) : null}
        </>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  // Prototype: `.fd { height: 34px; padding: 0 12px; border-radius: 17px; gap: 6px }`.
  chip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    minHeight: 34,
    paddingHorizontal: 12,
    borderRadius: 17,
    borderWidth: 1,
  },
  square: { width: 34, paddingHorizontal: 0, justifyContent: "center" },
  dot: { width: 8, height: 8, borderRadius: 4 },
  count: { opacity: 0.8 },
});
