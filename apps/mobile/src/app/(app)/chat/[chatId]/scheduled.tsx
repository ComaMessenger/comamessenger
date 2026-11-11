import { useLocalSearchParams } from "expo-router";
import { ScheduledScreen } from "@/scheduled/ScheduledScreen";

/** Scheduled messages of one chat, opened from the strip under its header. */
export default function ChatScheduledScreen() {
  const { chatId } = useLocalSearchParams<{ chatId: string }>();
  return <ScheduledScreen chatID={chatId} />;
}
