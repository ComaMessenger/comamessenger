import { useLocalSearchParams } from "expo-router";
import { TaskScreen } from "@/tasks/TaskScreen";

export { RouteError as ErrorBoundary } from "@/ui/RouteError";

/** A task of the chat: the card, its fields and checklist for those who may. */
export default function Route() {
  const { chatId, messageId } = useLocalSearchParams<{
    chatId: string;
    messageId: string;
  }>();
  return <TaskScreen chatID={chatId} messageID={messageId} />;
}
