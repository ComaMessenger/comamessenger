import { ActivityIndicator, Pressable, StyleSheet } from "react-native";
import { spacing } from "@comamessenger/tokens";
import { useTheme } from "@/lib/theme";
import { Text } from "@/ui/Text";

/** Text action on the right of a sheet header: «Создать», «Сохранить». */
export function HeaderAction({
  label,
  pending,
  disabled,
  onPress,
  testID,
}: {
  label: string;
  pending?: boolean;
  disabled?: boolean;
  onPress(): void;
  testID?: string;
}) {
  const theme = useTheme();
  const inactive = disabled || pending;
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: inactive, busy: pending }}
      disabled={inactive}
      onPress={onPress}
      style={({ pressed }) => [styles.action, pressed && styles.pressed]}
    >
      {pending ? (
        <ActivityIndicator color={theme.muted} />
      ) : (
        <Text
          weight="semibold"
          size={16}
          style={{ color: inactive ? theme.subtle : theme.primary }}
        >
          {label}
        </Text>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  action: {
    minHeight: 44,
    minWidth: 44,
    paddingHorizontal: spacing[2],
    alignItems: "center",
    justifyContent: "center",
  },
  pressed: { opacity: 0.6 },
});
