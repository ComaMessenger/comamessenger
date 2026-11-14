import { connectionLinks } from "@/connections/links";
import { useSignedIn } from "@/session/SessionProvider";
import { SettingsHome } from "@/settings/SettingsHome";

export { RouteError as ErrorBoundary } from "@/ui/RouteError";

export default function Route() {
  const { user } = useSignedIn();
  return <SettingsHome workspaceExtra={connectionLinks(user)} />;
}
