import { useLocalSearchParams } from "expo-router";
import { ChatTasksScreen } from "@/tasks/ChatTasksScreen";

export { RouteError as ErrorBoundary } from "@/ui/RouteError";

/** «Все задачи чата», opened from the list under the slot. */
export default function Route() {
  const { chatId } = useLocalSearchParams<{ chatId: string }>();
  return <ChatTasksScreen chatID={chatId} />;
}
