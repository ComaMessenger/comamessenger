import { StyleSheet, View } from "react-native";
import type { ErrorBoundaryProps } from "expo-router";
import { useTranslation } from "react-i18next";
import { spacing } from "@comamessenger/tokens";
import { useTheme } from "@/lib/theme";
import { Notice } from "./Notice";
import { ScreenHeader } from "./ScreenHeader";

/**
 * Error boundary of a pushed screen: a route file re-exports it as
 * `ErrorBoundary`, so a render failure shows a retry instead of a red screen
 * and keeps the back button.
 */
export function RouteError({ retry }: ErrorBoundaryProps) {
  const { t } = useTranslation();
  const theme = useTheme();
  return (
    <View style={[styles.screen, { backgroundColor: theme.canvas }]}>
      <ScreenHeader title="" />
      <View style={styles.body} testID="route-error">
        <Notice
          title={t("screenFailed")}
          hint={t("screenFailedHint")}
          actionLabel={t("retry")}
          onAction={() => void retry()}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  body: { padding: spacing[4] },
});
