import type { ReactNode } from "react";
import { StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTheme } from "@/lib/theme";
import { Text } from "./Text";

/**
 * Title bar of a bottom-tab screen. White (`surface`) from the very top, so the
 * status bar area is part of the header instead of a grey strip.
 */
export function TabHeader({
  title,
  leading,
  trailing,
  children,
}: {
  title: string;
  leading?: ReactNode;
  trailing?: ReactNode;
  /** Rows under the title that belong to the header (search, tabs). */
  children?: ReactNode;
}) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  return (
    <View
      style={[
        styles.header,
        {
          paddingTop: insets.top,
          backgroundColor: theme.surface,
          borderBottomColor: theme.border,
        },
      ]}
    >
      <View style={styles.top}>
        {leading}
        <Text
          accessibilityRole="header"
          weight="bold"
          size={22}
          numberOfLines={1}
          style={styles.title}
        >
          {title}
        </Text>
        {trailing}
      </View>
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  header: { borderBottomWidth: 1 },
  // Prototype: `.top { padding: 6px 14px 8px; gap: 8px }`.
  top: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    minHeight: 52,
    paddingHorizontal: 14,
    paddingTop: 6,
    paddingBottom: 8,
  },
  title: { flex: 1, letterSpacing: -0.2 },
});
