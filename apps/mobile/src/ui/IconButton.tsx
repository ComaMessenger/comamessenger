import type { ReactNode } from "react";
import {
  Pressable,
  StyleSheet,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import { useTheme } from "@/lib/theme";

export type IconButtonVariant = "plain" | "soft" | "accent" | "danger";

/**
 * Round icon button from the design system. Plain and danger are transparent,
 * soft sits on the selected tint, accent is the primary action in a
 * conversation. The touch target is never smaller than 40 pt.
 */
export function IconButton({
  label,
  icon,
  onPress,
  onLongPress,
  variant = "plain",
  size = 40,
  disabled = false,
  testID,
  hint,
  style,
}: {
  /** Screen reader label; the button has no visible text. */
  label: string;
  /** Receives the colour the icon should take. */
  icon(color: string): ReactNode;
  onPress?(): void;
  onLongPress?(): void;
  variant?: IconButtonVariant;
  size?: number;
  disabled?: boolean;
  testID?: string;
  hint?: string;
  style?: StyleProp<ViewStyle>;
}) {
  const theme = useTheme();
  const colors = {
    plain: {
      background: "transparent",
      pressed: theme.surfaceSelected,
      icon: theme.foreground,
    },
    soft: {
      background: theme.surfaceSelected,
      pressed: theme.border,
      icon: theme.foreground,
    },
    accent: {
      background: theme.primary,
      pressed: theme.primaryHover,
      icon: theme.onPrimary,
    },
    danger: {
      background: "transparent",
      pressed: theme.dangerSoft,
      icon: theme.danger,
    },
  }[variant];
  const slop = Math.max(0, (44 - size) / 2);
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={hint}
      accessibilityState={{ disabled }}
      disabled={disabled}
      hitSlop={slop}
      onPress={onPress}
      onLongPress={onLongPress}
      style={({ pressed }) => [
        styles.button,
        {
          width: size,
          height: size,
          borderRadius: size / 2,
          backgroundColor:
            pressed && !disabled ? colors.pressed : colors.background,
          opacity: disabled ? 0.45 : 1,
          transform: [{ scale: pressed && !disabled ? 0.92 : 1 }],
        },
        style,
      ]}
    >
      {icon(colors.icon)}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: { alignItems: "center", justifyContent: "center" },
});
