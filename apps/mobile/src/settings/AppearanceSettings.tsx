import { View } from "react-native";
import { useTranslation } from "react-i18next";
import type { UserPreferences } from "@comamessenger/core";
import { setLocale } from "@/i18n";
import { applyThemePreference } from "@/lib/theme";
import { ChoiceRow, Divider, SettingsGroup } from "@/ui/Settings";
import { SettingsScreen } from "./SettingsScreen";
import { usePreferences } from "./preferences";

const themes: UserPreferences["theme"][] = ["system", "light", "dark"];
const locales: UserPreferences["locale"][] = ["ru", "en"];

/** Theme and language of the account; they apply at once, here and on the web. */
export function AppearanceSettings() {
  const { t } = useTranslation();
  const { query, value, set } = usePreferences();
  return (
    <SettingsScreen
      title={t("appearanceAndLanguage")}
      query={query}
      testID="settings-appearance-screen"
    >
      {value && (
        <>
          <SettingsGroup title={t("theme")} hint={t("appearanceHint")}>
            {themes.map((theme, index) => (
              <View key={theme}>
                {index > 0 && <Divider />}
                <ChoiceRow
                  testID={`theme-${theme}`}
                  label={t(`theme_${theme}`)}
                  selected={value.theme === theme}
                  onPress={() => {
                    applyThemePreference(theme);
                    set({ theme });
                  }}
                />
              </View>
            ))}
          </SettingsGroup>
          <SettingsGroup title={t("language")}>
            {locales.map((locale, index) => (
              <View key={locale}>
                {index > 0 && <Divider />}
                <ChoiceRow
                  testID={`locale-${locale}`}
                  label={locale === "ru" ? "Русский" : "English"}
                  selected={value.locale === locale}
                  onPress={() => {
                    setLocale(locale);
                    set({ locale });
                  }}
                />
              </View>
            ))}
          </SettingsGroup>
        </>
      )}
    </SettingsScreen>
  );
}
