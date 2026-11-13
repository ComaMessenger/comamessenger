import { useLocalSearchParams } from "expo-router";
import { ConversationView } from "@/conversation/ConversationView";
import { ScreenError } from "@/ui/ScreenError";

/** A render error shows a retry screen instead of closing the app. */
export { ScreenError as ErrorBoundary };

export default function ThreadScreen() {
  const { chatId, threadId } = useLocalSearchParams<{
    chatId: string;
    threadId: string;
  }>();
  return (
    <ConversationView
      key={`${chatId}:${threadId}`}
      chatID={chatId}
      threadRootID={threadId}
    />
  );
}
