import { useLocalSearchParams } from "expo-router";
import { ActivityScreen } from "@/agents/ActivityScreen";

export { RouteError as ErrorBoundary } from "@/ui/RouteError";

export default function ActivityRoute() {
  const { agent } = useLocalSearchParams<{ agent?: string }>();
  return <ActivityScreen key={agent ?? ""} initialAgentID={agent ?? ""} />;
}
