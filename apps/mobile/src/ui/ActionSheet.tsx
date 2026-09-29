import { Modal, Pressable, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTranslation } from "react-i18next";
import { radius, spacing } from "@comamessenger/tokens";
import { useTheme } from "@/lib/theme";
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
  const { t } = useTranslation();
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onClose}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t("cancel")}
        style={[StyleSheet.absoluteFill, { backgroundColor: theme.overlay }]}
        onPress={onClose}
      />
      <View
        accessibilityRole="menu"
        style={[
          styles.sheet,
          {
            backgroundColor: theme.surface,
            paddingBottom: insets.bottom + spacing[2],
          },
        ]}
      >
        {title ? (
          <Text tone="muted" size={14} weight="medium" style={styles.title}>
            {title}
          </Text>
        ) : null}
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
            <Text size={17} tone={option.danger ? "danger" : "default"}>
              {option.label}
            </Text>
          </Pressable>
        ))}
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  sheet: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    borderTopLeftRadius: radius.xl,
    borderTopRightRadius: radius.xl,
    paddingTop: spacing[3],
  },
  title: { paddingHorizontal: spacing[5], paddingBottom: spacing[2] },
  item: {
    minHeight: 52,
    justifyContent: "center",
    paddingHorizontal: spacing[5],
  },
});
