import { StyleSheet, View } from "react-native";
import { useTheme } from "@/lib/theme";
import { Text } from "./Text";

/** Rounded workspace square with the first letter of its name. */
export function WorkspaceMark({
  name,
  size = 48,
}: {
  name: string;
  size?: number;
}) {
  const theme = useTheme();
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[
        styles.mark,
        {
          width: size,
          height: size,
          borderRadius: Math.round(size * 0.3),
          backgroundColor: theme.primary,
        },
      ]}
    >
      <Text
        weight="bold"
        size={Math.round(size * 0.45)}
        style={{ color: theme.onPrimary }}
      >
        {(name.trim()[0] ?? "C").toUpperCase()}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  mark: { alignItems: "center", justifyContent: "center" },
});
