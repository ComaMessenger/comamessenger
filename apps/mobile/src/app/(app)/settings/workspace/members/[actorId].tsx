import { useLocalSearchParams } from "expo-router";
import { MemberScreen } from "@/settings/MembersScreens";

export { RouteError as ErrorBoundary } from "@/ui/RouteError";

export default function Route() {
  const { actorId } = useLocalSearchParams<{ actorId: string }>();
  return <MemberScreen actorID={actorId} />;
}
