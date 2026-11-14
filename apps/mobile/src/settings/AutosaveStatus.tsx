import { Pressable, StyleSheet, View } from "react-native";
import { AlertTriangle, Check } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import type { AutosavePhase } from "@comamessenger/core";
import { radius, spacing } from "@comamessenger/tokens";
import { useTheme } from "@/lib/theme";
import { Text } from "@/ui/Text";

/** «Сохраняем…», «Сохранено» or the error with «Повторить», above a form. */
export function AutosaveStatus({
  phase,
  error,
  onRetry,
}: {
  phase: AutosavePhase;
  error: string;
  onRetry(): void;
}) {
  const { t } = useTranslation();
  const theme = useTheme();
  if (phase === "idle") return null;
  const failed = phase === "error";
  return (
    <View
      testID="autosave-status"
      accessibilityLiveRegion="polite"
      accessibilityRole={failed ? "alert" : undefined}
      style={[
        styles.status,
        {
          backgroundColor: failed ? theme.dangerSoft : theme.surface,
          borderColor: failed ? theme.dangerBorder : theme.border,
        },
      ]}
    >
      {failed ? (
        <AlertTriangle size={18} color={theme.danger} />
      ) : phase === "saved" ? (
        <Check size={18} color={theme.successText} />
      ) : null}
      <Text size={14} tone={failed ? "danger" : "muted"} style={styles.grow}>
        {failed
          ? error || t("autosaveError")
          : phase === "saved"
            ? t("autosaveSaved")
            : t("autosaveSaving")}
      </Text>
      {failed ? (
        <Pressable
          testID="autosave-retry"
          accessibilityRole="button"
          hitSlop={8}
          onPress={onRetry}
          style={styles.retry}
        >
          <Text weight="semibold" size={14} tone="primary">
            {t("retry")}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  status: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing[2],
    minHeight: 40,
    paddingHorizontal: spacing[3],
    paddingVertical: spacing[2],
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
  },
  grow: { flex: 1 },
  retry: { minHeight: 32, justifyContent: "center" },
});
