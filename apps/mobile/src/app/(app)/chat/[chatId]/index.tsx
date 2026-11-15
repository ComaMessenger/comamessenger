import { useLocalSearchParams } from "expo-router";
import { ConversationView } from "@/conversation/ConversationView";
import { ScreenError } from "@/ui/ScreenError";

/** A render error shows a retry screen instead of closing the app. */
export { ScreenError as ErrorBoundary };

export default function ChatScreen() {
  const { chatId, message, reminder } = useLocalSearchParams<{
    chatId: string;
    message?: string;
    /** Opened from a fired «Напомнить мне»: the strip with «Готово». */
    reminder?: string;
  }>();
  return (
    <ConversationView
      key={`${chatId}:${message ?? ""}:${reminder ?? ""}`}
      chatID={chatId}
      threadRootID={null}
      focusMessageID={message ?? null}
      reminderID={message ? (reminder ?? null) : null}
    />
  );
}
