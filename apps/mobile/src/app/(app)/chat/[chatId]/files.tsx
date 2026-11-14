import { useLocalSearchParams } from "expo-router";
import { SharedScreen, isSharedTab } from "@/chatinfo/SharedScreen";

export { RouteError as ErrorBoundary } from "@/ui/RouteError";

/** Media, files, voice and links of a chat; `tab` picks the first tab. */
export default function Route() {
  const { chatId, tab } = useLocalSearchParams<{
    chatId: string;
    tab?: string;
  }>();
  return (
    <SharedScreen
      chatID={chatId}
      initialTab={isSharedTab(tab) ? tab : "files"}
    />
  );
}
