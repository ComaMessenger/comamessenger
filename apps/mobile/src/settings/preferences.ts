import { Alert } from "react-native";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import type {
  UpdatePreferencesRequest,
  UserPreferences,
} from "@comamessenger/core";
import { setLocale } from "@/i18n";
import { messageOf } from "@/lib/errors";
import { applyThemePreference } from "@/lib/theme";
import { useSignedIn } from "@/session/SessionProvider";

export const preferencesKey = ["preferences"] as const;

/**
 * Account preferences (shared with the web). A change shows at once and is
 * rolled back with a message when the server refuses it.
 */
export function usePreferences() {
  const { t } = useTranslation();
  const { api } = useSignedIn();
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: preferencesKey,
    queryFn: () => api.preferences(),
  });
  const update = useMutation({
    mutationFn: (change: UpdatePreferencesRequest) =>
      api.updatePreferences(change),
    onMutate: (change) => {
      const previous =
        queryClient.getQueryData<UserPreferences>(preferencesKey);
      if (previous)
        queryClient.setQueryData(preferencesKey, { ...previous, ...change });
      return previous;
    },
    onError: (cause, _change, previous) => {
      queryClient.setQueryData(preferencesKey, previous);
      if (previous) {
        applyThemePreference(previous.theme);
        setLocale(previous.locale);
      }
      Alert.alert(t("autosaveError"), messageOf(cause));
    },
    onSuccess: (value) => queryClient.setQueryData(preferencesKey, value),
  });
  return {
    query,
    value: query.data,
    set: (change: UpdatePreferencesRequest) => update.mutate(change),
    pending: update.isPending,
  };
}
