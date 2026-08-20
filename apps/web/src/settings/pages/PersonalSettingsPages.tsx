import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { MessengerAPI, User, UserPreferences } from "@comamessenger/core";
import { Bell, LogOut, MessageCircle } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Avatar, Button, Field, SelectField, Skeleton } from "../../ui";
import { setLocale } from "../../i18n";
import { setTheme } from "../../theme";
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

type ProfileDraft = {
  displayName: string;
  handle: string;
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
  useEffect(() => {
    if (!query.data) return;
    setDraft(
      (current) =>
        current ?? {
          displayName: user.display_name,
          handle: user.handle,
          theme: query.data.theme,
          locale: query.data.locale,
        },
    );
  }, [query.data, user.display_name, user.handle]);
  const autosave = useAutosave({
    value: draft,
    save: async (snapshot) => {
      const [updatedUser] = await Promise.all([
        api.updateMe({
          display_name: snapshot.displayName,
          handle: snapshot.handle,
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        }),
        api.updatePreferences({
          ...(query.data ?? {
            push_enabled: false,
            push_preview: false,
            chat_folders: [],
            pinned_chat_ids: [],
          }),
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
      <div className="settings-page__body settings-page__body--columns">
        <AutosaveStatus {...autosave} onRetry={autosave.retry} />
        <article className="profile-settings-card">
          <Avatar name={draft.displayName} seed={user.id} size="lg" online />
          <span>
            <strong>{draft.displayName}</strong>
            <small>@{draft.handle}</small>
            <small>{user.email}</small>
          </span>
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
          </div>
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
  const [draft, setDraft] = useState<UserPreferences | null>(null);
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
    save: (snapshot) => api.updatePreferences(snapshot),
    onSaved: (result, snapshot) =>
      setDraft((current) =>
        current && JSON.stringify(current) !== JSON.stringify(snapshot)
          ? current
          : result,
      ),
  });
  if (!draft) return <Skeleton />;
  const permission =
    "Notification" in window ? Notification.permission : "denied";
  return (
    <SettingsShell
      user={user}
      active="notifications"
      title={t("notificationSettings")}
      navigate={navigate}
    >
      <div className="settings-page__body settings-page__body--columns">
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
          title={t("notificationPreview")}
          description={t("notificationPreviewHint")}
          icon={<MessageCircle />}
        >
          <SettingsToggle
            label={t("notificationPreview")}
            hint={t("notificationPreviewHint")}
            checked={draft.push_preview}
            onChange={(push_preview) => setDraft({ ...draft, push_preview })}
          />
        </SettingsSection>
      </div>
    </SettingsShell>
  );
}
