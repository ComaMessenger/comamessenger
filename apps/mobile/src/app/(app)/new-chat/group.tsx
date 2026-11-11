import { useLocalSearchParams } from "expo-router";
import { NewGroupScreen } from "@/newchat/NewGroupScreen";

export { RouteError as ErrorBoundary } from "@/ui/RouteError";

export default function NewGroupRoute() {
  const { kind } = useLocalSearchParams<{ kind?: string }>();
  return (
    <NewGroupScreen initialKind={kind === "channel" ? "channel" : "group"} />
  );
}
