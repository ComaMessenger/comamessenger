import { Pressable, StyleSheet } from "react-native";
import { radius, spacing } from "@comamessenger/tokens";
import { useTheme } from "@/lib/theme";
import { BottomSheet } from "./BottomSheet";
import { Text } from "./Text";

export type SheetOption<T extends string> = {
  value: T;
  label: string;
  danger?: boolean;
};

/** Bottom sheet with a list of choices; works the same on both platforms. */
export function ActionSheet<T extends string>({
  visible,
  title,
  options,
  onSelect,
  onClose,
}: {
  visible: boolean;
  title?: string;
  options: SheetOption<T>[];
  onSelect(value: T): void;
  onClose(): void;
}) {
  const theme = useTheme();
  return (
    <BottomSheet visible={visible} title={title} onClose={onClose}>
      {options.map((option) => (
        <Pressable
          key={option.value}
          accessibilityRole="menuitem"
          onPress={() => onSelect(option.value)}
          style={({ pressed }) => [
            styles.item,
            pressed && { backgroundColor: theme.surfaceSelected },
          ]}
        >
          <Text size={16} tone={option.danger ? "danger" : "default"}>
            {option.label}
          </Text>
        </Pressable>
      ))}
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  item: {
    minHeight: 52,
    justifyContent: "center",
    paddingHorizontal: spacing[3],
    borderRadius: radius.lg,
  },
});
