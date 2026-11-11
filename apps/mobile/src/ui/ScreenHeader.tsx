import type { ReactNode } from "react";
import { StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { router } from "expo-router";
import { ChevronLeft } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { spacing } from "@comamessenger/tokens";
import { useTheme } from "@/lib/theme";
import { IconButton } from "./IconButton";
import { Text } from "./Text";

/**
 * White header of a pushed screen. It reaches under the status bar itself,
 * so the screen around it must not add a top safe-area inset.
 */
export function ScreenHeader({
  title,
  subtitle,
  leading,
  trailing,
  onBack = () => router.back(),
  backTestID,
}: {
  title: string;
  subtitle?: ReactNode;
  /** Between the back button and the title, e.g. the chat avatar. */
  leading?: ReactNode;
  trailing?: ReactNode;
  onBack?(): void;
  backTestID?: string;
}) {
  const { t } = useTranslation();
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  return (
    <View
      style={[
        styles.header,
        {
          borderBottomColor: theme.border,
          backgroundColor: theme.surface,
          paddingTop: insets.top + spacing[1],
        },
      ]}
    >
      <IconButton
        testID={backTestID}
        label={t("back")}
        onPress={onBack}
        icon={(color) => <ChevronLeft size={26} color={color} />}
      />
      {leading}
      <View style={styles.title}>
        <Text
          accessibilityRole="header"
          weight="bold"
          size={16}
          numberOfLines={1}
        >
          {title}
        </Text>
        {typeof subtitle === "string" ? (
          <Text tone="muted" size={12.5} numberOfLines={1}>
            {subtitle}
          </Text>
        ) : (
          subtitle
        )}
      </View>
      {trailing}
    </View>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing[2],
    paddingHorizontal: spacing[2],
    paddingBottom: spacing[2],
    borderBottomWidth: 1,
  },
  title: { flex: 1, minWidth: 0 },
});
