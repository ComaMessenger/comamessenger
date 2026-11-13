import type { ReactNode } from "react";
import { Modal, Platform, StyleSheet, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { X } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { spacing } from "@comamessenger/tokens";
import { useTheme } from "@/lib/theme";
import { IconButton } from "./IconButton";
import { Text } from "./Text";

/**
 * A screen-sized sheet for a task on top of the current screen, e.g.
 * forwarding a message: a card sheet on iOS, a full screen on Android.
 */
export function PageSheet({
  visible,
  title,
  subtitle,
  trailing,
  onClose,
  children,
  testID,
}: {
  visible: boolean;
  title: string;
  subtitle?: string;
  trailing?: ReactNode;
  onClose(): void;
  children: ReactNode;
  testID?: string;
}) {
  const { t } = useTranslation();
  const theme = useTheme();
  const ios = Platform.OS === "ios";
  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle={ios ? "pageSheet" : "fullScreen"}
      onRequestClose={onClose}
    >
      <SafeAreaView
        testID={testID}
        edges={ios ? ["bottom"] : ["top", "bottom"]}
        style={[styles.screen, { backgroundColor: theme.surface }]}
      >
        <View style={[styles.header, { borderBottomColor: theme.border }]}>
          <IconButton
            label={t("close")}
            onPress={onClose}
            icon={(color) => <X size={22} color={color} />}
          />
          <View style={styles.title}>
            <Text
              accessibilityRole="header"
              weight="bold"
              size={17}
              numberOfLines={1}
            >
              {title}
            </Text>
            {subtitle ? (
              <Text tone="muted" size={12.5} numberOfLines={1}>
                {subtitle}
              </Text>
            ) : null}
          </View>
          {trailing}
        </View>
        {children}
      </SafeAreaView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing[2],
    paddingHorizontal: spacing[2],
    paddingVertical: spacing[2],
    borderBottomWidth: 1,
  },
  title: { flex: 1, minWidth: 0 },
});
