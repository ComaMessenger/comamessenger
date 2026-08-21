import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { MessengerAPI, User, UserPreferences } from "@comamessenger/core";
import {
  Bell,
  Clock3,
  LogOut,
  MessageCircle,
  MonitorSmartphone,
  RotateCcw,
  Send,
  Volume2,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  Avatar,
  Button,
  Field,
  SelectField,
  Skeleton,
  TextareaField,
} from "../../ui";
import { setLocale } from "../../i18n";
import { setTheme } from "../../theme";
import { messageOf } from "../../errors";
import { AutosaveStatus } from "../components/AutosaveStatus";
import {
  SettingsSection,
  SettingsToggle,
} from "../components/SettingsPrimitives";
import {
  SettingsShell,
  type SettingsNavigate,
} from "../components/SettingsShell";
import { useAutosave } from "../hooks/useAutosave";
import { sessionLabel } from "../sessionLabel";

type ProfileDraft = {
  displayName: string;
  handle: string;
  title: string;
  about: string;
  timezone: string;
  theme: UserPreferences["theme"];
  locale: "ru" | "en";
};

export function ProfileSettingsPage({
  api,
  user,
  navigate,
  onLogout,
  onUserUpdated,
}: {
  api: MessengerAPI;
  user: User;
  navigate: SettingsNavigate;
  onLogout(): void;
  onUserUpdated(user: User): void;
}) {
  const { t } = useTranslation();
  const query = useQuery({
    queryKey: ["preferences"],
    queryFn: () => api.preferences(),
  });
  const [draft, setDraft] = useState<ProfileDraft | null>(null);
  const [avatarPending, setAvatarPending] = useState(false);
  const [avatarError, setAvatarError] = useState("");
  async function changeAvatar(file: File) {
    setAvatarError("");
    if (
      file.size > 10_000_000 ||
      !["image/png", "image/jpeg", "image/webp"].includes(file.type)
    ) {
      setAvatarError(t("avatarValidation"));
      return;
    }
    setAvatarPending(true);
    try {
      const updated = await api.putMyAvatar(file);
      onUserUpdated({ ...user, avatar_version: updated.avatar_version });
    } catch (cause) {
      setAvatarError(messageOf(cause));
    } finally {
      setAvatarPending(false);
    }
  }
  useEffect(() => {
    if (!query.data) return;
    setDraft(
      (current) =>
        current ?? {
          displayName: user.display_name,
          handle: user.handle,
          title: user.title,
          about: user.about,
          timezone: user.timezone,
          theme: query.data.theme,
          locale: query.data.locale,
        },
    );
  }, [query.data, user]);
  const autosave = useAutosave({
    value: draft,
    save: async (snapshot) => {
      const [updatedUser] = await Promise.all([
        api.updateMe({
          display_name: snapshot.displayName,
          handle: snapshot.handle,
          title: snapshot.title,
          about: snapshot.about,
          timezone: snapshot.timezone,
        }),
        api.updatePreferences({
          theme: snapshot.theme,
          locale: snapshot.locale,
        }),
      ]);
      onUserUpdated(updatedUser);
      return snapshot;
    },
  });
  if (!draft) return <Skeleton />;
  return (
    <SettingsShell
      user={user}
      active="profile"
      title={t("profileSettings")}
      navigate={navigate}
    >
      <div className="settings-page__body">
        <AutosaveStatus {...autosave} onRetry={autosave.retry} />
        <article className="profile-settings-card">
          <div className="profile-settings-card__identity">
            <Avatar
              name={draft.displayName}
              seed={user.id}
              actorID={user.id}
              avatarVersion={user.avatar_version}
              size="xl"
              online
            />
            <span>
              <strong>{draft.displayName}</strong>
              <small>@{draft.handle}</small>
              {draft.title && <small>{draft.title}</small>}
              <small>{user.email}</small>
            </span>
          </div>
          <div className="profile-settings-card__actions">
            <div>
              <label className="ui-button ui-button--secondary ui-button--sm">
                {t("changeAvatar")}
                <input
                  hidden
                  type="file"
                  accept="image/png,image/jpeg,image/webp"
                  disabled={avatarPending}
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    if (file) void changeAvatar(file);
                    event.target.value = "";
                  }}
                />
              </label>
              {user.avatar_version > 0 && (
                <Button
                  size="sm"
                  disabled={avatarPending}
                  onClick={() =>
                    void api.deleteMyAvatar().then((updated) =>
                      onUserUpdated({
                        ...user,
                        avatar_version: updated.avatar_version,
                      }),
                    )
                  }
                >
                  {t("removeAvatar")}
                </Button>
              )}
            </div>
            <small>{t("avatarValidation")}</small>
            {avatarError && (
              <small className="settings-error">{avatarError}</small>
            )}
          </div>
        </article>
        <SettingsSection
          title={t("personalPreferences")}
          description={t("profileSettingsHint")}
        >
          <div className="settings-form-grid">
            <Field
              label={t("name")}
              name="profile-name"
              value={draft.displayName}
              onChange={(event) =>
                setDraft({ ...draft, displayName: event.target.value })
              }
            />
            <Field
              label={t("handle")}
              name="profile-handle"
              value={draft.handle}
              onChange={(event) =>
                setDraft({ ...draft, handle: event.target.value })
              }
            />
            <Field
              label={t("jobTitle")}
              name="profile-title"
              maxLength={120}
              value={draft.title}
              onChange={(event) =>
                setDraft({ ...draft, title: event.target.value })
              }
            />
            <SelectField
              label={t("timezone")}
              name="profile-timezone"
              value={draft.timezone}
              onChange={(event) =>
                setDraft({ ...draft, timezone: event.target.value })
              }
            >
              {!commonTimezones.some(
                (timezone) => timezone === draft.timezone,
              ) && <option value={draft.timezone}>{draft.timezone}</option>}
              {commonTimezones.map((timezone) => (
                <option key={timezone} value={timezone}>
                  {timezone}
                </option>
              ))}
            </SelectField>
          </div>
          <TextareaField
            label={t("about")}
            name="profile-about"
            maxLength={280}
            value={draft.about}
            onChange={(event) =>
              setDraft({ ...draft, about: event.target.value })
            }
          />
        </SettingsSection>
        <SettingsSection
          title={t("appearance")}
          description={t("appearanceHint")}
        >
          <div className="settings-form-grid">
            <SelectField
              label={t("theme")}
              name="profile-theme"
              value={draft.theme}
              onChange={(event) => {
                const theme = event.target.value as UserPreferences["theme"];
                setDraft({ ...draft, theme });
                setTheme(theme);
              }}
            >
              <option value="system">{t("system")}</option>
              <option value="light">{t("light")}</option>
              <option value="dark">{t("dark")}</option>
            </SelectField>
            <SelectField
              label={t("language")}
              name="profile-language"
              value={draft.locale}
              onChange={(event) => {
                const locale = event.target.value as "ru" | "en";
                setDraft({ ...draft, locale });
                void setLocale(locale);
              }}
            >
              <option value="ru">{t("russian")}</option>
              <option value="en">{t("english")}</option>
            </SelectField>
          </div>
        </SettingsSection>
        <SettingsSection
          wide
          title={t("accountActions")}
          description={user.email}
        >
          <Button variant="danger" onClick={onLogout}>
            <LogOut />
            {t("logout")}
          </Button>
        </SettingsSection>
      </div>
    </SettingsShell>
  );
}

