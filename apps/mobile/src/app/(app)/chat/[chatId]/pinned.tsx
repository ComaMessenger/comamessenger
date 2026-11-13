import { useLocalSearchParams } from "expo-router";
import { PinnedScreen } from "@/chatinfo/PinnedScreen";

export { RouteError as ErrorBoundary } from "@/ui/RouteError";

export default function Route() {
  const { chatId } = useLocalSearchParams<{ chatId: string }>();
  return <PinnedScreen chatID={chatId} />;
}
