import { useLocalSearchParams } from "expo-router";
import { ScheduledScreen } from "@/scheduled/ScheduledScreen";

/**
 * Scheduled messages of one chat, opened from the strip under its header or
 * from a scheduled bubble in the feed (`?focus=<id>` brings that one up).
 */
export default function ChatScheduledScreen() {
  const { chatId, focus } = useLocalSearchParams<{
    chatId: string;
    focus?: string;
  }>();
  return <ScheduledScreen chatID={chatId} focusID={focus ?? null} />;
}
