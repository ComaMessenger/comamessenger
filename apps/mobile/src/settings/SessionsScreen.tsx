import { Alert, Pressable, StyleSheet, View } from "react-native";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import {
  formatListTime,
  sessionLabel,
  type Session,
} from "@comamessenger/core";
import { spacing } from "@comamessenger/tokens";
import { MonitorSmartphone } from "lucide-react-native";
import { messageOf } from "@/lib/errors";
import { useSignedIn } from "@/session/SessionProvider";
import { useTheme } from "@/lib/theme";
import { ActionRow, Divider, SettingsGroup } from "@/ui/Settings";
import { Text } from "@/ui/Text";
import { ScheduledWarning, useScheduledGuard } from "./ScheduledWarning";
import { SettingsScreen } from "./SettingsScreen";

/** Devices signed in to the account; end one or all the others. */
export function SessionsScreen() {
  const { t, i18n } = useTranslation();
  const theme = useTheme();
  const { api } = useSignedIn();
  const queryClient = useQueryClient();
  const sessions = useQuery({
    queryKey: ["sessions"],
    queryFn: () => api.sessions(),
  });
  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: ["sessions"] });
  const revoke = useMutation({
    mutationFn: (id: string) => api.revokeSession(id),
    onSettled: refresh,
    onError: (cause) => Alert.alert(messageOf(cause)),
  });
  // Signing out every other device stops the waiting scheduled messages
  // (failure_reason security_reset); say so before it happens.
  const scheduled = useScheduledGuard();
  const revokeOthers = useMutation({
    mutationFn: () => api.revokeOtherSessions(),
    onSettled: () => {
      refresh();
      scheduled.refetch();
    },
    onSuccess: () => Alert.alert(t("otherSessionsRevoked")),
    onError: (cause) => Alert.alert(messageOf(cause)),
  });
  const list = (sessions.data ?? []).filter(
    (session) =>
      !session.revoked_at && Date.parse(session.expires_at) > Date.now(),
  );
  const others = list.filter((session) => !session.current);

  const confirm = (message: string, action: () => void) =>
    Alert.alert(message, undefined, [
      { text: t("cancel"), style: "cancel" },
      { text: t("revokeSession"), style: "destructive", onPress: action },
    ]);

  const row = (session: Session, index: number) => (
    <View key={session.id}>
      {index > 0 && <Divider />}
      <View style={styles.row}>
        <MonitorSmartphone size={20} color={theme.muted} />
        <View style={styles.grow}>
          <Text size={16} weight="medium">
            {sessionLabel(session.user_agent, t("unknownDevice"), {
              nativeApp: "Coma",
            })}
          </Text>
          <Text tone="muted" size={14}>
            {[
              session.current
                ? t("thisDevice")
                : t("lastActive", {
                    time: formatListTime(
                      session.last_seen_at,
                      i18n.language,
                      t("yesterday"),
                    ),
                  }),
              session.ip_address,
            ]
              .filter(Boolean)
              .join(" · ")}
          </Text>
        </View>
        {!session.current && (
          <Pressable
            accessibilityRole="button"
            style={styles.inlineAction}
            onPress={() =>
              confirm(t("revokeSessionConfirm"), () =>
                revoke.mutate(session.id),
              )
            }
          >
            <Text tone="danger" weight="medium" size={14}>
              {t("revokeSession")}
            </Text>
          </Pressable>
        )}
      </View>
    </View>
  );

  return (
    <SettingsScreen
      title={t("sessions")}
      query={sessions}
      testID="settings-sessions-screen"
    >
      <SettingsGroup hint={t("sessionsHint")}>
        {list.filter((session) => session.current).map(row)}
      </SettingsGroup>
      {others.length > 0 && (
        <>
          {/* Above the list: an account may have dozens of sessions. */}
          <SettingsGroup>
            <ActionRow
              testID="sessions-revoke-others"
              tone="danger"
              label={t("revokeOthers")}
              pending={revokeOthers.isPending}
              onPress={() =>
                scheduled.guard("sessions", () =>
                  confirm(t("revokeOthersConfirm"), () =>
                    revokeOthers.mutate(),
                  ),
                )
              }
            />
          </SettingsGroup>
          <ScheduledWarning count={scheduled.count} />
          <SettingsGroup>{others.map(row)}</SettingsGroup>
        </>
      )}
    </SettingsScreen>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing[3],
    minHeight: 56,
    paddingHorizontal: spacing[4],
    paddingVertical: spacing[2],
  },
  grow: { flex: 1 },
  inlineAction: { minHeight: 44, minWidth: 44, justifyContent: "center" },
});
