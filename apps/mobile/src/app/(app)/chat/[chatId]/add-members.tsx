import { useLocalSearchParams } from "expo-router";
import { AddMembersScreen } from "@/chatinfo/AddMembersScreen";

export { RouteError as ErrorBoundary } from "@/ui/RouteError";

export default function Route() {
  const { chatId } = useLocalSearchParams<{ chatId: string }>();
  return <AddMembersScreen chatID={chatId} />;
}
