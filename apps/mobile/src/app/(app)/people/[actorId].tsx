import { useLocalSearchParams } from "expo-router";
import { PersonScreen } from "@/people/PersonScreen";

export { RouteError as ErrorBoundary } from "@/ui/RouteError";

export default function PersonRoute() {
  const { actorId } = useLocalSearchParams<{ actorId: string }>();
  return <PersonScreen key={actorId} actorID={actorId} />;
}
