import {
  ActivityIndicator,
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { formatListTime, type Session } from "@comamessenger/core";
import { spacing } from "@comamessenger/tokens";
import { useSignedIn } from "@/session/SessionProvider";
import { useTheme } from "@/lib/theme";
import { ScreenHeader } from "@/ui/ScreenHeader";
import { Divider, SettingsGroup } from "@/ui/Settings";
import { Text } from "@/ui/Text";

/** Short device name from a user agent: app or browser, and the platform. */
function deviceName(userAgent: string): string {
  const platform =
    /iPhone|iPad|Darwin/.test(userAgent) && !/Macintosh/.test(userAgent)
      ? "iOS"
      : /Android/.test(userAgent)
        ? "Android"
        : /Mac OS X|Macintosh/.test(userAgent)
          ? "macOS"
          : /Windows/.test(userAgent)
            ? "Windows"
            : /Linux/.test(userAgent)
              ? "Linux"
              : "";
  const client = /CFNetwork|okhttp|Coma\//.test(userAgent)
    ? "Coma"
    : /Edg\//.test(userAgent)
      ? "Edge"
      : /Chrome\//.test(userAgent)
        ? "Chrome"
        : /Firefox\//.test(userAgent)
          ? "Firefox"
          : /Safari\//.test(userAgent)
            ? "Safari"
            : "";
  return (
    [client, platform].filter(Boolean).join(" · ") ||
    userAgent.slice(0, 40) ||
    "—"
  );
}

export default function SessionsScreen() {
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
    onError: () => Alert.alert(t("actionFailed")),
  });
  const revokeOthers = useMutation({
    mutationFn: () => api.revokeOtherSessions(),
    onSettled: refresh,
    onError: () => Alert.alert(t("actionFailed")),
  });
  const list = (sessions.data ?? []).filter((session) => !session.revoked_at);
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
        <View style={styles.grow}>
          <Text size={17} weight="medium">
            {deviceName(session.user_agent)}
          </Text>
          <Text tone="muted" size={14}>
            {session.current
              ? t("thisDevice")
              : t("lastActive", {
                  time: formatListTime(
                    session.last_seen_at,
                    i18n.language,
                    t("yesterday"),
                  ),
                })}
          </Text>
        </View>
        {!session.current && (
          <Pressable
            accessibilityRole="button"
            hitSlop={8}
            onPress={() =>
              confirm(t("revokeSessionConfirm"), () =>
                revoke.mutate(session.id),
              )
            }
          >
            <Text tone="danger" weight="semibold" size={16}>
              {t("revokeSession")}
            </Text>
          </Pressable>
        )}
      </View>
    </View>
  );

  return (
    <SafeAreaView edges={["top"]} style={styles.screen}>
      <ScreenHeader title={t("sessions")} />
      {sessions.isPending ? (
        <ActivityIndicator style={styles.loader} color={theme.muted} />
      ) : (
        <ScrollView contentContainerStyle={styles.content}>
          <SettingsGroup hint={t("sessionsHint")}>
            {list.filter((session) => session.current).map(row)}
          </SettingsGroup>
          {others.length > 0 && (
            <>
              <SettingsGroup>{others.map(row)}</SettingsGroup>
              <SettingsGroup>
                <Pressable
                  accessibilityRole="button"
                  onPress={() =>
                    confirm(t("revokeOthersConfirm"), () =>
                      revokeOthers.mutate(),
                    )
                  }
                  style={styles.row}
                >
                  <Text tone="danger" weight="medium" size={17}>
                    {t("revokeOthers")}
                  </Text>
                </Pressable>
              </SettingsGroup>
            </>
          )}
        </ScrollView>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  content: { padding: spacing[4], gap: spacing[5] },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing[3],
    minHeight: 56,
    paddingHorizontal: spacing[4],
    paddingVertical: spacing[2],
  },
  grow: { flex: 1 },
  loader: { marginTop: spacing[10] },
});
