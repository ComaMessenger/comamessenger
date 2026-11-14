import { useTranslation } from "react-i18next";
import type { UserPreferences } from "@comamessenger/core";
import { ChoiceRow, Divider, SettingsGroup } from "@/ui/Settings";
import { SettingsScreen } from "./SettingsScreen";
import { usePreferences } from "./preferences";

type Visibility = UserPreferences["last_seen_visibility"];

/**
 * Who sees when I was last online; the same setting the web edits. The hint
 * says what it does not hide: the online status itself, and the last sign-in
 * administrators see in the member list.
 */
export function PrivacySettings() {
  const { t } = useTranslation();
  const { query, value, set } = usePreferences();
  const current: Visibility = value?.last_seen_visibility ?? "everyone";
  return (
    <SettingsScreen
      title={t("privacy")}
      query={query}
      testID="settings-privacy-screen"
    >
      {value && (
        <SettingsGroup title={t("lastSeenVisibility")} hint={t("privacyHint")}>
          <ChoiceRow
            testID="last-seen-everyone"
            label={t("lastSeenEveryone")}
            selected={current === "everyone"}
            onPress={() => set({ last_seen_visibility: "everyone" })}
          />
          <Divider />
          <ChoiceRow
            testID="last-seen-nobody"
            label={t("lastSeenNobody")}
            selected={current === "nobody"}
            onPress={() => set({ last_seen_visibility: "nobody" })}
          />
        </SettingsGroup>
      )}
    </SettingsScreen>
  );
}
