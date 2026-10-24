import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  type PressableProps,
} from "react-native";
import { radius, spacing } from "@comamessenger/tokens";
import { useTheme } from "@/lib/theme";
import { Text } from "./Text";

export function Button({
  label,
  variant = "primary",
  pending = false,
  disabled,
  ...props
}: Omit<PressableProps, "children"> & {
  label: string;
  variant?: "primary" | "secondary" | "ghost";
  pending?: boolean;
}) {
  const theme = useTheme();
  const inactive = disabled || pending;
  const background =
    variant === "primary"
      ? theme.action
      : variant === "secondary"
        ? theme.surface
        : "transparent";
  const foreground =
    variant === "primary"
      ? theme.onAction
      : variant === "ghost"
        ? theme.primary
        : theme.foreground;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: inactive, busy: pending }}
      disabled={inactive}
      {...props}
      style={({ pressed }) => [
        styles.button,
        {
          backgroundColor: pressed
            ? variant === "primary"
              ? theme.actionHover
              : theme.surfaceSelected
            : background,
          borderColor: variant === "secondary" ? theme.border : "transparent",
          opacity: inactive && !pending ? 0.5 : 1,
        },
      ]}
    >
      {pending ? (
        <ActivityIndicator color={foreground} />
      ) : (
        <Text
          weight="medium"
          size={16}
          style={{ color: foreground, textAlign: "center" }}
        >
          {label}
        </Text>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: {
    minHeight: 48,
    borderRadius: radius.md,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: spacing[5],
    paddingVertical: spacing[2],
  },
});
