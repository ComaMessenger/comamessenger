import type {
  Agent,
  AgentLlmConnection,
  Chat,
  MessengerAPI,
} from "@comamessenger/core";
import { Badge, FormError } from "../../ui";
import { AgentConfiguration } from "../behavior/AgentConfiguration";
import { AgentKnowledgePlaceholder } from "../knowledge/AgentKnowledgePlaceholder";
import { AgentLifecycle } from "../lifecycle/AgentLifecycle";
import { AgentOperations } from "../operations/AgentOperations";
import type { AgentDetailSection } from "../routes";
import { AgentSandbox } from "../sandbox/AgentSandbox";
import type { AgentAccess } from "../shared/access";
import { draftOf } from "../shared/draft";
import { AgentDetailNav } from "./AgentDetailNav";
import { AgentEditorToolbar } from "./AgentEditorToolbar";
import { AgentReadiness } from "./AgentReadiness";
import { DeleteAgentDialog } from "./DeleteAgentDialog";
import { ResetRecipeDialog } from "./ResetRecipeDialog";
import type { AgentEditorState } from "./useAgentEditor";

/** Agent card: toolbar, section navigation and the active section. */
export function AgentEditor({
  api,
  selected,
  section: detailSection,
  access,
  editor,
  chats,
  connections,
  refetchAgents,
  navigate,
}: {
  api: MessengerAPI;
  selected: Agent | undefined;
  section: AgentDetailSection;
  access: AgentAccess;
  editor: AgentEditorState;
  chats: Chat[];
  connections: AgentLlmConnection[];
  refetchAgents(): Promise<unknown>;
  navigate(to: string): void;
}) {
  const { canBuild, canPublish, canObserve } = access;
  return (
    <div className="agent-editor">
      <AgentEditorToolbar
        selected={selected}
        section={detailSection}
        canBuild={canBuild}
        editor={editor}
      />
      {selected && (
        <AgentDetailNav
          agent={selected}
          section={detailSection}
          access={access}
          navigate={navigate}
        />
      )}
      <FormError message={editor.error} />
      {editor.notice && <Badge tone="success">{editor.notice}</Badge>}
      {selected && <AgentReadiness agent={selected} />}
      {canBuild && selected && detailSection === "behavior" && (
        <AgentConfiguration
          draft={editor.draft}
          chats={chats}
          connections={connections}
          onChange={editor.setDraft}
        />
      )}
      {canBuild && selected && detailSection === "test" && (
        <AgentSandbox api={api} agents={[selected]} chats={chats} />
      )}
      {canBuild && selected && detailSection === "knowledge" && (
        <AgentKnowledgePlaceholder />
      )}
      {selected && detailSection === "overview" && (
        <AgentLifecycle
          api={api}
          agent={selected}
          canPublish={canPublish}
          onChanged={async (updated) => {
            editor.setDraft(draftOf(updated));
            await refetchAgents();
          }}
        />
      )}
      {selected &&
        ["overview", "automations", "activity", "settings"].includes(
          detailSection,
        ) &&
        (detailSection !== "settings" || canBuild) &&
        (detailSection !== "automations" || canBuild || canObserve) &&
        (detailSection !== "activity" || canObserve) && (
          <AgentOperations
            api={api}
            agent={selected}
            canBuild={canBuild}
            section={
              detailSection as
                | "overview"
                | "automations"
                | "activity"
                | "settings"
            }
            onChanged={() => void refetchAgents()}
          />
        )}
      {selected && detailSection === "settings" && editor.deleteOpen && (
        <DeleteAgentDialog agent={selected} editor={editor} />
      )}
      {selected && detailSection === "settings" && editor.resetOpen && (
        <ResetRecipeDialog agent={selected} editor={editor} />
      )}
    </div>
  );
}
