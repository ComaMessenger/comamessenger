import { ArchitectScreen } from "@/agents/architect/ArchitectScreen";

export { RouteError as ErrorBoundary } from "@/ui/RouteError";

/** A new agent from a conversation with the Architect. */
export default function Route() {
  return <ArchitectScreen agentID={null} />;
}
