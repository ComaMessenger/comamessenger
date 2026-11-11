import { StyleSheet, View } from "react-native";
import { useTheme } from "@/lib/theme";
import { Text } from "./Text";

export function countLabel(value: number) {
  return value > 99 ? "99+" : String(value);
}

/**
 * Unread counter of a row: primary when it needs attention, quiet for a
 * muted chat; `@` marks a mention. Decorative — rows announce the count.
 */
export function CountBadge({
  value,
  tone = "primary",
}: {
  value: number | "@";
  tone?: "primary" | "muted";
}) {
  const theme = useTheme();
  const quiet = tone === "muted";
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[
        styles.badge,
        value === "@" && styles.mention,
        { backgroundColor: quiet ? theme.borderStrong : theme.primary },
      ]}
    >
      <Text
        allowFontScaling={false}
        weight="bold"
        size={12}
        style={[
          styles.label,
          { color: quiet ? theme.foreground : theme.onPrimary },
        ]}
      >
        {value === "@" ? "@" : countLabel(value)}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  // Prototype: `.bdg { min-width: 20px; height: 20px; padding: 0 6px; border-radius: 10px }`.
  badge: {
    minWidth: 20,
    height: 20,
    paddingHorizontal: 6,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
  },
  mention: { paddingHorizontal: 4 },
  label: { lineHeight: 16 },
});
