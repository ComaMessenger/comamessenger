import { useLocalSearchParams } from "expo-router";
import { ConversationView } from "@/conversation/ConversationView";
import { ScreenError } from "@/ui/ScreenError";

/** A render error shows a retry screen instead of closing the app. */
export { ScreenError as ErrorBoundary };

export default function ChatScreen() {
  const { chatId, message } = useLocalSearchParams<{
    chatId: string;
    message?: string;
  }>();
  return (
    <ConversationView
      key={`${chatId}:${message ?? ""}`}
      chatID={chatId}
      threadRootID={null}
      focusMessageID={message ?? null}
    />
  );
}
