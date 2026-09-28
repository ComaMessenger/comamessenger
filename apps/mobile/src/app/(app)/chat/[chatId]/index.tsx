import { useLocalSearchParams } from "expo-router";
import { ConversationView } from "@/conversation/ConversationView";

export default function ChatScreen() {
  const { chatId } = useLocalSearchParams<{ chatId: string }>();
  return <ConversationView key={chatId} chatID={chatId} threadRootID={null} />;
}
