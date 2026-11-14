import { useLocalSearchParams } from "expo-router";
import { SourceScreen } from "@/knowledge/SourceScreen";

export { RouteError as ErrorBoundary } from "@/ui/RouteError";

export default function Route() {
  const { document } = useLocalSearchParams<{ document: string }>();
  return <SourceScreen documentID={document} />;
}
