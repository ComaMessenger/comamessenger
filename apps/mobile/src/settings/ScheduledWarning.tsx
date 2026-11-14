import { Alert, StyleSheet, View } from "react-native";
import { AlertTriangle } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { pendingCount } from "@comamessenger/core";
import { radius, spacing } from "@comamessenger/tokens";
import { useTheme } from "@/lib/theme";
import { useScheduledList } from "@/scheduled/useScheduled";
import { Text } from "@/ui/Text";

export type GuardedAction = "password" | "email" | "sessions";

const titles: Record<GuardedAction, string> = {
  password: "scheduledWarningPasswordTitle",
  email: "scheduledWarningEmailTitle",
  sessions: "scheduledWarningSessionsTitle",
};

/**
 * Changing the password or the email, or signing out other devices, stops
 * the waiting scheduled messages (failure_reason security_reset). The count
 * comes from the author's own list; `guard` asks before such an action.
 */
export function useScheduledGuard() {
  const { t } = useTranslation();
  const scheduled = useScheduledList();
  const count = pendingCount(scheduled.data ?? []);
  function guard(action: GuardedAction, run: () => void) {
    if (!count) {
      run();
      return;
    }
    Alert.alert(
      t(titles[action]),
      t("scheduledWarningText", {
        warning: t("scheduledRevokeWarning", { count }),
      }),
      [
        { text: t("cancel"), style: "cancel" },
        {
          text: t("scheduledWarningContinue"),
          style: "destructive",
          onPress: run,
        },
      ],
    );
  }
  return { count, guard, refetch: () => void scheduled.refetch() };
}

/** «2 отложенных сообщения не будут отправлены» under such an action. */
export function ScheduledWarning({ count }: { count: number }) {
  const { t } = useTranslation();
  const theme = useTheme();
  if (!count) return null;
  return (
    <View
      testID="scheduled-warning"
      accessible
      accessibilityRole="text"
      style={[styles.note, { backgroundColor: theme.warningSoft }]}
    >
      <AlertTriangle size={18} color={theme.warning} />
      <Text size={14} style={[styles.grow, { color: theme.foreground }]}>
        {t("scheduledRevokeWarning", { count })}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  note: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing[2],
    padding: spacing[3],
    borderRadius: radius.md,
  },
  grow: { flex: 1 },
});
