import { useLocalSearchParams } from "expo-router";
import { AgentScreen } from "@/agents/AgentScreen";

export { RouteError as ErrorBoundary } from "@/ui/RouteError";

export default function AgentRoute() {
  const { agentId } = useLocalSearchParams<{ agentId: string }>();
  return <AgentScreen key={agentId} agentID={agentId} />;
}
