import { useLocalSearchParams } from "expo-router";
import { ArchitectScreen } from "@/agents/architect/ArchitectScreen";

export { RouteError as ErrorBoundary } from "@/ui/RouteError";

/** «Изменить через Архитектора» from the builder of an agent. */
export default function Route() {
  const { agentId } = useLocalSearchParams<{ agentId: string }>();
  return <ArchitectScreen agentID={agentId} />;
}
