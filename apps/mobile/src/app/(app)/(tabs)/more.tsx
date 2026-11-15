import { useCallback, useEffect, useState } from "react";
import {
  Alert,
  Linking,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
} from "react-native";
import Constants from "expo-constants";
import {
  Bell,
  BookOpen,
  ChevronRight,
  Contact,
  Clock,
  ExternalLink,
  LogOut,
  Network,
  Moon,
  Repeat2,
  Settings,
  type LucideIcon,
} from "lucide-react-native";
import { router } from "expo-router";
import * as Notifications from "expo-notifications";
import { useTranslation } from "react-i18next";
import { radius, spacing } from "@comamessenger/tokens";
import { useSession, useSignedIn } from "@/session/SessionProvider";
import { displayServer } from "@/lib/server";
import { useTheme } from "@/lib/theme";
import { openWebClient } from "@/lib/web";
import { Avatar } from "@/ui/Avatar";
import { Text } from "@/ui/Text";
import { registerForPush, type PushAvailability } from "@/push/registration";
import { pickAndUploadAvatar } from "@/files/avatar";
import { ActionSheet } from "@/ui/ActionSheet";
import { TabHeader } from "@/ui/TabHeader";
import { useOrg } from "@/org/useOrg";
import { AwayBadge } from "@/ui/AwayBadge";
import { StatusSheet } from "@/status/StatusSheet";
import {
  useAwayNow,
  useMyAway,
  useSelfAway,
  useSubstituting,
  useWorkspacePeople,
} from "@/status/useAway";
import { calendarLocale } from "@/requests/locale";
import {
  avatarBadge,
  awayNotificationsText,
  firstName,
  myStatusSummary,
  substitutingLine,
} from "@comamessenger/core";