const commonTimezones = [
  "UTC",
  "Europe/Kaliningrad",
  "Europe/Moscow",
  "Europe/Samara",
  "Asia/Yekaterinburg",
  "Asia/Omsk",
  "Asia/Novosibirsk",
  "Asia/Irkutsk",
  "Asia/Yakutsk",
  "Asia/Vladivostok",
  "Asia/Magadan",
  "Asia/Kamchatka",
] as const;

export function NotificationSettingsPage({
  api,
  user,
  navigate,
  onEnable,
}: {
  api: MessengerAPI;
  user: User;
  navigate: SettingsNavigate;
  onEnable(): void;
}) {
  const { t } = useTranslation();
  const query = useQuery({
    queryKey: ["preferences"],
    queryFn: () => api.preferences(),
  });
  const brandingQuery = useQuery({
    queryKey: ["public-branding"],
    queryFn: () => api.branding(),
  });
  const pushConfigQuery = useQuery({
    queryKey: ["push-config"],
    queryFn: () => api.pushConfig(),
  });
  const subscriptionsQuery = useQuery({
    queryKey: ["push-subscriptions"],
    queryFn: () => api.pushSubscriptions(),
  });
  const overridesQuery = useQuery({
    queryKey: ["notification-overrides"],
    queryFn: () => api.chatNotificationOverrides(),
  });
  const [draft, setDraft] = useState<UserPreferences | null>(null);
  const [snoozePending, setSnoozePending] = useState(false);
  const [testPending, setTestPending] = useState(false);
  const [testResult, setTestResult] = useState("");
  useEffect(() => {
    if (query.data) setDraft((current) => current ?? query.data);
  }, [query.data]);
  useEffect(() => {
    const refresh = () =>
      void query
        .refetch()
        .then((result) => result.data && setDraft(result.data));
    window.addEventListener("coma-notifications-changed", refresh);
    return () =>
      window.removeEventListener("coma-notifications-changed", refresh);
  }, [query]);
  const autosave = useAutosave({
    value: draft,
    save: (snapshot) =>
      api.updatePreferences({
        push_enabled: snapshot.push_enabled,
        push_preview: snapshot.push_preview,
        notify_messages: snapshot.notify_messages,
        notify_threads: snapshot.notify_threads,
        notify_reactions: snapshot.notify_reactions,
        notify_invites: snapshot.notify_invites,
        notify_system: snapshot.notify_system,
        sound_enabled: snapshot.sound_enabled,
        sound_id: snapshot.sound_id,
        schedule: snapshot.schedule,
        email_digest: snapshot.email_digest,
      }),
    onSaved: (result, snapshot) => {
      window.dispatchEvent(
        new CustomEvent("coma-preferences-updated", { detail: result }),
      );
      setDraft((current) =>
        current && JSON.stringify(current) !== JSON.stringify(snapshot)
          ? current
          : result,
      );
    },
  });
  if (!draft) return <Skeleton />;
  const permission =
    "Notification" in window ? Notification.permission : "denied";
  const schedule = draft.schedule;
  async function setSnooze(until: string | null) {
    setSnoozePending(true);
    try {
      const updated = await api.updatePreferences({ snoozed_until: until });
      setDraft(updated);
      window.dispatchEvent(
        new CustomEvent("coma-preferences-updated", { detail: updated }),
      );
    } finally {
      setSnoozePending(false);
    }
  }
  function setScheduleDays(days: "all" | "weekdays" | number[]) {
    if (!schedule) return;
    setDraft((current) =>
      current ? { ...current, schedule: { ...schedule, days } } : current,
    );
  }
  async function sendTestNotification() {
    setTestPending(true);
    setTestResult("");
    try {
      const result = await api.testPush();
      setTestResult(
        result.failed
          ? t("testNotificationPartial", result)
          : t("testNotificationSent", result),
      );
    } catch (cause) {
      setTestResult(messageOf(cause));
    } finally {
      setTestPending(false);
    }
  }
  return (
    <SettingsShell
      user={user}
      active="notifications"
      title={t("notificationSettings")}
      navigate={navigate}
    >
      <div className="settings-page__body">
        <AutosaveStatus {...autosave} onRetry={autosave.retry} />
        <SettingsSection
          title={t("browserNotifications")}
          description={t("browserNotificationsHint")}
          icon={<Bell />}
        >
          <div className="settings-state-row">
            <span>
              <strong>
                {draft.push_enabled
                  ? t("notificationsEnabled")
                  : t("notificationsDisabled")}
              </strong>
              <small>
                {permission === "granted"
                  ? t("browserPermissionGranted")
                  : t("browserPermissionMissing")}
              </small>
            </span>
            {draft.push_enabled ? (
              <SettingsToggle
                label={t("notifications")}
                hint={t("notificationsHint")}
                checked={draft.push_enabled}
                onChange={(push_enabled) =>
                  setDraft({ ...draft, push_enabled })
                }
              />
            ) : (
              <Button variant="primary" onClick={onEnable}>
                <Bell />
                {t("notificationEnable")}
              </Button>
            )}
          </div>
        </SettingsSection>
        <SettingsSection
          title={t("messageNotifications")}
          description={t("messageNotificationsHint")}
          icon={<MessageCircle />}
        >
          <div className="settings-form-grid">
            <SelectField
              label={t("messageNotificationMode")}
              name="notify-messages"
              value={draft.notify_messages}
              onChange={(event) =>
                setDraft({
                  ...draft,
                  notify_messages: event.target
                    .value as UserPreferences["notify_messages"],
                })
              }
            >
              <option value="all">{t("allMessages")}</option>
              <option value="direct_and_mentions">
                {t("directAndMentions")}
              </option>
              <option value="none">{t("notificationsOff")}</option>
            </SelectField>
            <SelectField
              label={t("threadNotificationMode")}
              name="notify-threads"
              value={draft.notify_threads}
              onChange={(event) =>
                setDraft({
                  ...draft,
                  notify_threads: event.target
                    .value as UserPreferences["notify_threads"],
                })
              }
            >
              <option value="all">{t("allThreadReplies")}</option>
              <option value="mentions">{t("mentionsOnly")}</option>
              <option value="none">{t("notificationsOff")}</option>
            </SelectField>
          </div>
          <SettingsToggle
            label={t("notifyReactions")}
            checked={draft.notify_reactions}
            onChange={(notify_reactions) =>
              setDraft({ ...draft, notify_reactions })
            }
          />
          <SettingsToggle
            label={t("notifyInvites")}
            checked={draft.notify_invites}
            onChange={(notify_invites) =>
              setDraft({ ...draft, notify_invites })
            }
          />
          <SettingsToggle
            label={t("notifySystem")}
            checked={draft.notify_system}
            onChange={(notify_system) => setDraft({ ...draft, notify_system })}
          />
        </SettingsSection>
        <SettingsSection
          title={t("notificationSchedule")}
          description={t("notificationScheduleHint")}
          icon={<Clock3 />}
        >
          <SettingsToggle
            label={t("useNotificationSchedule")}
            checked={schedule !== null}
            onChange={(enabled) =>
              setDraft({
                ...draft,
                schedule: enabled
                  ? { days: "weekdays", from: "09:00", to: "18:00" }
                  : null,
              })
            }
          />
          {schedule && (
            <div className="notification-schedule-editor">
              <div
                className="notification-schedule-modes"
                role="group"
                aria-label={t("scheduleDays")}
              >
                <Button
                  size="sm"
                  variant={schedule.days === "all" ? "primary" : "secondary"}
                  onClick={() => setScheduleDays("all")}
                >
                  {t("everyDay")}
                </Button>
                <Button
                  size="sm"
                  variant={
                    schedule.days === "weekdays" ? "primary" : "secondary"
                  }
                  onClick={() => setScheduleDays("weekdays")}
                >
                  {t("weekdays")}
                </Button>
                <Button
                  size="sm"
                  variant={
                    Array.isArray(schedule.days) ? "primary" : "secondary"
                  }
                  onClick={() => setScheduleDays([1, 2, 3, 4, 5])}
                >
                  {t("customDays")}
                </Button>
              </div>
              {Array.isArray(schedule.days) && (
                <div className="notification-schedule-days">
                  {[0, 1, 2, 3, 4, 5, 6].map((day) => {
                    const selected = (schedule.days as number[]).includes(day);
                    return (
                      <button
                        type="button"
                        key={day}
                        aria-pressed={selected}
                        onClick={() => {
                          const next = selected
                            ? (schedule.days as number[]).filter(
                                (item) => item !== day,
                              )
                            : [...(schedule.days as number[]), day].sort();
                          if (next.length) setScheduleDays(next);
                        }}
                      >
                        {t(`weekday${day}`)}
                      </button>
                    );
                  })}
                </div>
              )}
              <div className="settings-form-grid">
                <Field
                  label={t("scheduleFrom")}
                  name="schedule-from"
                  type="time"
                  value={schedule.from}
                  onChange={(event) =>
                    setDraft({
                      ...draft,
                      schedule: { ...schedule, from: event.target.value },
                    })
                  }
                />
                <Field
                  label={t("scheduleTo")}
                  name="schedule-to"
                  type="time"
                  value={schedule.to}
                  onChange={(event) =>
                    setDraft({
                      ...draft,
                      schedule: { ...schedule, to: event.target.value },
                    })
                  }
                />
              </div>
              <small>
                {t("scheduleTimezone", { timezone: user.timezone })}
              </small>
            </div>
          )}
        </SettingsSection>
        <SettingsSection
          title={t("notificationSound")}
          description={t("notificationSoundHint")}
          icon={<Volume2 />}
        >
          <SettingsToggle
            label={t("soundEnabled")}
            checked={draft.sound_enabled}
            onChange={(sound_enabled) => setDraft({ ...draft, sound_enabled })}
          />
          <SettingsToggle
            label={t("notificationPreview")}
            hint={t("notificationPreviewHint")}
            checked={draft.push_preview}
            onChange={(push_preview) => setDraft({ ...draft, push_preview })}
          />
        </SettingsSection>
        <SettingsSection
          title={t("snoozeNotifications")}
          description={t("snoozeHint")}
          icon={<Clock3 />}
        >
          {draft.snoozed_until && (
            <p>
              {t("snoozedUntil", {
                time: new Intl.DateTimeFormat(undefined, {
                  dateStyle: "medium",
                  timeStyle: "short",
                }).format(new Date(draft.snoozed_until)),
              })}
            </p>
          )}
          <div className="status-menu__actions">
            {[30, 60, 120].map((minutes) => (
              <Button
                key={minutes}
                size="sm"
                disabled={snoozePending}
                onClick={() =>
                  void setSnooze(
                    new Date(Date.now() + minutes * 60_000).toISOString(),
                  )
                }
              >
                {minutes === 30
                  ? t("snooze30Minutes")
                  : minutes === 60
                    ? t("snoozeOneHour")
                    : t("snoozeTwoHours")}
              </Button>
            ))}
            {draft.snoozed_until && (
              <Button
                size="sm"
                variant="ghost"
                disabled={snoozePending}
                onClick={() => void setSnooze(null)}
              >
                {t("resumeNotifications")}
              </Button>
            )}
          </div>
        </SettingsSection>
        {brandingQuery.data?.email_delivery_available && (
          <SettingsSection
            title={t("emailDigest")}
            description={t("emailDigestHint")}
          >
            <SettingsToggle
              label={t("emailDigest")}
              checked={draft.email_digest}
              onChange={(email_digest) => setDraft({ ...draft, email_digest })}
            />
          </SettingsSection>
        )}
        <SettingsSection
          title={t("pushDiagnostics")}
          description={t("pushDiagnosticsHint")}
          icon={<MonitorSmartphone />}
        >
          <div className="settings-state-row">
            <span>
              <strong>
                {pushConfigQuery.data?.enabled
                  ? t("pushServerReady")
                  : t("pushServerUnavailable")}
              </strong>
              <small>
                {permission === "granted"
                  ? t("browserPermissionGranted")
                  : t("browserPermissionMissing")}
              </small>
            </span>
            <Button
              size="sm"
              variant="primary"
              disabled={
                !pushConfigQuery.data?.enabled ||
                !subscriptionsQuery.data?.length ||
                testPending
              }
              onClick={() => void sendTestNotification()}
            >
              <Send />
              {t("sendTestNotification")}
            </Button>
          </div>
          {testResult && <p className="settings-inline-result">{testResult}</p>}
          <div className="settings-diagnostic-list">
            {subscriptionsQuery.data?.length ? (
              subscriptionsQuery.data.map((subscription) => (
                <div key={subscription.id}>
                  <MonitorSmartphone />
                  <span>
                    <strong>
                      {sessionLabel(
                        subscription.user_agent,
                        t("unknownDevice"),
                      )}
                    </strong>
                    <small>
                      {subscription.current ? `${t("currentSession")} · ` : ""}
                      {new Intl.DateTimeFormat(undefined, {
                        dateStyle: "medium",
                        timeStyle: "short",
                      }).format(new Date(subscription.updated_at))}
                    </small>
                  </span>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() =>
                      void api
                        .removePush(subscription.id)
                        .then(() => subscriptionsQuery.refetch())
                    }
                  >
                    {t("disconnect")}
                  </Button>
                </div>
              ))
            ) : (
              <p>{t("noPushSubscriptions")}</p>
            )}
          </div>
        </SettingsSection>
        <SettingsSection
          title={t("notificationOverrides")}
          description={t("notificationOverridesHint")}
        >
          <div className="settings-diagnostic-list">
            {overridesQuery.data?.length ? (
              overridesQuery.data.map((override) => (
                <div key={override.chat_id}>
                  <Bell />
                  <span>
                    <strong>{override.name}</strong>
                    <small>
                      {t(`notificationOverride_${override.notify_level}`)}
                    </small>
                  </span>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() =>
                      void api
                        .resetChatNotifications(override.chat_id)
                        .then(() => overridesQuery.refetch())
                    }
                  >
                    <RotateCcw />
                    {t("resetToDefault")}
                  </Button>
                </div>
              ))
            ) : (
              <p>{t("noNotificationOverrides")}</p>
            )}
          </div>
        </SettingsSection>
      </div>
    </SettingsShell>
  );
}
