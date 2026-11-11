import type { ReactNode } from "react";
import {
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTranslation } from "react-i18next";
import { useTheme } from "@/lib/theme";
import { Text } from "./Text";

/**
 * Sheet that rises from the bottom over a dimmed screen: grab handle, title
 * with an optional action on the right, scrolling content.
 */
export function BottomSheet({
  visible,
  title,
  action,
  onClose,
  children,
  testID,
}: {
  visible: boolean;
  title?: string;
  /** Header action such as «Done». */
  action?: { label: string; disabled?: boolean; onPress(): void };
  onClose(): void;
  children: ReactNode;
  testID?: string;
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
      statusBarTranslucent
    >
      <KeyboardAvoidingView
        style={styles.root}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t("close")}
          style={[StyleSheet.absoluteFill, { backgroundColor: theme.overlay }]}
          onPress={onClose}
        />
        <View
          testID={testID}
          accessibilityViewIsModal
          style={[
            styles.sheet,
            {
              backgroundColor: theme.surface,
              maxHeight: "88%",
              paddingBottom: Math.max(insets.bottom, 22),
            },
          ]}
        >
          <View
            style={[styles.grab, { backgroundColor: theme.borderStrong }]}
          />
          {title || action ? (
            <View style={styles.head}>
              <Text
                accessibilityRole="header"
                weight="bold"
                size={17}
                numberOfLines={1}
                style={styles.title}
              >
                {title}
              </Text>
              {action ? (
                <Pressable
                  testID={testID ? `${testID}-action` : undefined}
                  accessibilityRole="button"
                  accessibilityState={{ disabled: Boolean(action.disabled) }}
                  disabled={action.disabled}
                  hitSlop={10}
                  onPress={action.onPress}
                  style={styles.action}
                >
                  <Text
                    weight="semibold"
                    size={15}
                    style={{
                      color: action.disabled ? theme.subtle : theme.primary,
                    }}
                  >
                    {action.label}
                  </Text>
                </Pressable>
              ) : null}
            </View>
          ) : null}
          <ScrollView
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}
            bounces={false}
          >
            {children}
          </ScrollView>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, justifyContent: "flex-end" },
  // Prototype: `.sheet { border-radius: 24px 24px 0 0; padding: 8px 16px 22px }`.
  sheet: {
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    paddingTop: 8,
    paddingHorizontal: 16,
  },
  grab: {
    width: 36,
    height: 4,
    borderRadius: 2,
    alignSelf: "center",
    marginBottom: 12,
  },
  head: {
    flexDirection: "row",
    alignItems: "center",
    marginBottom: 12,
    minHeight: 24,
  },
  title: { flex: 1 },
  action: {
    minHeight: 44,
    minWidth: 44,
    justifyContent: "center",
    alignItems: "flex-end",
  },
});