export default function MoreScreen() {
  const { t, i18n } = useTranslation();
  const theme = useTheme();
  const { api, user } = useSignedIn();
  const { signOut, updateUser } = useSession();
  const [photoMenu, setPhotoMenu] = useState(false);
  // «Оргструктура»: when there is a department or the reader may make one.
  const org = useOrg();
  const showsOrg = Boolean(org.structure?.departments.length) || org.canManage;
  const [statusOpen, setStatusOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 2200);
    return () => clearTimeout(timer);
  }, [notice]);
  // «Отсутствую» and «Свой статус» (phase 6.7): the status row, «Вы
  // замещаете …» and «Уведомления: выкл. до …».
  const locale = calendarLocale(i18n.language);
  const selfAway = useSelfAway();
  const myAway = useMyAway();
  const substituting = useSubstituting();
  const now = useAwayNow([
    selfAway,
    ...(substituting.data ?? []).map((entry) => entry.away),
  ]);
  const everyone = useWorkspacePeople(Boolean(substituting.data?.length));
  const summary = myStatusSummary({ ...user, away: selfAway }, now, locale);
  const badge = avatarBadge(null, selfAway, now);
  const mutedUntil = awayNotificationsText(selfAway, now, locale);
  const statusSub =
    summary.kind === "away"
      ? [
          myAway.data
            ? t(
                myAway.data.autoreply.enabled
                  ? "moreStatusAutoreplyOn"
                  : "moreStatusAutoreplyOff",
              )
            : null,
          myAway.data?.substitute_id &&
          everyone.byID.get(myAway.data.substitute_id)
            ? t("moreStatusSubstitute", {
                name: firstName(
                  everyone.byID.get(myAway.data.substitute_id)!.display_name,
                ),
              })
            : null,
        ]
          .filter(Boolean)
          .join(" · ")
      : summary.kind === "planned"
        ? summary.custom
          ? t("moreStatusPlannedHint", {
              status: [summary.custom.emoji, summary.custom.text]
                .filter(Boolean)
                .join(" "),
            })
          : ""
        : summary.kind === "custom"
          ? t("moreStatusCustomHint")
          : t("moreStatusSetHint");

  async function changePhoto(action: "change" | "remove") {
    setPhotoMenu(false);
    try {
      if (action === "remove") await api.deleteMyAvatar();
      else {
        // Let the sheet finish closing before the system picker appears.
        await new Promise((resolve) => setTimeout(resolve, 400));
        if (!(await pickAndUploadAvatar(api))) return;
      }
      updateUser(await api.me());
    } catch {
      Alert.alert(t("actionFailed"));
    }
  }
  const [push, setPush] = useState<PushAvailability | "off" | null>(null);

  const refreshPush = useCallback(
    (prompt: boolean) =>
      registerForPush(api, { prompt })
        .then(setPush)
        .catch(() => setPush("off")),
    [api],
  );
  useEffect(() => {
    void Notifications.getPermissionsAsync().then((permission) =>
      permission.granted
        ? refreshPush(false)
        : setPush(permission.canAskAgain ? "off" : "denied"),
    );
  }, [refreshPush]);

  const pushStatus =
    push === "ready"
      ? t("notificationsOn")
      : push === "denied"
        ? t("notificationsDenied")
        : push === "unsupported"
          ? t("notificationsUnsupported")
          : t("notificationsOff");

  function confirmSignOut() {
    Alert.alert(t("signOutConfirm"), undefined, [
      { text: t("cancel"), style: "cancel" },
      {
        text: t("signOut"),
        style: "destructive",
        onPress: () => void signOut(),
      },
    ]);
  }

  return (
    <View style={[styles.screen, { backgroundColor: theme.canvas }]}>
      <TabHeader title={t("tabMore")} />
      <ScrollView contentContainerStyle={styles.content}>
        <View
          style={[
            styles.card,
            { backgroundColor: theme.surface, borderColor: theme.border },
          ]}
        >
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t("changePhoto")}
            onPress={() => setPhotoMenu(true)}
          >
            <AwayBadge badge={badge} size={56} testID="more-away-badge">
              <Avatar
                name={user.display_name}
                seed={user.id}
                size={56}
                actorID={user.id}
                avatarVersion={user.avatar_version}
              />
            </AwayBadge>
          </Pressable>
          <View style={styles.grow}>
            <Text weight="semibold" size={18} numberOfLines={1}>
              {user.display_name}
            </Text>
            <Text tone="muted" size={15} numberOfLines={1}>
              @{user.handle} · {user.organization_name}
            </Text>
            <Text tone="subtle" size={13} numberOfLines={1}>
              {displayServer(api.apiURL)}
            </Text>
          </View>
        </View>

        {/* Prototype «Отсутствую», phone A: `.stbtn` under the profile. */}
        <Pressable
          testID="more-status"
          accessibilityRole="button"
          accessibilityLabel={[
            summary.kind === "none" ? t("moreStatusSet") : summary.text,
            statusSub,
          ]
            .filter(Boolean)
            .join(", ")}
          onPress={() => setStatusOpen(true)}
          style={({ pressed }) => [
            styles.status,
            {
              backgroundColor: pressed ? theme.surfaceSelected : theme.surface,
              borderColor: theme.border,
            },
          ]}
        >
          <View
            style={[
              styles.statusMark,
              {
                backgroundColor:
                  summary.kind === "away" || summary.kind === "planned"
                    ? theme.warningSoft
                    : theme.surfaceSelected,
              },
            ]}
          >
            {summary.kind === "none" || !summary.emoji ? (
              <Moon size={18} color={theme.muted} />
            ) : (
              <Text size={17} allowFontScaling={false}>
                {summary.emoji}
              </Text>
            )}
          </View>
          <View style={styles.grow}>
            <Text testID="more-status-text" size={15} numberOfLines={2}>
              {summary.kind === "none" ? t("moreStatusSet") : summary.text}
            </Text>
            {statusSub ? (
              <Text tone="muted" size={12.5} numberOfLines={2}>
                {statusSub}
              </Text>
            ) : null}
          </View>
          <ChevronRight size={20} color={theme.muted} />
        </Pressable>

        {substituting.data?.length ? (
          <View
            style={[
              styles.group,
              { backgroundColor: theme.surface, borderColor: theme.border },
            ]}
          >
            {substituting.data.map((entry, index) => {
              const name =
                everyone.byID.get(entry.actor_id)?.display_name ?? "";
              return (
                <View key={entry.actor_id}>
                  {index > 0 && (
                    <View
                      style={[
                        styles.divider,
                        { backgroundColor: theme.border },
                      ]}
                    />
                  )}
                  <Pressable
                    testID={`more-substituting-${index}`}
                    accessibilityRole="button"
                    accessibilityHint={t("moreSubstitutingHint")}
                    onPress={() => router.push(`/people/${entry.actor_id}`)}
                    style={({ pressed }) => [
                      styles.item,
                      pressed && { backgroundColor: theme.surfaceSelected },
                    ]}
                  >
                    <Repeat2 size={20} color={theme.primary} />
                    <Text weight="medium" size={15} style={styles.grow}>
                      {name
                        ? substitutingLine(entry, name, now, locale)
                        : "…"}
                    </Text>
                    <ChevronRight size={20} color={theme.subtle} />
                  </Pressable>
                </View>
              );
            })}
          </View>
        ) : null}

        <View
          style={[
            styles.group,
            { backgroundColor: theme.surface, borderColor: theme.border },
          ]}
        >
          {(
            [
              ["/people", t("people"), Contact, "open-people"],
              ...(showsOrg
                ? ([["/org", t("orgTitle"), Network, "open-org"]] as const)
                : []),
              ["/scheduled", t("scheduledMoreItem"), Clock, "more-scheduled"],
              ["/knowledge", t("knowledgeBase"), BookOpen, "more-knowledge"],
              ["/settings", t("settingsTitle"), Settings, "open-settings"],
            ] as const
          ).map(
            (
              [href, label, Icon, testID]: readonly [
                string,
                string,
                LucideIcon,
                string,
              ],
              index,
            ) => (
              <View key={href}>
                {index > 0 && (
                  <View
                    style={[styles.divider, { backgroundColor: theme.border }]}
                  />
                )}
                <Pressable
                  testID={testID}
                  accessibilityRole="button"
                  onPress={() => router.push(href as never)}
                  style={({ pressed }) => [
                    styles.item,
                    pressed && { backgroundColor: theme.surfaceSelected },
                  ]}
                >
                  <Icon size={20} color={theme.muted} />
                  <Text weight="medium" size={16} style={styles.grow}>
                    {label}
                  </Text>
                  <ChevronRight size={20} color={theme.subtle} />
                </Pressable>
              </View>
            ),
          )}
        </View>

        <View
          style={[
            styles.group,
            { backgroundColor: theme.surface, borderColor: theme.border },
          ]}
        >
          <View style={[styles.item, styles.notificationRow]}>
            <Bell size={20} color={theme.muted} />
            <View style={[styles.grow, styles.notificationBody]}>
              <Text weight="medium" size={16}>
                {t("notifications")}
              </Text>
              <Text testID="more-notifications-status" tone="muted" size={14}>
                {mutedUntil ?? pushStatus}
              </Text>
            </View>
            {(push === "off" || push === "denied") && (
              <Pressable
                accessibilityRole="button"
                style={styles.inlineAction}
                onPress={() =>
                  push === "denied"
                    ? void Linking.openSettings()
                    : void refreshPush(true)
                }
              >
                <Text weight="semibold" size={16} tone="primary">
                  {push === "denied"
                    ? t("openSettings")
                    : t("enableNotifications")}
                </Text>
              </Pressable>
            )}
          </View>
          <View style={[styles.divider, { backgroundColor: theme.border }]} />
          <Pressable
            accessibilityRole="link"
            onPress={() => void openWebClient(api.apiURL)}
            style={styles.item}
          >
            <ExternalLink size={20} color={theme.muted} />
            <View style={styles.grow}>
              <Text weight="medium" size={16}>
                {t("openWeb")}
              </Text>
              <Text tone="muted" size={14}>
                {t("openWebHint")}
              </Text>
            </View>
            <ChevronRight size={20} color={theme.subtle} />
          </Pressable>
          <View style={[styles.divider, { backgroundColor: theme.border }]} />
          <Pressable
            accessibilityRole="button"
            onPress={confirmSignOut}
            style={styles.item}
          >
            <LogOut size={22} color={theme.danger} />
            <Text weight="medium" size={16} tone="danger" style={styles.grow}>
              {t("signOut")}
            </Text>
          </Pressable>
        </View>

        <Text tone="subtle" size={13} style={styles.version}>
          {t("appVersion", { version: Constants.expoConfig?.version ?? "" })}
        </Text>
      </ScrollView>
      <StatusSheet
        visible={statusOpen}
        onClose={() => setStatusOpen(false)}
        onNotice={setNotice}
      />
      {notice ? (
        <View
          pointerEvents="none"
          accessibilityLiveRegion="polite"
          style={[styles.notice, { backgroundColor: theme.action }]}
        >
          <Text size={14} weight="medium" style={{ color: theme.onAction }}>
            {notice}
          </Text>
        </View>
      ) : null}
      <ActionSheet<"change" | "remove">
        visible={photoMenu}
        options={[
          { value: "change", label: t("changePhoto") },
          ...(user.avatar_version > 0
            ? [
                {
                  value: "remove" as const,
                  label: t("removePhoto"),
                  danger: true,
                },
              ]
            : []),
        ]}
        onSelect={(action) => void changePhoto(action)}
        onClose={() => setPhotoMenu(false)}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  content: {
    paddingTop: spacing[4],
    paddingHorizontal: spacing[4],
    paddingBottom: spacing[6],
    gap: spacing[4],
    width: "100%",
    maxWidth: 640,
    alignSelf: "center",
  },
  card: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing[3],
    padding: spacing[4],
    borderRadius: radius.lg,
    borderWidth: 1,
  },
  group: { borderRadius: radius.lg, borderWidth: 1, overflow: "hidden" },
  item: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing[3],
    paddingHorizontal: spacing[4],
    paddingVertical: spacing[3],
    minHeight: 56,
  },
  divider: { height: StyleSheet.hairlineWidth, marginLeft: 54 },
  notificationRow: { flexWrap: "wrap" },
  notificationBody: { minWidth: 140 },
  inlineAction: { minHeight: 44, minWidth: 44, justifyContent: "center" },
  grow: { flex: 1 },
  version: { textAlign: "center" },
  // `.stbtn`: 16 radius, a 34×34 mark on the warning soft.
  status: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    borderRadius: radius.xl,
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 11,
  },
  statusMark: {
    width: 34,
    height: 34,
    borderRadius: 11,
    alignItems: "center",
    justifyContent: "center",
  },
  notice: {
    position: "absolute",
    alignSelf: "center",
    bottom: spacing[4],
    borderRadius: 18,
    paddingHorizontal: spacing[4],
    paddingVertical: spacing[2],
    maxWidth: "90%",
  },
});
