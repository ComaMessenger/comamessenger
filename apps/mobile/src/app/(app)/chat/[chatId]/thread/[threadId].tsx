import { useLocalSearchParams } from "expo-router";
import { ConversationView } from "@/conversation/ConversationView";

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
