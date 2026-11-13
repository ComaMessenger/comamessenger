import { useLocalSearchParams } from "expo-router";
import { FilesScreen } from "@/chatinfo/FilesScreen";

export { RouteError as ErrorBoundary } from "@/ui/RouteError";

export default function Route() {
  const { chatId } = useLocalSearchParams<{ chatId: string }>();
  return <FilesScreen chatID={chatId} />;
}
