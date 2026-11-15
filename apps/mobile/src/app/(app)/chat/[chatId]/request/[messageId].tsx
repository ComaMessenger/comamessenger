import { useLocalSearchParams } from "expo-router";
import { RequestAnswersScreen } from "@/requests/RequestAnswersScreen";

export { RouteError as ErrorBoundary } from "@/ui/RouteError";

/** «Ответы» of a request: who answered what (author and chat admins). */
export default function Route() {
  const { chatId, messageId } = useLocalSearchParams<{
    chatId: string;
    messageId: string;
  }>();
  return <RequestAnswersScreen chatID={chatId} messageID={messageId} />;
}
