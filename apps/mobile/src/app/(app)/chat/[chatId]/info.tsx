import { useLocalSearchParams } from "expo-router";
import { ChatInfoScreen } from "@/chatinfo/ChatInfoScreen";

export { RouteError as ErrorBoundary } from "@/ui/RouteError";

export default function Route() {
  const { chatId } = useLocalSearchParams<{ chatId: string }>();
  return <ChatInfoScreen chatID={chatId} />;
}
