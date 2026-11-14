import { useLocalSearchParams } from "expo-router";
import { knowledgeFocusFrom } from "@comamessenger/core";
import { DocumentScreen } from "@/knowledge/DocumentScreen";

export { RouteError as ErrorBoundary } from "@/ui/RouteError";

/**
 * `/knowledge/:collection/:document?fragment=&position=&q=&quote=` — the
 * same path and focus as on the web, so search results and agent sources
 * open the fragment they point at.
 */
export default function Route() {
  const params = useLocalSearchParams<{
    collection: string;
    document: string;
    fragment?: string;
    position?: string;
    q?: string;
    quote?: string;
  }>();
  const focus = knowledgeFocusFrom(
    (name) => params[name as keyof typeof params],
  );
  return (
    <DocumentScreen
      key={params.document}
      collectionID={params.collection}
      documentID={params.document}
      focus={focus}
    />
  );
}
