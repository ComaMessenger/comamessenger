import { Cable, Sparkles } from "lucide-react-native";
import { connectionsAccess, type User } from "@comamessenger/core";
import type { SettingsLink } from "@/settings/sections";
import "./strings";

/**
 * «Модели» and «Интеграции» rows of the workspace section, by the server's
 * own rules: hidden when the person could not even list them.
 */
export function connectionLinks(user: User): SettingsLink[] {
  const access = connectionsAccess(user);
  const links: SettingsLink[] = [];
  if (access.viewModels)
    links.push({
      id: "connections-models",
      href: "/settings/connections/models",
      labelKey: "connModels",
      hintKey: "connModelsHint",
      icon: Sparkles,
    });
  if (access.viewIntegrations)
    links.push({
      id: "connections-integrations",
      href: "/settings/connections/integrations",
      labelKey: "connIntegrations",
      hintKey: "connIntegrationsHint",
      icon: Cable,
    });
  return links;
}
