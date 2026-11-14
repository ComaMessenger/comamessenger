import { useCallback, useEffect, useState } from "react";
import { Alert, Linking, Pressable, StyleSheet, View } from "react-native";
import { useQuery } from "@tanstack/react-query";
import * as Notifications from "expo-notifications";
import { useTranslation } from "react-i18next";
import { sessionLabel, type UserPreferences } from "@comamessenger/core";

type NotificationSchedule = NonNullable<UserPreferences["schedule"]>;
import { radius, spacing } from "@comamessenger/tokens";
import { registerForPush, type PushAvailability } from "@/push/registration";
import { messageOf } from "@/lib/errors";
import { useTheme } from "@/lib/theme";
import { useSession, useSignedIn } from "@/session/SessionProvider";
import {
  ActionRow,
  ChoiceRow,
  Divider,
  GroupBody,
  InfoRow,
  SettingsGroup,
  SwitchRow,
} from "@/ui/Settings";
import { Text } from "@/ui/Text";
import { SettingsScreen } from "./SettingsScreen";
import { TimeRow } from "./PickerRows";
import { usePreferences } from "./preferences";

const snoozeMinutes = [30, 60, 120] as const;
const snoozeLabel = {
  30: "snooze30Minutes",
  60: "snoozeOneHour",
  120: "snoozeTwoHours",
} as const;
/** Monday first, as Russian calendars are; values are JS weekdays. */
const weekOrder = [1, 2, 3, 4, 5, 6, 0];

/**
 * Account-wide notification preferences — everything the web's page edits:
 * inside the app, push, messages and threads, schedule, pause, email digest,
 * connected browsers and per-chat exceptions.
 */
