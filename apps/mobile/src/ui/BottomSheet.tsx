import type { ReactNode } from "react";
import { Modal, Pressable, ScrollView, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTranslation } from "react-i18next";
import { radius, spacing } from "@comamessenger/tokens";
import { useTheme } from "@/lib/theme";
import { Text } from "./Text";

/**
 * Sheet that slides over the bottom of the screen: grab handle, optional
 * title, content. A tap on the dimmed background closes it.
 */
export function BottomSheet({
  visible,
  title,
  onClose,
  children,
  testID,
  accessibilityLabel,
}: {
  visible: boolean;
  title?: string;
  onClose(): void;
  children: ReactNode;
  testID?: string;
  accessibilityLabel?: string;
}) {
  const { t } = useTranslation();
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      statusBarTranslucent
      onRequestClose={onClose}
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
        accessibilityLabel={accessibilityLabel ?? title}
        style={[
          styles.sheet,
          {
            backgroundColor: theme.surface,
            paddingBottom: insets.bottom + spacing[4],
          },
        ]}
      >
        <View style={[styles.grab, { backgroundColor: theme.borderStrong }]} />
        {title ? (
          <Text
            accessibilityRole="header"
            weight="bold"
            size={17}
            style={styles.title}
          >
            {title}
          </Text>
        ) : null}
        <ScrollView
          bounces={false}
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={styles.content}
        >
          {children}
        </ScrollView>
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
    maxHeight: "88%",
    borderTopLeftRadius: radius.sheet,
    borderTopRightRadius: radius.sheet,
    paddingTop: spacing[2],
    paddingHorizontal: spacing[4],
  },
  grab: {
    width: 36,
    height: 4,
    borderRadius: 2,
    alignSelf: "center",
    marginBottom: spacing[3],
  },
  title: { marginBottom: spacing[3] },
  content: { flexGrow: 0 },
});
