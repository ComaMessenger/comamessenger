import { StyleSheet, Text, View } from "react-native";
import { radius, spacing } from "@comamessenger/tokens";
import { useTheme } from "@/lib/theme";

// Placeholder until M1 adds the server address and sign-in flow.
export default function Index() {
  const theme = useTheme();
  return (
    <View style={styles.screen}>
      <View style={[styles.mark, { backgroundColor: theme.primary }]} />
      <Text style={[styles.title, { color: theme.foreground }]}>Coma</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: spacing[4],
  },
  mark: { width: 64, height: 64, borderRadius: radius.xl },
  title: { fontSize: 28, fontWeight: "600" },
});
