import { Appearance, useColorScheme } from "react-native";
import type { UserPreferences } from "@comamessenger/core";
import { themes, type ThemeTokens } from "@comamessenger/tokens";

/**
 * The account's theme (shared with the web): light or dark override the
 * phone's setting for this app, system follows it.
 */
export function applyThemePreference(theme: UserPreferences["theme"] | null) {
  Appearance.setColorScheme(
    theme === "light" || theme === "dark" ? theme : "unspecified",
  );
}

export function useTheme(): ThemeTokens {
  return themes[useColorScheme() === "dark" ? "dark" : "light"];
}
