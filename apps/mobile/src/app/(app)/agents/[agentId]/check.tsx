import { useLocalSearchParams } from "expo-router";
import { CheckScreen } from "@/agents/CheckScreen";

export { RouteError as ErrorBoundary } from "@/ui/RouteError";

export default function CheckRoute() {
  const { agentId } = useLocalSearchParams<{ agentId: string }>();
  return <CheckScreen key={agentId} agentID={agentId} />;
}