export function NotificationSettings() {
  const { t, i18n } = useTranslation();
  const theme = useTheme();
  const { api, user } = useSignedIn();
  const { branding } = useSession();
  const { query, value, set } = usePreferences();
  const pushConfig = useQuery({
    queryKey: ["push-config"],
    queryFn: () => api.pushConfig(),
  });
  const browsers = useQuery({
    queryKey: ["push-subscriptions"],
    queryFn: () => api.pushSubscriptions(),
  });
  const overrides = useQuery({
    queryKey: ["notification-overrides"],
    queryFn: () => api.chatNotificationOverrides(),
  });
  const [testPending, setTestPending] = useState(false);
  const [phonePush, setPhonePush] = useState<PushAvailability | "off" | null>(
    null,
  );
  const refreshPhonePush = useCallback(
    (prompt: boolean) =>
      registerForPush(api, { prompt })
        .then(setPhonePush)
        .catch(() => setPhonePush("off")),
    [api],
  );
  useEffect(() => {
    void Notifications.getPermissionsAsync().then((permission) =>
      permission.granted
        ? refreshPhonePush(false)
        : setPhonePush(permission.canAskAgain ? "off" : "denied"),
    );
  }, [refreshPhonePush]);

  const format = (iso: string) =>
    new Intl.DateTimeFormat(i18n.language, {
      dateStyle: "medium",
      timeStyle: "short",
    }).format(new Date(iso));

  async function sendTest() {
    setTestPending(true);
    try {
      const result = await api.testPush();
      Alert.alert(
        result.failed
          ? t("testNotificationPartial", result)
          : t("testNotificationSent", result),
      );
    } catch (cause) {
      Alert.alert(messageOf(cause));
    } finally {
      setTestPending(false);
    }
  }

  function setSchedule(schedule: NotificationSchedule | null) {
    set({ schedule });
  }

  const schedule = value?.schedule ?? null;
  const days = schedule?.days;
  return (
    <SettingsScreen
      title={t("settingsNotifications")}
      query={query}
      testID="settings-notifications-screen"
    >
      {value && (
        <>
          <SettingsGroup
            title={t("phonePush")}
            hint={value.push_enabled ? t("pushPreviewHint") : undefined}
          >
            <View style={styles.statusRow}>
              <View style={styles.grow}>
                <Text size={16}>{t("thisPhone")}</Text>
                <Text tone="muted" size={13.5}>
                  {phonePush === "ready"
                    ? t("notificationsOn")
                    : phonePush === "denied"
                      ? t("notificationsDenied")
                      : phonePush === "unsupported"
                        ? t("notificationsUnsupported")
                        : t("notificationsOff")}
                </Text>
              </View>
              {(phonePush === "off" || phonePush === "denied") && (
                <Pressable
                  accessibilityRole="button"
                  hitSlop={8}
                  style={styles.inline}
                  onPress={() =>
                    phonePush === "denied"
                      ? void Linking.openSettings()
                      : void refreshPhonePush(true)
                  }
                >
                  <Text weight="semibold" size={15} tone="primary">
                    {phonePush === "denied"
                      ? t("openSettings")
                      : t("enableNotifications")}
                  </Text>
                </Pressable>
              )}
            </View>
            <Divider />
            <SwitchRow
              testID="notify-push"
              label={t("pushEnabled")}
              value={value.push_enabled}
              onChange={(push_enabled) => set({ push_enabled })}
            />
            <Divider />
            <SwitchRow
              testID="notify-preview"
              label={t("pushPreview")}
              value={value.push_preview}
              disabled={!value.push_enabled}
              onChange={(push_preview) => set({ push_preview })}
            />
          </SettingsGroup>

          <SettingsGroup
            title={t("inAppNotifications")}
            hint={t("inAppNotificationsHint")}
          >
            <SwitchRow
              testID="notify-in-app"
              label={t("inAppNotificationsEnabled")}
              value={value.in_app_enabled}
              onChange={(in_app_enabled) => set({ in_app_enabled })}
            />
            <Divider />
            <SwitchRow
              label={t("soundEnabled")}
              hint={t("inAppSoundHint")}
              value={value.sound_enabled}
              disabled={!value.in_app_enabled}
              onChange={(sound_enabled) => set({ sound_enabled })}
            />
          </SettingsGroup>

          <SettingsGroup title={t("notifyMessages")}>
            {(
              [
                ["all", t("notifyAll")],
                ["direct_and_mentions", t("notifyDirectMentions")],
                ["none", t("notifyNone")],
              ] as const
            ).map(([option, label], index) => (
              <View key={option}>
                {index > 0 && <Divider />}
                <ChoiceRow
                  testID={`notify-messages-${option}`}
                  label={label}
                  selected={value.notify_messages === option}
                  onPress={() => set({ notify_messages: option })}
                />
              </View>
            ))}
          </SettingsGroup>
          <SettingsGroup title={t("notifyThreads")}>
            {(
              [
                ["all", t("notifyAll")],
                ["mentions", t("notifyMentions")],
                ["none", t("notifyNone")],
              ] as const
            ).map(([option, label], index) => (
              <View key={option}>
                {index > 0 && <Divider />}
                <ChoiceRow
                  label={label}
                  selected={value.notify_threads === option}
                  onPress={() => set({ notify_threads: option })}
                />
              </View>
            ))}
          </SettingsGroup>
          <SettingsGroup>
            <SwitchRow
              label={t("notifyReactions")}
              value={value.notify_reactions}
              onChange={(notify_reactions) => set({ notify_reactions })}
            />
            <Divider />
            <SwitchRow
              label={t("notifyInvites")}
              value={value.notify_invites}
              onChange={(notify_invites) => set({ notify_invites })}
            />
            <Divider />
            <SwitchRow
              label={t("notifySystem")}
              value={value.notify_system}
              onChange={(notify_system) => set({ notify_system })}
            />
          </SettingsGroup>

          <SettingsGroup
            title={t("notificationSchedule")}
            hint={
              schedule
                ? t("scheduleTimezone", { timezone: user.timezone })
                : t("notificationScheduleHint")
            }
          >
            <SwitchRow
              testID="notify-schedule"
              label={t("useNotificationSchedule")}
              value={schedule !== null}
              onChange={(enabled) =>
                setSchedule(
                  enabled
                    ? { days: "weekdays", from: "09:00", to: "18:00" }
                    : null,
                )
              }
            />
            {schedule && (
              <>
                <Divider />
                {(
                  [
                    ["all", t("everyDay")],
                    ["weekdays", t("weekdays")],
                    ["custom", t("customDays")],
                  ] as const
                ).map(([mode, label]) => (
                  <View key={mode}>
                    <ChoiceRow
                      testID={`schedule-days-${mode}`}
                      label={label}
                      selected={
                        mode === "custom" ? Array.isArray(days) : days === mode
                      }
                      onPress={() =>
                        setSchedule({
                          ...schedule,
                          days: mode === "custom" ? [1, 2, 3, 4, 5] : mode,
                        })
                      }
                    />
                    <Divider />
                  </View>
                ))}
                {Array.isArray(days) && (
                  <>
                    <View
                      style={styles.days}
                      accessibilityRole="none"
                      accessibilityLabel={t("scheduleDays")}
                    >
                      {weekOrder.map((day) => {
                        const selected = days.includes(day);
                        return (
                          <Pressable
                            key={day}
                            testID={`schedule-day-${day}`}
                            accessibilityRole="checkbox"
                            accessibilityState={{ checked: selected }}
                            accessibilityLabel={t(`weekdayLong${day}`)}
                            onPress={() => {
                              const next = selected
                                ? days.filter((item) => item !== day)
                                : [...days, day].sort();
                              // At least one day stays, as on the web.
                              if (next.length)
                                setSchedule({ ...schedule, days: next });
                            }}
                            style={[
                              styles.day,
                              {
                                backgroundColor: selected
                                  ? theme.primary
                                  : theme.surfaceSelected,
                              },
                            ]}
                          >
                            <Text
                              size={14}
                              weight="semibold"
                              style={{
                                color: selected
                                  ? theme.onPrimary
                                  : theme.foreground,
                              }}
                            >
                              {t(`weekday${day}`)}
                            </Text>
                          </Pressable>
                        );
                      })}
                    </View>
                    <Divider />
                  </>
                )}
                <TimeRow
                  testID="schedule-from"
                  label={t("scheduleFrom")}
                  value={schedule.from}
                  onChange={(from) => setSchedule({ ...schedule, from })}
                />
                <Divider />
                <TimeRow
                  testID="schedule-to"
                  label={t("scheduleTo")}
                  value={schedule.to}
                  onChange={(to) => setSchedule({ ...schedule, to })}
                />
              </>
            )}
          </SettingsGroup>

          <SettingsGroup
            title={t("snoozeNotifications")}
            hint={
              value.snoozed_until
                ? t("snoozedUntil", { time: format(value.snoozed_until) })
                : t("snoozeHint")
            }
          >
            {snoozeMinutes.map((minutes, index) => (
              <View key={minutes}>
                {index > 0 && <Divider />}
                <ActionRow
                  testID={`snooze-${minutes}`}
                  label={t(snoozeLabel[minutes])}
                  tone="default"
                  onPress={() =>
                    set({
                      snoozed_until: new Date(
                        Date.now() + minutes * 60_000,
                      ).toISOString(),
                    })
                  }
                />
              </View>
            ))}
            {value.snoozed_until && (
              <>
                <Divider />
                <ActionRow
                  testID="snooze-resume"
                  label={t("resumeNotifications")}
                  onPress={() => set({ snoozed_until: null })}
                />
              </>
            )}
          </SettingsGroup>

          {branding?.email_delivery_available && (
            <SettingsGroup hint={t("emailDigestHint")}>
              <SwitchRow
                label={t("emailDigest")}
                value={value.email_digest}
                onChange={(email_digest) => set({ email_digest })}
              />
            </SettingsGroup>
          )}

          <SettingsGroup
            title={t("notificationOverrides")}
            hint={t("notificationOverridesHint")}
          >
            {overrides.data?.length ? (
              overrides.data.map((override, index) => (
                <View key={override.chat_id}>
                  {index > 0 && <Divider />}
                  <View style={styles.statusRow}>
                    <View style={styles.grow}>
                      <Text size={16} numberOfLines={1}>
                        {override.name}
                      </Text>
                      <Text tone="muted" size={13.5}>
                        {t(`notificationOverride_${override.notify_level}`)}
                      </Text>
                    </View>
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={`${t("resetToDefault")}: ${override.name}`}
                      hitSlop={8}
                      style={styles.inline}
                      onPress={() =>
                        void api
                          .resetChatNotifications(override.chat_id)
                          .then(() => overrides.refetch())
                          .catch((cause) => Alert.alert(messageOf(cause)))
                      }
                    >
                      <Text weight="semibold" size={15} tone="primary">
                        {t("resetToDefault")}
                      </Text>
                    </Pressable>
                  </View>
                </View>
              ))
            ) : (
              <GroupBody>
                <Text tone="muted" size={14}>
                  {overrides.isError
                    ? messageOf(overrides.error)
                    : t("noNotificationOverrides")}
                </Text>
              </GroupBody>
            )}
          </SettingsGroup>

          <SettingsGroup
            title={t("pushDiagnostics")}
            hint={t("pushDiagnosticsHint")}
          >
            <InfoRow
              label={t("pushServer")}
              value={
                pushConfig.data?.enabled
                  ? t("pushServerReady")
                  : t("pushServerUnavailable")
              }
            />
            {(browsers.data ?? []).map((browser) => (
              <View key={browser.id}>
                <Divider />
                <View style={styles.statusRow}>
                  <View style={styles.grow}>
                    <Text size={16}>
                      {sessionLabel(browser.user_agent, t("unknownDevice"))}
                    </Text>
                    <Text tone="muted" size={13.5}>
                      {format(browser.updated_at)}
                    </Text>
                  </View>
                  <Pressable
                    accessibilityRole="button"
                    hitSlop={8}
                    style={styles.inline}
                    onPress={() =>
                      void api
                        .removePush(browser.id)
                        .then(() => browsers.refetch())
                        .catch((cause) => Alert.alert(messageOf(cause)))
                    }
                  >
                    <Text weight="semibold" size={15} tone="danger">
                      {t("disconnect")}
                    </Text>
                  </Pressable>
                </View>
              </View>
            ))}
            {!browsers.data?.length && (
              <>
                <Divider />
                <GroupBody>
                  <Text tone="muted" size={14}>
                    {t("noPushSubscriptions")}
                  </Text>
                </GroupBody>
              </>
            )}
            <Divider />
            <ActionRow
              label={t("sendTestNotification")}
              pending={testPending}
              disabled={!pushConfig.data?.enabled || !browsers.data?.length}
              onPress={() => void sendTest()}
            />
          </SettingsGroup>
        </>
      )}
    </SettingsScreen>
  );
}

const styles = StyleSheet.create({
  grow: { flex: 1, minWidth: 0 },
  statusRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing[3],
    minHeight: 56,
    paddingHorizontal: spacing[4],
    paddingVertical: spacing[2],
  },
  inline: { minHeight: 44, justifyContent: "center" },
  days: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: spacing[2],
    padding: spacing[3],
  },
  day: {
    minWidth: 40,
    minHeight: 40,
    borderRadius: radius.field,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: spacing[2],
  },
});
