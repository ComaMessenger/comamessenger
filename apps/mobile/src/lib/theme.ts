import { useColorScheme } from "react-native";
import { themes, type ThemeTokens } from "@comamessenger/tokens";

export function useTheme(): ThemeTokens {
  return themes[useColorScheme() === "dark" ? "dark" : "light"];
}
