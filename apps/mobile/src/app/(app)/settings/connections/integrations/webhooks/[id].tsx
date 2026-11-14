import { useLocalSearchParams } from "expo-router";
import { WebhookScreen } from "@/connections/WebhookScreens";

export { RouteError as ErrorBoundary } from "@/ui/RouteError";

export default function Route() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return <WebhookScreen id={id} />;
}
