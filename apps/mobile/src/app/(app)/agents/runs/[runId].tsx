import { useLocalSearchParams } from "expo-router";
import { RunScreen } from "@/agents/RunScreen";

export { RouteError as ErrorBoundary } from "@/ui/RouteError";

export default function RunRoute() {
  const { runId } = useLocalSearchParams<{ runId: string }>();
  return <RunScreen key={runId} runID={runId} />;
}
