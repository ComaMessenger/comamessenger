import { useLocalSearchParams } from "expo-router";
import { ConversationView } from "@/conversation/ConversationView";

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
