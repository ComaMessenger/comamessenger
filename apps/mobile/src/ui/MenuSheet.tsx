import type { ReactNode } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { Check } from "lucide-react-native";
import { useTheme } from "@/lib/theme";
import { BottomSheet } from "./BottomSheet";
import { Text } from "./Text";

export type MenuSheetItem =
  | {
      key: string;
      label: string;
      icon?: ReactNode;
      /** Short note on the right, e.g. «3 of 10». */
      meta?: string;
      danger?: boolean;
      disabled?: boolean;
      /** A checkbox item; the sheet stays open after a press. */
      checked?: boolean;
      testID?: string;
      onPress(): void;
    }
  | { key: string; divider: true; label?: string };

/** Bottom sheet with a list of actions; icons, checkboxes and dividers. */
export function MenuSheet({
  visible,
  title,
  items,
  onClose,
  testID,
}: {
  visible: boolean;
  title?: string;
  items: MenuSheetItem[];
  onClose(): void;
  testID?: string;
}) {
  const theme = useTheme();
  return (
    <BottomSheet
      visible={visible}
      title={title}
      onClose={onClose}
      testID={testID}
    >
      <View accessibilityRole="menu">
        {items.map((item) => {
          if ("divider" in item)
            return (
              <View key={item.key}>
                <View
                  style={[styles.divider, { backgroundColor: theme.border }]}
                />
                {item.label ? (
                  <Text
                    tone="muted"
                    weight="semibold"
                    size={12}
                    style={styles.section}
                  >
                    {item.label}
                  </Text>
                ) : null}
              </View>
            );
          const checkable = item.checked !== undefined;
          return (
            <Pressable
              key={item.key}
              testID={item.testID}
              accessibilityRole={checkable ? "checkbox" : "menuitem"}
              accessibilityState={{
                disabled: Boolean(item.disabled),
                checked: checkable ? item.checked : undefined,
              }}
              disabled={item.disabled}
              onPress={() => {
                if (!checkable) onClose();
                item.onPress();
              }}
              style={({ pressed }) => [
                styles.item,
                pressed && { backgroundColor: theme.surfaceSelected },
                item.disabled && styles.disabled,
              ]}
            >
              {item.icon}
              <Text
                size={16}
                tone={item.danger ? "danger" : "default"}
                numberOfLines={1}
                style={styles.label}
              >
                {item.label}
              </Text>
              {item.meta ? (
                <Text tone="muted" size={13}>
                  {item.meta}
                </Text>
              ) : null}
              {checkable ? (
                <View
                  style={[
                    styles.check,
                    item.checked
                      ? {
                          backgroundColor: theme.primary,
                          borderColor: theme.primary,
                        }
                      : { borderColor: theme.borderStrong },
                  ]}
                >
                  {item.checked ? (
                    <Check
                      size={14}
                      strokeWidth={2.6}
                      color={theme.onPrimary}
                    />
                  ) : null}
                </View>
              ) : null}
            </Pressable>
          );
        })}
      </View>
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  item: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    minHeight: 48,
    paddingHorizontal: 10,
    borderRadius: 10,
  },
  label: { flex: 1 },
  disabled: { opacity: 0.45 },
  divider: { height: StyleSheet.hairlineWidth, marginVertical: 4 },
  section: {
    textTransform: "uppercase",
    letterSpacing: 0.5,
    paddingHorizontal: 10,
    paddingTop: 8,
    paddingBottom: 4,
  },
  // Prototype: `.cb { width: 22px; height: 22px; border-radius: 7px }`.
  check: {
    width: 22,
    height: 22,
    borderRadius: 7,
    borderWidth: 1.5,
    alignItems: "center",
    justifyContent: "center",
  },
});

/** iOS shows one modal at a time: open the next one after the sheet fades out. */
export function afterSheetCloses(action: () => void) {
  setTimeout(action, 350);
}
