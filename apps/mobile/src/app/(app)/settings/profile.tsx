import { useState } from "react";
import { Alert, ScrollView, StyleSheet } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { router } from "expo-router";
import { useTranslation } from "react-i18next";
import { APIError } from "@comamessenger/core";
import { spacing } from "@comamessenger/tokens";
import { useSession, useSignedIn } from "@/session/SessionProvider";
import { messageOf } from "@/lib/errors";
import { Button } from "@/ui/Button";
import { ScreenHeader } from "@/ui/ScreenHeader";
import { TextField } from "@/ui/TextField";

export default function ProfileScreen() {
  const { t } = useTranslation();
  const { api, user } = useSignedIn();
  const { updateUser } = useSession();
  const [displayName, setDisplayName] = useState(user.display_name);
  const [handle, setHandle] = useState(user.handle);
  const [title, setTitle] = useState(user.title);
  const [about, setAbout] = useState(user.about);
  const [pending, setPending] = useState(false);
  const [handleTaken, setHandleTaken] = useState(false);
  const changed =
    displayName.trim() !== user.display_name ||
    handle.trim().toLowerCase() !== user.handle ||
    title.trim() !== user.title ||
    about.trim() !== user.about;

  async function save() {
    setPending(true);
    setHandleTaken(false);
    try {
      updateUser(
        await api.updateMe({
          display_name: displayName.trim(),
          handle: handle.trim().toLowerCase(),
          title: title.trim(),
          about: about.trim(),
        }),
      );
      router.back();
    } catch (cause) {
      if (cause instanceof APIError && cause.status === 409)
        setHandleTaken(true);
      else Alert.alert(messageOf(cause));
    } finally {
      setPending(false);
    }
  }

  return (
    <SafeAreaView edges={["top", "bottom"]} style={styles.screen}>
      <ScreenHeader title={t("profile")} />
      <ScrollView
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
      >
        <TextField
          label={t("displayName")}
          value={displayName}
          onChangeText={setDisplayName}
          autoComplete="name"
          maxLength={120}
        />
        <TextField
          label={t("handle")}
          value={handle}
          onChangeText={(value) => {
            setHandle(value);
            setHandleTaken(false);
          }}
          autoCapitalize="none"
          autoCorrect={false}
          error={handleTaken ? t("joinHandleTaken") : undefined}
          hint={t("joinHandleHint", {
            handle: handle.trim().toLowerCase() || user.handle,
          })}
        />
        <TextField
          label={t("jobTitle")}
          value={title}
          onChangeText={setTitle}
          maxLength={120}
        />
        <TextField
          label={t("about")}
          value={about}
          onChangeText={setAbout}
          maxLength={280}
          multiline
        />
        <Button
          label={t("save")}
          pending={pending}
          disabled={!changed || !displayName.trim() || !handle.trim()}
          onPress={() => void save()}
        />
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  content: { padding: spacing[4], gap: spacing[4] },
});
