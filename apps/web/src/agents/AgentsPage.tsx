import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { MessengerAPI, User } from "@comamessenger/core";
import { Skeleton } from "../ui";
import { SettingsAccessDenied } from "../settings/components/SettingsPrimitives";
import { AgentActivityDirectory } from "./activity/AgentActivityDirectory";
import { AgentPlatformHeader } from "./AgentPlatformHeader";
import type { AgentTemplate as Template } from "./agentTemplates";
import { AgentApprovals } from "./approvals/AgentApprovals";
import { AgentCatalog } from "./catalog/AgentCatalog";
import { AgentConnectionsPage } from "./connections/AgentConnectionsPage";
import { AgentEditor } from "./detail/AgentEditor";
import { useAgentEditor } from "./detail/useAgentEditor";
import { agentRoute, type AgentDetailSection } from "./routes";
import { agentAccess } from "./shared/access";
import { AgentCreationWizard } from "./wizard/AgentCreationWizard";

/** Agent platform shell: `/agents/*` routing, shared queries, creation wizard. */
export function AgentsPage({
  api,
  user,
  path,
  navigate,
}: {
  api: MessengerAPI;
  user: User;
  path: string;
  navigate(to: string): void;
}) {
  const access = agentAccess(user);
  const { canBuild, allowed } = access;
  const route = agentRoute(path);
  const globalTab = route.kind === "global" ? route.section : null;
  const detailSection: AgentDetailSection =
    route.kind === "agent" ? route.section : "overview";
  const agents = useQuery({
    queryKey: ["agents"],
    queryFn: () => api.agents(),
    enabled: allowed,
  });
  const chats = useQuery({
    queryKey: ["agent-chats"],
    queryFn: () => api.chats(),
    enabled: allowed,
  });
  const connections = useQuery({
    queryKey: ["agent-llm-connections"],
    queryFn: () => api.agentLlmConnections(),
    enabled: allowed,
  });
  const selectedID = route.kind === "agent" ? route.agentID : null;
  const selected = agents.data?.find((agent) => agent.id === selectedID);
  const editor = useAgentEditor({
    api,
    selected,
    refetchAgents: agents.refetch,
    navigate,
  });
  const [wizardTemplate, setWizardTemplate] = useState<Template | null>(null);

  function chooseTemplate(value: Template) {
    setWizardTemplate(value);
    editor.setError("");
  }

  return (
    <section className="agent-platform">
      <AgentPlatformHeader
        globalTab={globalTab}
        access={access}
        navigate={navigate}
      />
      <div className="agent-platform__content">
        {!allowed ? (
          <SettingsAccessDenied />
        ) : agents.isLoading || chats.isLoading ? (
          <Skeleton />
        ) : globalTab === "connections" ? (
          <AgentConnectionsPage api={api} canManage={access.canIntegrate} />
        ) : globalTab === "approvals" ? (
          <AgentApprovals api={api} agents={agents.data ?? []} />
        ) : globalTab === "activity" ? (
          <AgentActivityDirectory
            api={api}
            agents={agents.data ?? []}
            navigate={navigate}
          />
        ) : (
          <div className="agent-settings">
            <AgentCatalog
              agents={agents.data ?? []}
              selectedID={selectedID}
              canBuild={canBuild}
              onChooseTemplate={chooseTemplate}
              navigate={navigate}
            />
            <AgentEditor
              api={api}
              selected={selected}
              section={detailSection}
              access={access}
              editor={editor}
              chats={chats.data ?? []}
              connections={connections.data ?? []}
              refetchAgents={agents.refetch}
              navigate={navigate}
            />
          </div>
        )}
      </div>
      {canBuild && wizardTemplate && (
        <AgentCreationWizard
          api={api}
          template={wizardTemplate}
          chats={chats.data ?? []}
          connections={connections.data ?? []}
          onClose={() => setWizardTemplate(null)}
          onCreated={async (created) => {
            setWizardTemplate(null);
            await agents.refetch();
            navigate(`/agents/${created.id}/test`);
          }}
        />
      )}
    </section>
  );
}
