import { AgentsHome } from "@/agents/AgentsHome";
import { ScreenError } from "@/ui/ScreenError";

/** A render error shows a retry screen instead of closing the app. */
export { ScreenError as ErrorBoundary };

export default function AgentsTab() {
  return <AgentsHome />;
}
