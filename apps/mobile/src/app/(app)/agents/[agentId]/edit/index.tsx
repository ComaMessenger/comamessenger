import { BuilderHub } from "@/agents/builder/BuilderHub";

export { RouteError as ErrorBoundary } from "@/ui/RouteError";

export default function Route() {
  return <BuilderHub />;
}
