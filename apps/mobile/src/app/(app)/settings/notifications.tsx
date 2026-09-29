import { Alert, ScrollView, StyleSheet } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import type {
  UpdatePreferencesRequest,
  UserPreferences,
} from "@comamessenger/core";
import { spacing } from "@comamessenger/tokens";
import { useSignedIn } from "@/session/SessionProvider";
import { ScreenHeader } from "@/ui/ScreenHeader";
import { ChoiceRow, Divider, SettingsGroup, SwitchRow } from "@/ui/Settings";

/** Account-wide notification preferences; the same ones the web edits. */
export default function NotificationSettingsScreen() {
  const { t } = useTranslation();
  const { api } = useSignedIn();
  const queryClient = useQueryClient();
  const preferences = useQuery({
    queryKey: ["preferences"],
    queryFn: () => api.preferences(),
  });
  const update = useMutation({
    mutationFn: (change: UpdatePreferencesRequest) =>
      api.updatePreferences(change),
    onMutate: (change) => {
      const previous = queryClient.getQueryData<UserPreferences>([
        "preferences",
      ]);
      if (previous)
        queryClient.setQueryData(["preferences"], { ...previous, ...change });
      return previous;
    },
    onError: (_error, _change, previous) => {
      queryClient.setQueryData(["preferences"], previous);
      Alert.alert(t("actionFailed"));
    },
    onSuccess: (value) => queryClient.setQueryData(["preferences"], value),
  });
  const value = preferences.data;
  const set = (change: UpdatePreferencesRequest) => update.mutate(change);

  return (
    <SafeAreaView edges={["top"]} style={styles.screen}>
      <ScreenHeader title={t("settingsNotifications")} />
      {value && (
        <ScrollView contentContainerStyle={styles.content}>
          <SettingsGroup
            hint={value.push_enabled ? t("pushPreviewHint") : undefined}
          >
            <SwitchRow
              label={t("pushEnabled")}
              value={value.push_enabled}
              onChange={(push_enabled) => set({ push_enabled })}
            />
            <Divider />
            <SwitchRow
              label={t("pushPreview")}
              value={value.push_preview}
              disabled={!value.push_enabled}
              onChange={(push_preview) => set({ push_preview })}
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
              <ChoiceRowWithDivider
                key={option}
                first={index === 0}
                label={label}
                selected={value.notify_messages === option}
                onPress={() => set({ notify_messages: option })}
              />
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
              <ChoiceRowWithDivider
                key={option}
                first={index === 0}
                label={label}
                selected={value.notify_threads === option}
                onPress={() => set({ notify_threads: option })}
              />
            ))}
          </SettingsGroup>
          <SettingsGroup>
            <SwitchRow
              label={t("notifyReactions")}
              value={value.notify_reactions}
              onChange={(notify_reactions) => set({ notify_reactions })}
            />
          </SettingsGroup>
        </ScrollView>
      )}
    </SafeAreaView>
  );
}

function ChoiceRowWithDivider({
  first,
  ...props
}: { first: boolean } & Parameters<typeof ChoiceRow>[0]) {
  return (
    <>
      {!first && <Divider />}
      <ChoiceRow {...props} />
    </>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  content: { padding: spacing[4], gap: spacing[5] },
});
