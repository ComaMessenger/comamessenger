import { useLocalSearchParams } from "expo-router";
import { McpScreen } from "@/connections/McpScreens";

export { RouteError as ErrorBoundary } from "@/ui/RouteError";

export default function Route() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return <McpScreen id={id} />;
}
