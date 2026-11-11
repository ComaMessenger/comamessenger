import { StyleSheet, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { AlertTriangle } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { useTheme } from "@/lib/theme";
import { Button } from "./Button";
import { Text } from "./Text";

/**
 * The screen a route shows when it throws while rendering, instead of the
 * app closing: what happened and «Повторить». Routes export it as
 * `ErrorBoundary` (Expo Router renders it in place of the screen).
 */
export function ScreenError({
  error,
  retry,
}: {
  error: Error;
  retry(): Promise<void>;
}) {
  const { t } = useTranslation();
  const theme = useTheme();
  console.error("[ScreenError]", error);
  return (
    <SafeAreaView
      testID="screen-error"
      style={[styles.screen, { backgroundColor: theme.surface }]}
    >
      <View style={styles.body}>
        <View style={[styles.icon, { backgroundColor: theme.dangerSoft }]}>
          <AlertTriangle size={26} color={theme.danger} />
        </View>
        <Text weight="semibold" size={17} style={styles.center}>
          {t("screenErrorTitle")}
        </Text>
        <Text tone="muted" size={15} style={styles.center}>
          {t("screenErrorHint")}
        </Text>
        <Button
          testID="screen-error-retry"
          label={t("retry")}
          onPress={() => void retry()}
        />
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  body: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 32,
  },
  icon: {
    width: 56,
    height: 56,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 6,
  },
  center: { textAlign: "center" },
});
