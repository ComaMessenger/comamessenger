import { useLocalSearchParams } from "expo-router";
import { NewAgentScreen } from "@/agents/builder/CreateAgentScreen";

export { RouteError as ErrorBoundary } from "@/ui/RouteError";

/** A draft from a catalog role, or `custom` for one built by hand. */
export default function Route() {
  const { recipeId } = useLocalSearchParams<{ recipeId: string }>();
  return <NewAgentScreen recipeID={recipeId} />;
}
