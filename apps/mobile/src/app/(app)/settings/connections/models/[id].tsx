import { useLocalSearchParams } from "expo-router";
import { ModelScreen } from "@/connections/ModelScreens";

export { RouteError as ErrorBoundary } from "@/ui/RouteError";

export default function Route() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return <ModelScreen id={id} />;
}
