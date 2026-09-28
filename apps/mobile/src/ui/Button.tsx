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
      ? theme.primary
      : variant === "secondary"
        ? theme.surface
        : "transparent";
  const foreground = variant === "primary" ? theme.onPrimary : theme.primary;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: inactive, busy: pending }}
      disabled={inactive}
      {...props}
      style={({ pressed }) => [
        styles.button,
        {
          backgroundColor: background,
          borderColor: variant === "secondary" ? theme.border : "transparent",
          opacity: inactive && !pending ? 0.5 : pressed ? 0.85 : 1,
        },
      ]}
    >
      {pending ? (
        <ActivityIndicator color={foreground} />
      ) : (
        <Text weight="semibold" size={17} style={{ color: foreground }}>
          {label}
        </Text>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: {
    minHeight: 52,
    borderRadius: radius.full,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: spacing[5],
  },
});
