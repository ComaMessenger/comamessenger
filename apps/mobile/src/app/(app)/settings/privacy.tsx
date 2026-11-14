import {
  ActivityIndicator,
  Alert,
  ScrollView,
  StyleSheet,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import type { UserPreferences } from "@comamessenger/core";
import { spacing } from "@comamessenger/tokens";
import { useSignedIn } from "@/session/SessionProvider";
import { ScreenHeader } from "@/ui/ScreenHeader";
import { ChoiceRow, Divider, SettingsGroup } from "@/ui/Settings";
import { useTheme } from "@/lib/theme";
import { Notice } from "@/ui/Notice";

type Visibility = UserPreferences["last_seen_visibility"];

/** Who sees when I was last online; the same setting the web edits. */
export default function PrivacySettingsScreen() {
  const { t } = useTranslation();
  const theme = useTheme();
  const { api } = useSignedIn();
  const queryClient = useQueryClient();
  const preferences = useQuery({
    queryKey: ["preferences"],
    queryFn: () => api.preferences(),
  });
  const update = useMutation({
    mutationFn: (last_seen_visibility: Visibility) =>
      api.updatePreferences({ last_seen_visibility }),
    onMutate: (last_seen_visibility) => {
      const previous = queryClient.getQueryData<UserPreferences>([
        "preferences",
      ]);
      if (previous)
        queryClient.setQueryData(["preferences"], {
          ...previous,
          last_seen_visibility,
        });
      return previous;
    },
    onError: (_error, _change, previous) => {
      queryClient.setQueryData(["preferences"], previous);
      Alert.alert(t("actionFailed"));
    },
    onSuccess: (value) => queryClient.setQueryData(["preferences"], value),
  });
  const value = preferences.data;
  const current = value?.last_seen_visibility ?? "everyone";

  return (
    <SafeAreaView
      edges={["bottom"]}
      style={[styles.screen, { backgroundColor: theme.canvas }]}
    >
      <ScreenHeader title={t("privacy")} />
      {preferences.isPending && (
        <ActivityIndicator color={theme.muted} style={styles.loader} />
      )}
      {preferences.isError && !value && (
        <View style={styles.content}>
          <Notice
            title={t("loadFailed")}
            actionLabel={t("retry")}
            onAction={() => void preferences.refetch()}
          />
        </View>
      )}
      {value && (
        <ScrollView contentContainerStyle={styles.content}>
          <SettingsGroup
            title={t("lastSeenVisibility")}
            hint={t("privacyHint")}
          >
            <ChoiceRow
              testID="last-seen-everyone"
              label={t("lastSeenEveryone")}
              selected={current === "everyone"}
              onPress={() => update.mutate("everyone")}
            />
            <Divider />
            <ChoiceRow
              testID="last-seen-nobody"
              label={t("lastSeenNobody")}
              selected={current === "nobody"}
              onPress={() => update.mutate("nobody")}
            />
          </SettingsGroup>
        </ScrollView>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  content: {
    padding: spacing[4],
    gap: spacing[5],
    width: "100%",
    maxWidth: 640,
    alignSelf: "center",
  },
  loader: { marginTop: spacing[10] },
});
