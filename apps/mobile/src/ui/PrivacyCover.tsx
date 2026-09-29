import { useEffect, useState } from "react";
import { AppState, StyleSheet, View } from "react-native";
import { useTheme } from "@/lib/theme";
import { WorkspaceMark } from "./WorkspaceMark";

/**
 * Covers the screen while the app is inactive, so the snapshot the system
 * keeps for the app switcher shows no messages.
 */
export function PrivacyCover() {
  const theme = useTheme();
  const [hidden, setHidden] = useState(AppState.currentState !== "active");
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) =>
      setHidden(state !== "active"),
    );
    return () => subscription.remove();
  }, []);
  if (!hidden) return null;
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[
        StyleSheet.absoluteFill,
        styles.cover,
        { backgroundColor: theme.canvas },
      ]}
    >
      <WorkspaceMark name="Coma" size={64} />
    </View>
  );
}

const styles = StyleSheet.create({
  cover: { alignItems: "center", justifyContent: "center", zIndex: 1000 },
});
