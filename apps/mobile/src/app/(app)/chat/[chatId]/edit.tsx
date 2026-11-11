import { useLocalSearchParams } from "expo-router";
import { EditChatScreen } from "@/chatinfo/EditChatScreen";

export { RouteError as ErrorBoundary } from "@/ui/RouteError";

export default function Route() {
  const { chatId } = useLocalSearchParams<{ chatId: string }>();
  return <EditChatScreen chatID={chatId} />;
}
