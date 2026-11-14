import { useState } from "react";
import { Alert, Pressable, StyleSheet, View } from "react-native";
import { useTranslation } from "react-i18next";
import { APIError, timezoneOptions, type User } from "@comamessenger/core";
import { spacing } from "@comamessenger/tokens";
import { useSession, useSignedIn } from "@/session/SessionProvider";
import { pickAndUploadAvatar } from "@/files/avatar";
import { ImageTooLarge } from "@/files/images";
import { messageOf } from "@/lib/errors";
import { ActionSheet } from "@/ui/ActionSheet";
import { PickerSheet } from "@/ui/PickerSheet";
import { Avatar } from "@/ui/Avatar";
import { GroupBody, NavRow, SettingsGroup } from "@/ui/Settings";
import { Text } from "@/ui/Text";
import { TextField } from "@/ui/TextField";
import { AutosaveStatus } from "./AutosaveStatus";
import { SettingsScreen } from "./SettingsScreen";
import { useAutosave } from "./useAutosave";

type ProfileDraft = Pick<
  User,
  "display_name" | "handle" | "title" | "about" | "timezone"
>;

function draftOf(user: User): ProfileDraft {
  return {
    display_name: user.display_name,
    handle: user.handle,
    title: user.title,
    about: user.about,
    timezone: user.timezone,
  };
}

/** Name, handle, job title, about, time zone and photo; saved as you type, like the web. */
export function ProfileSettings() {
  const { t } = useTranslation();
  const { api, user } = useSignedIn();
  const { updateUser } = useSession();
  const [draft, setDraft] = useState<ProfileDraft>(() => draftOf(user));
  const [photoMenu, setPhotoMenu] = useState(false);
  const [timezoneMenu, setTimezoneMenu] = useState(false);
  const [photoPending, setPhotoPending] = useState(false);
  const nameMissing = !draft.display_name.trim();
  const handleMissing = !draft.handle.trim();
  const autosave = useAutosave<ProfileDraft>({
    value: nameMissing || handleMissing ? null : draft,
    save: async (snapshot) => {
      try {
        const updated = await api.updateMe({
          display_name: snapshot.display_name.trim(),
          handle: snapshot.handle.trim().toLowerCase(),
          title: snapshot.title.trim(),
          about: snapshot.about.trim(),
          timezone: snapshot.timezone,
        });
        updateUser(updated);
        return snapshot;
      } catch (cause) {
        // 409 here means the handle belongs to someone else.
        if (cause instanceof APIError && cause.status === 409)
          throw new HandleTaken();
        throw cause;
      }
    },
    describeError: (cause) =>
      cause instanceof HandleTaken ? t("joinHandleTaken") : messageOf(cause),
  });
  const handleTaken =
    autosave.phase === "error" && autosave.error === t("joinHandleTaken");
  const set = (change: Partial<ProfileDraft>) =>
    setDraft((current) => ({ ...current, ...change }));

  async function changePhoto(action: "change" | "remove") {
    setPhotoMenu(false);
    setPhotoPending(true);
    try {
      if (action === "remove") await api.deleteMyAvatar();
      else {
        // Let the sheet finish closing before the system picker appears.
        await new Promise((resolve) => setTimeout(resolve, 400));
        if (!(await pickAndUploadAvatar(api))) return;
      }
      updateUser(await api.me());
    } catch (cause) {
      Alert.alert(
        cause instanceof ImageTooLarge
          ? t("avatarValidation")
          : messageOf(cause),
      );
    } finally {
      setPhotoPending(false);
    }
  }

  return (
    <SettingsScreen title={t("profile")} testID="settings-profile-screen">
      <AutosaveStatus
        phase={autosave.phase}
        error={autosave.error}
        onRetry={autosave.retry}
      />
      <View style={styles.identity}>
        <Pressable
          testID="profile-photo"
          accessibilityRole="button"
          accessibilityLabel={t("changePhoto")}
          accessibilityState={{ busy: photoPending }}
          disabled={photoPending}
          onPress={() => setPhotoMenu(true)}
          style={({ pressed }) => pressed && styles.pressed}
        >
          <Avatar
            name={draft.display_name || user.display_name}
            seed={user.id}
            size={88}
            actorID={user.id}
            avatarVersion={user.avatar_version}
          />
        </Pressable>
        <Pressable
          accessibilityRole="button"
          hitSlop={8}
          disabled={photoPending}
          onPress={() => setPhotoMenu(true)}
        >
          <Text tone="primary" weight="semibold" size={15}>
            {t("changePhoto")}
          </Text>
        </Pressable>
        <Text tone="subtle" size={13} style={styles.center}>
          {t("avatarValidation")}
        </Text>
      </View>
      <SettingsGroup title={t("personalPreferences")}>
        <GroupBody>
          <TextField
            testID="profile-name"
            label={t("displayName")}
            value={draft.display_name}
            onChangeText={(display_name) => set({ display_name })}
            autoComplete="name"
            maxLength={120}
            error={nameMissing ? t("fieldRequired") : undefined}
          />
          <TextField
            testID="profile-handle"
            label={t("handle")}
            value={draft.handle}
            onChangeText={(handle) => set({ handle })}
            autoCapitalize="none"
            autoCorrect={false}
            error={
              handleMissing
                ? t("fieldRequired")
                : handleTaken
                  ? t("joinHandleTaken")
                  : undefined
            }
            hint={t("joinHandleHint", {
              handle: draft.handle.trim().toLowerCase() || user.handle,
            })}
          />
          <TextField
            testID="profile-title"
            label={t("jobTitle")}
            value={draft.title}
            onChangeText={(title) => set({ title })}
            maxLength={120}
          />
          <TextField
            testID="profile-about"
            label={t("about")}
            value={draft.about}
            onChangeText={(about) => set({ about })}
            maxLength={280}
            multiline
          />
        </GroupBody>
      </SettingsGroup>
      <SettingsGroup hint={t("timezoneHint")}>
        <NavRow
          testID="profile-timezone"
          label={t("timezone")}
          value={draft.timezone}
          onPress={() => setTimezoneMenu(true)}
        />
      </SettingsGroup>
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
      <PickerSheet
        testID="timezone-picker"
        visible={timezoneMenu}
        title={t("timezone")}
        value={draft.timezone}
        options={timezoneOptions(draft.timezone).map((timezone) => ({
          value: timezone,
          label: timezone,
        }))}
        onSelect={(timezone) => set({ timezone })}
        onClose={() => setTimezoneMenu(false)}
      />
    </SettingsScreen>
  );
}

class HandleTaken extends Error {}

const styles = StyleSheet.create({
  identity: { alignItems: "center", gap: spacing[2] },
  pressed: { opacity: 0.7 },
  center: { textAlign: "center" },
});
