import { StyleSheet, View } from "react-native";
import { useTranslation } from "react-i18next";
import { useStore } from "zustand";
import { spacing } from "@comamessenger/tokens";
import { useTheme } from "@/lib/theme";
import { Text } from "@/ui/Text";
import { useMessenger } from "./MessengerProvider";

/** Quiet strip while the realtime connection is not live. */
export function ConnectionBanner() {
  const { t } = useTranslation();
  const theme = useTheme();
  const { store } = useMessenger();
  const realtime = useStore(store, (state) => state.realtime);
  const text =
    realtime === "reconnecting"
      ? t("realtimeReconnecting")
      : realtime === "connecting" || realtime === "authenticating"
        ? t("realtimeConnecting")
        : "";
  if (!text) return null;
  return (
    <View
      testID="connection-banner"
      accessibilityLiveRegion="polite"
      style={[styles.banner, { backgroundColor: theme.sidebar }]}
    >
      <Text tone="muted" size={13} weight="medium">
        {text}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  banner: { alignItems: "center", paddingVertical: spacing[1] },
});
