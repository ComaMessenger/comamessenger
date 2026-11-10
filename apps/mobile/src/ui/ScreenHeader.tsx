import type { ReactNode } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { router } from "expo-router";
import { ChevronLeft } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { radius, spacing } from "@comamessenger/tokens";
import { useTheme } from "@/lib/theme";
import { Text } from "./Text";

/** Back button and title of a pushed screen. */
export function ScreenHeader({
  title,
  trailing,
}: {
  title: string;
  trailing?: ReactNode;
}) {
  const { t } = useTranslation();
  const theme = useTheme();
  return (
    <View
      style={[
        styles.header,
        { borderBottomColor: theme.border, backgroundColor: theme.surface },
      ]}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t("back")}
        style={({ pressed }) => [
          styles.back,
          pressed && { backgroundColor: theme.surfaceSelected },
        ]}
        onPress={() => router.back()}
      >
        <ChevronLeft size={24} color={theme.muted} />
      </Pressable>
      <Text
        accessibilityRole="header"
        weight="semibold"
        size={17}
        numberOfLines={1}
        style={styles.title}
      >
        {title}
      </Text>
      {trailing}
    </View>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing[2],
    minHeight: 60,
    paddingHorizontal: spacing[2],
    paddingVertical: spacing[2],
    borderBottomWidth: 1,
  },
  back: {
    width: 44,
    height: 44,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radius.md,
  },
  title: { flex: 1 },
});
