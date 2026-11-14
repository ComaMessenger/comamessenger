import { useLocalSearchParams } from "expo-router";
import { CollectionScreen } from "@/knowledge/CollectionScreen";

export { RouteError as ErrorBoundary } from "@/ui/RouteError";

export default function Route() {
  const { collection } = useLocalSearchParams<{ collection: string }>();
  return <CollectionScreen key={collection} collectionID={collection} />;
}
